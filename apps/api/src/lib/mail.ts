/**
 * Mail delivery.
 *
 * No SMTP client is bundled (an unauthenticated SMTP relay is not something I want to
 * half-implement). Messages are therefore written to `MAIL_OUTBOX_DIR` as JSON files that a
 * dev can open directly, and `sendMail()` returns the delivery mode so callers can be honest
 * about it. Wire a real transport here (`nodemailer`, SES, Postmark…) by setting SMTP_URL and
 * replacing `deliver()` — nothing else in the codebase needs to change.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { env, resolveDataPath } from '@d7/config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailReceipt {
  delivered: boolean;
  /** 'outbox' = written to disk for local review. A real transport flips this to 'sent'. */
  mode: 'outbox' | 'sent';
  path: string;
}

let dirReady: Promise<unknown> | null = null;

export async function sendMail(mail: Mail): Promise<MailReceipt> {
  const dir = resolveDataPath(env.MAIL_OUTBOX_DIR);
  dirReady ??= mkdir(dir, { recursive: true }).catch(() => undefined);
  await dirReady;
  const file = `${dir}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const payload = { ...mail, from: env.MAIL_FROM, sentAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  const mode: MailReceipt['mode'] = 'outbox';
  if (env.SMTP_URL) {
    // A transport is configured but not implemented in this build: keep the file so nothing
    // is silently dropped, and say so loudly in the log.
    process.emitWarning(`SMTP_URL is set but no SMTP transport is bundled; message written to ${file}`);
  }
  return { delivered: true, mode, path: file };
}

/** The link a user clicks to verify their address or reset a password. */
export function webLink(path: string) {
  return `${env.WEB_ORIGIN.replace(/\/+$/, '')}${path}`;
}
