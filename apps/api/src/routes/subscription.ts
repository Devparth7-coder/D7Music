/**
 * Plans, checkout and webhooks (spec §19).
 *
 * `PAYMENT_PROVIDER=manual` is the only driver bundled: "upgrade" flips the tier and writes
 * an audit row, and the UI says so instead of pretending money moved. The webhook route is
 * real, though — signature verification, replay protection via `webhook_events`, and the same
 * `changeTier()` a gateway would call — so pointing D7music at Stripe means setting two env
 * vars, not rewriting this file.
 */
import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PLANS, env, planFor } from '@d7/config';
import { changeTier, getSubscription, setCancelAtPeriodEnd } from '@d7/database';
import { ApiError, parseBody } from '../lib/http.js';

export default async function subscriptionRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  app.get('/api/subscriptions/plans', async () => ({
    provider: env.PAYMENT_PROVIDER,
    billingNote:
      env.PAYMENT_PROVIDER === 'manual'
        ? 'No payment gateway is configured: upgrading changes your tier immediately and records an audit entry.'
        : `Charges are handled by ${env.PAYMENT_PROVIDER}.`,
    plans: PLANS,
  }));

  app.get('/api/subscriptions/me', async (request) => {
    const user = await request.requireUser();
    const subscription = await getSubscription(db(), user.id);
    const events = await db().query<Record<string, any>>(
      `SELECT type, tier, provider, reference, created_at::text
         FROM subscription_events WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 10`,
      [user.id],
    );
    return {
      subscription,
      plan: planFor(subscription?.tier ?? 'free'),
      plans: PLANS,
      history: events.map((e) => ({ type: e.type, tier: e.tier, provider: e.provider, reference: e.reference ?? null, createdAt: e.created_at })),
    };
  });

  /** Manual checkout: creates a pending intent row and, for `manual`, settles it immediately. */
  app.post('/api/subscriptions/checkout', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(
      z.object({
        tier: z.enum(['free', 'premium']).default('premium'),
        months: z.number().int().min(1).max(24).optional(),
        reference: z.string().max(120).optional(),
      }),
      request.body ?? {},
    );
    const intent = await db().queryOne<{ id: string }>(
      `INSERT INTO checkout_intents (id, user_id, tier, provider, status, reference, created_at, updated_at)
       VALUES (d7_uuid(), $1::uuid, $2, $3, $4, $5, now(), now()) RETURNING id`,
      [user.id, body.tier, env.PAYMENT_PROVIDER, env.PAYMENT_PROVIDER === 'manual' ? 'paid' : 'pending', body.reference ?? null],
    );
    if (env.PAYMENT_PROVIDER !== 'manual') {
      throw new ApiError(501, 'GATEWAY_NOT_WIRED', `${env.PAYMENT_PROVIDER} is selected but no gateway adapter is bundled. Set PAYMENT_PROVIDER=manual or implement services/payments/${env.PAYMENT_PROVIDER}.ts.`);
    }
    const subscription = await changeTier(db(), user.id, body.tier, {
      provider: 'manual',
      months: body.months ?? 12,
      reference: `checkout:${intent!.id}`,
    });
    const refreshed = await (await import('../plugins/session.js')).buildCurrentUser(db(), user.id);
    app.d7.log.info('plan changed', { userId: user.id, tier: body.tier, checkoutId: intent!.id });
    return { subscription, plan: planFor(body.tier), user: refreshed, checkoutId: intent!.id };
  });

  app.post('/api/subscriptions/cancel', async (request) => {
    const user = await request.requireUser();
    const subscription = await setCancelAtPeriodEnd(db(), user.id, true);
    await db().execute(
      `INSERT INTO subscription_events (id, user_id, type, tier, provider, created_at) VALUES (d7_uuid(), $1::uuid, 'canceled', $2, $3, now())`,
      [user.id, subscription?.tier ?? 'free', subscription?.provider ?? 'manual'],
    );
    return { subscription, note: 'Cancellation takes effect at the end of the current period.' };
  });

  app.post('/api/subscriptions/resume', async (request) => {
    const user = await request.requireUser();
    const subscription = await setCancelAtPeriodEnd(db(), user.id, false);
    return { subscription };
  });

  /**
   * Gateway webhook. Order matters: verify signature → record the event (replay guard) →
   * apply. A replayed delivery therefore cannot apply a plan change twice.
   */
  app.post('/api/webhooks/:provider', async (request, reply) => {
    const provider = String((request.params as { provider: string }).provider).toLowerCase();
    const raw = (request as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const externalId = String(payload.id ?? (payload as { request?: { id?: string } }).request?.id ?? '');
    // `manual` exists so a dev can move a test account to Premium without a gateway. It does not
    // authenticate anything, so it must not be reachable on a production box.
    if (provider === 'manual' && env.isProd) {
      throw new ApiError(501, 'WEBHOOK_NOT_CONFIGURED', 'The "manual" webhook is a development shortcut and is disabled when NODE_ENV=production.');
    }
    if (provider === 'stripe' && !env.STRIPE_WEBHOOK_SECRET) {
      throw new ApiError(501, 'WEBHOOK_NOT_CONFIGURED', 'STRIPE_WEBHOOK_SECRET is not set, so deliveries cannot be verified.');
    }
    if (provider === 'stripe') {
      if (!verifyStripeSignature(raw, String(request.headers['stripe-signature'] ?? ''), env.STRIPE_WEBHOOK_SECRET)) {
        throw new ApiError(400, 'BAD_SIGNATURE', 'The webhook signature does not match this payload.');
      }
    } else if (provider !== 'manual') {
      throw new ApiError(501, 'WEBHOOK_UNKNOWN_PROVIDER', `No webhook handler for provider "${provider}".`);
    }
    if (!externalId) throw ApiError.badRequest('Webhook payload has no event id.', [{ path: 'id', message: 'Required for replay protection' }]);

    const recorded = await db().queryOne<{ id: string }>(
      `INSERT INTO webhook_events (id, provider, external_id, type, payload, status, received_at)
       VALUES (d7_uuid(), $1, $2, $3, $4::jsonb, 'received', now())
       ON CONFLICT (provider, external_id) DO NOTHING
       RETURNING id`,
      [provider, externalId, String(payload.type ?? 'unknown'), JSON.stringify(redact(payload))],
    );
    if (!recorded) {
      return reply.code(200).send({ ok: true, note: 'Already processed — nothing re-applied.' });
    }
    try {
      const applied = await applyGatewayEvent(db(), provider, payload);
      await db().execute(`UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1::uuid`, [recorded.id]);
      return { ok: true, applied };
    } catch (err) {
      await db().execute(`UPDATE webhook_events SET status = 'failed', error = $2, processed_at = now() WHERE id = $1::uuid`, [recorded.id, (err as Error).message.slice(0, 400)]);
      throw err;
    }
  });
}

