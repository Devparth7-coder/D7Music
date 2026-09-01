/**
 * Credential primitives (spec §18).
 *
 * - Passwords: bcrypt with a configurable cost factor. Plaintext is never stored or logged.
 * - Tokens (email verification / password reset / stream signatures): only a SHA-256
 *   digest is stored, so a database leak cannot be replayed against the mail flow.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '@d7/config';

export async function hashPassword(plain: string): Promise<string> {
  assertPasswordShape(plain);
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

/** Runs a dummy hash when the user is unknown so login time does not leak existence. */
const DUMMY_HASH = bcrypt.hashSync('d7-timing-equalizer-000000', 10);

export async function verifyPassword(plain: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, storedHash);
}

export function assertPasswordShape(plain: string) {
  if (typeof plain !== 'string' || plain.length < 8) throw new Error('Password must be at least 8 characters.');
  if (plain.length > 200) throw new Error('Password is unreasonably long.');
}

export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function tokensEqual(a: string, b: string) {
  const bufA = Buffer.from(hashToken(a));
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Password strength hint used by both signup UI and the API. */
export function passwordScore(plain: string) {
  let score = 0;
  if (plain.length >= 8) score += 1;
  if (plain.length >= 12) score += 1;
  if (/[a-z]/.test(plain) && /[A-Z]/.test(plain)) score += 1;
  if (/\d/.test(plain)) score += 1;
  if (/[^A-Za-z0-9]/.test(plain)) score += 1;
  const common = ['password', '12345678', 'qwerty', 'letmein', 'welcome'];
  if (common.some((c) => plain.toLowerCase().includes(c))) score = Math.min(score, 2);
  return { score, ok: score >= 2 };
}
