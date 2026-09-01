/**
 * Prints the parsed environment (every key `@d7/config` exposes) as JSON on stdout.
 *
 * Used by scripts/check-env-docs.mjs so documentation is compared against what the schema
 * actually produces, not against a second copy of the defaults that could rot.
 *
 * Run it from a directory that has no `.env` (cwd is where dotenv looks), e.g.:
 *   cd /tmp && ../home/user/d7music/node_modules/.bin/tsx scripts/env-snapshot.mts
 */
import { env } from '@d7/config';

const synthetic = new Set(['isProd', 'isTest', 'isDev', 'secretsAreDefault']);
const out: Record<string, unknown> = {};
for (const key of Object.keys(env).sort()) {
  if (synthetic.has(key)) continue;
  out[key] = env[key as keyof typeof env];
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