async function applyGatewayEvent(db: import('@d7/database').Db, provider: string, payload: Record<string, unknown>) {
  const type = String(payload.type ?? '');
  const data = (payload.data as { object?: Record<string, unknown> })?.object ?? {};
  const userId = String(data.client_reference_id ?? data.user_id ?? '');
  if (!userId) return { ignored: true, reason: 'no user reference on the event' };
  if (type.includes('subscription.created') || type.includes('subscription.renewed') || type === 'grant') {
    const tier = String(data.tier ?? data.plan ?? 'premium') === 'free' ? 'free' : 'premium';
    await changeTier(db, userId, tier, { provider, reference: String(payload.id ?? ''), months: 1 });
    return { applied: true, tier };
  }
  if (type.includes('subscription.deleted') || type.includes('subscription.canceled')) {
    await changeTier(db, userId, 'free', { provider, reference: String(payload.id ?? '') });
    return { applied: true, tier: 'free' };
  }
  return { ignored: true, reason: `unhandled event type "${type}"` };
}

/** Stripe-style `t=…,v1=…` HMAC over `t.payload`, tolerating a missing header. */
export function verifyStripeSignature(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length === 2) as [string, string][],
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

function redact(payload: Record<string, unknown>) {
  // Card/PII fields must not land in our audit table.
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const obj = (clone.data as { object?: Record<string, unknown> })?.object;
  if (obj) {
    delete obj.payment_intent_last_payment_error;
    if (obj.customer_details && typeof obj.customer_details === 'object') {
      const cd = obj.customer_details as Record<string, unknown>;
      delete cd.email;
      delete cd.phone;
      delete cd.address;
    }
  }
  return clone;
}
