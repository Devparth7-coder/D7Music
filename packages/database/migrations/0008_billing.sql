-- ============================================================
-- 0008 — billing/subscription audit trail.
--
-- D7 ships with PAYMENT_PROVIDER=manual (no gateway credentials in this build),
-- but the schema is gateway-agnostic on purpose: plan changes are written to an
-- append-only event log, and inbound webhooks are deduped by provider event id so
-- a replayed delivery can never double-apply a subscription change.
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_events (
  id          uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('upgraded','downgraded','renewed','canceled','reactivated','past_due','refunded','manual_grant')),
  tier        text CHECK (tier IN ('free','premium')),
  provider    text NOT NULL DEFAULT 'manual',
  reference   text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_events_user_idx ON subscription_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id             uuid PRIMARY KEY DEFAULT d7_uuid(),
  provider       text NOT NULL,
  external_id    text NOT NULL,
  type           text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error          text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  CONSTRAINT webhook_events_provider_external_uniq UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON webhook_events (received_at DESC);

-- One row per checkout attempt the platform created (manual provider records the intent
-- and the operator marks it paid; a gateway writes the same row from its webhook).
CREATE TABLE IF NOT EXISTS checkout_intents (
  id            uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier          text NOT NULL CHECK (tier IN ('free','premium')),
  provider      text NOT NULL DEFAULT 'manual',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','canceled','expired')),
  reference     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkout_intents_user_idx ON checkout_intents (user_id, created_at DESC);

DROP TRIGGER IF EXISTS d7_touch_updated_at ON checkout_intents;
CREATE TRIGGER d7_touch_updated_at BEFORE UPDATE ON checkout_intents
  FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();
