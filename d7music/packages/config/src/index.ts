/**
 * @d7/config — single, validated read of the environment.
 *
 * Every integration in D7music is opt-in through env vars. Nothing in the app
 * hard-codes a third-party music service; `MUSIC_PROVIDER_*` and
 * `METADATA_PROVIDER_*` decide which provider adapters are constructed at boot.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * Walk up from the current directory for a dotfile.
 *
 * Every workspace script starts with a different cwd (`npm run dev -w @d7/api` runs in apps/api,
 * `npm run db:migrate` in the root), and dotenv resolves relative paths against cwd — so reading
 * only `./.env` means the same checkout behaves differently per script. The nearest file wins.
 */
function findUp(name: string): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const baseFile = findUp('.env');
dotenv.config(baseFile ? { path: baseFile, quiet: true } : { quiet: true });
const localFile = findUp('.env.local');
if (localFile) dotenv.config({ path: localFile, quiet: true, override: true });

/**
 * The repo root: the directory that holds the `.env` we loaded, else the nearest manifest above
 * the cwd. Relative *data* paths (PGlite cluster, local audio, mail outbox) are resolved against
 * this rather than the process cwd, so `npm run db:seed` (cwd = root) and `npm run dev -w @d7/api`
 * (cwd = apps/api) look at the same files instead of silently creating a second cluster.
 */
export const projectRoot: string =
  (baseFile ? dirname(baseFile) : undefined) ??
  (() => {
    let dir = process.cwd();
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(resolve(dir, 'package-lock.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  })();

/** Absolute paths pass through; `:memory:` (PGlite) is a marker, not a path. */
export function resolveDataPath(p: string): string {
  if (!p || p === ':memory:' || isAbsolute(p)) return p;
  return resolve(projectRoot, p);
}

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseFloat(v)))
    .pipe(z.number());

const list = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? []
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /* ---------------- API server ---------------- */
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: int(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY: bool(false),
  /**
   * Each process runs `applyMigrations` at boot (idempotent + checksum-guarded). On a platform
   * that scales cold starts without warning, flip this off and migrate in the build step instead,
   * so two replicas never race the `schema_migrations` ledger.
   */
  API_MIGRATE_AT_BOOT: bool(true),
  /** Secret used for session JWTs + signed stream URLs. Required in production. */
  APP_SECRET: z.string().default('d7-dev-secret-change-me-please-0123456789'),
  SESSION_TTL_DAYS: int(30),
  BCRYPT_ROUNDS: int(11),

  /* ---------------- Database ---------------- */
  /**
   * `postgres` -> uses DATABASE_URL with a real server (managed Postgres in prod).
   * `pglite`   -> embedded Postgres (real SQL engine, file-backed) for dev + tests.
   */
  DB_DRIVER: z.enum(['postgres', 'pglite']).default('postgres'),
  DATABASE_URL: z.string().default(''),
  PGLITE_DIR: z.string().default('.data/pglite'),
  DB_POOL_MAX: int(10),
  DB_STATEMENT_TIMEOUT_MS: int(15_000),

  /* ---------------- Cache / queue ---------------- */
  /** When absent, an in-process LRU cache + interval scheduler is used (dev mode). */
  REDIS_URL: z.string().default(''),
  CACHE_TTL_HOME_SEC: int(20),
  CACHE_TTL_CATALOG_SEC: int(240),
  QUEUE_NAMESPACE: z.string().default('d7music'),

  /* ---------------- Object storage / audio ---------------- */
  /** `local` streams from disk via the API; `s3` uses any S3-compatible endpoint. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('storage/audio'),
  STORAGE_PUBLIC_BASE_URL: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool(true),
  /** Signed URL lifetime for stream/GET requests. */
  STREAM_URL_TTL_SEC: int(60 * 60 * 6),
  /**
   * When a storage driver can presign a *third-party* URL, hand the client a 302 to it instead of
   * piping the bytes through this process. That is what a serverless deployment needs: a function
   * should not spend its whole duration streaming audio. The local driver signs URLs that point
   * back at us, so it is detected by origin and left as a proxy (no redirect loop).
   */
  STREAM_REDIRECT: bool(false),

  /* ---------------- Music (audio) provider ---------------- */
  /** Name of the *audio* provider to activate; `null` disables external audio. */
  MUSIC_PROVIDER: z.string().default('local_library'),
  MUSIC_PROVIDER_BASE_URL: z.string().default(''),
  MUSIC_PROVIDER_API_KEY: z.string().default(''),
  MUSIC_PROVIDER_TIMEOUT_MS: int(12_000),
  MUSIC_PROVIDER_RPS: num(2),
  MUSIC_PROVIDER_MAX_RETRIES: int(4),
  /** Field mapping for MUSIC_PROVIDER=json_http (see docs/PROVIDERS.md). */
  MUSIC_PROVIDER_MAP_JSON: z.string().default(''),
  MUSIC_PROVIDER_ENDPOINTS_JSON: z.string().default(''),
  /** Extra provider ids to seed the local library with (comma separated). */
  MUSIC_PROVIDER_SEED_IDS: list(),

  /* ---------------- Metadata / discovery providers ---------------- */
  METADATA_PROVIDERS: list(),
  MUSICBRAINZ_USER_AGENT: z.string().default('D7music/0.1 (contact@example.com)'),
  MUSICBRAINZ_BASE_URL: z.string().default('https://musicbrainz.org/ws/2'),

  /* ---------------- Release sync job ---------------- */
  RELEASE_SYNC_ENABLED: bool(true),
  RELEASE_SYNC_INTERVAL_MIN: int(360),
  RELEASE_SYNC_PAGE_SIZE: int(50),
  RELEASE_SYNC_LOOKBACK_DAYS: int(45),
  RELEASE_SYNC_MAX_ALBUMS_PER_RUN: int(150),

  /* ---------------- Scheduled jobs ---------------- */
  /**
   * Bearer token for `GET|POST /api/jobs/:job`, the entry point an external scheduler (Vercel Cron,
   * GitHub Actions, crontap) hits instead of a long-lived worker. Vercel sends
   * `Authorization: Bearer $CRON_SECRET` automatically when a secret by that name exists.
   * Empty = the endpoint answers 501; there is no unauthenticated way to trigger a job.
   */
  CRON_SECRET: z.string().default(''),

  /* ---------------- Recommendations ---------------- */
  RECAND_WINDOW_DAYS: int(60),
  RECAND_CANDIDATE_LIMIT: int(400),
  RECAND_WEIGHT_GENRE: num(1.0),
  RECAND_WEIGHT_ARTIST: num(1.6),
  RECAND_WEIGHT_FREQUENCY: num(1.2),
  RECAND_WEIGHT_RECENCY: num(0.9),
  RECAND_WEIGHT_POPULARITY: num(0.7),
  RECAND_WEIGHT_LIKES: num(1.4),
  RECAND_SKIP_PENALTY: num(1.1),
  RECOMMENDATION_UPDATE_INTERVAL_MIN: int(180),

  /* ---------------- AI assistant ---------------- */
  /**
   * When unset, the assistant runs the deterministic in-house NL→query parser.
   * When set, it calls an OpenAI-compatible chat endpoint and validates the
   * returned JSON against the AssistantQuery schema (catalog-guarded either way).
   */
  LLM_BASE_URL: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  LLM_TIMEOUT_MS: int(20_000),
  ASSISTANT_DAILY_LIMIT_FREE: int(10),
  ASSISTANT_DAILY_LIMIT_PREMIUM: int(500),

  /* ---------------- Auth / OAuth ---------------- */
  OAUTH_PROVIDERS: list(),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  OIDC_ISSUER: z.string().default(''),
  OIDC_CLIENT_ID: z.string().default(''),
  OIDC_CLIENT_SECRET: z.string().default(''),
  OAUTH_REDIRECT_BASE: z.string().default('http://localhost:3000'),

  /* ---------------- Mail (password reset / verification) ---------------- */
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('D7music <no-reply@d7music.local)'),
  /** Dev outbox directory; emails are written to disk when SMTP is unset. */
  MAIL_OUTBOX_DIR: z.string().default('.data/outbox'),

  /* ---------------- Payments ---------------- */
  /** `manual` = no real charging. Only enable a real driver with credentials. */
  PAYMENT_PROVIDER: z.string().default('manual'),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  /* ---------------- Rate limiting ---------------- */
  /** Disable only for tests or a single-user dev box; every limiter becomes a no-op. */
  RATE_LIMIT_DISABLED: bool(false),
  /** Fixed-window limits (per 60s unless noted) keyed by user id, or IP when anonymous. */
  RATE_LIMIT_AUTH: int(12),
  RATE_LIMIT_WRITE: int(90),
  RATE_LIMIT_SEARCH: int(150),
  RATE_LIMIT_PLAYBACK: int(600),
  RATE_LIMIT_ASSISTANT: int(40),
  /** Max upload size in MB for creator artwork/audio. */
  UPLOAD_MAX_MB: int(60),

  /* ---------------- Content safety ---------------- */
  ALLOW_UNLICENSED_STREAM: bool(false),
  REQUIRE_LICENSE_FOR_UPLOAD: bool(true),
  REPORT_REVIEW_URL: z.string().default(''),

  /* ---------------- Seed ---------------- */
  SEED_ADMIN_EMAIL: z.string().default('admin@d7music.test'),
  SEED_ADMIN_PASSWORD: z.string().default('D7admin!234'),
  SEED_DEMO_EMAIL: z.string().default('demo@d7music.test'),
  SEED_DEMO_PASSWORD: z.string().default('D7demo!2345'),
});

export type AppEnv = {
  [K in keyof z.infer<typeof envSchema>]: z.infer<typeof envSchema>[K];
} & { isProd: boolean; isTest: boolean; isDev: boolean; secretsAreDefault: boolean };

/**
 * An empty value means "not configured" everywhere in this app — `.env.example` relies on it
 * (`STORAGE_PUBLIC_BASE_URL=` = "the API serves media itself"). `process.env` can also legitimately
 * hold `''`, and zod's `.default()` only fires for `undefined`, so `APP_SECRET=` would otherwise be
 * accepted as a *real* (empty) secret. Collapse empty strings to undefined before parsing.
 */
function withoutEmptyStrings(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === '' || (typeof value === 'string' && value.trim() === '' && !key.startsWith('npm_'))) continue;
    out[key] = value;
  }
  return out;
}

function build(): AppEnv {
  const raw = envSchema.parse(withoutEmptyStrings(process.env));
  const isProd = raw.NODE_ENV === 'production';
  const env: AppEnv = {
    ...raw,
    isProd,
    isTest: raw.NODE_ENV === 'test',
    isDev: raw.NODE_ENV === 'development',
    secretsAreDefault: raw.APP_SECRET === 'd7-dev-secret-change-me-please-0123456789',
  };
  if (isProd && env.secretsAreDefault) {
    throw new Error('FATAL: APP_SECRET must be set to a high-entropy value in production.');
  }
  if (isProd && env.DB_DRIVER === 'pglite') {
    throw new Error('FATAL: DB_DRIVER=pglite is not a production datastore. Use postgres.');
  }
  if (isProd && !env.DATABASE_URL && env.DB_DRIVER === 'postgres') {
    throw new Error('FATAL: DATABASE_URL is required in production.');
  }
  return env;
}

export const env: AppEnv = build();

/** Plans are code-defined so entitlements can never drift from a DB row. */
export const PLANS = [
  {
    tier: 'free' as const,
    name: 'Free',
    priceCents: 0,
    currency: 'USD',
    interval: 'month' as const,
    features: [
      'Shuffled playback on most playlists',
      'Audio up to 128 kbps',
      'AI music assistant: 10 requests/day',
      'Ads between tracks (skippable)',
    ],
    limits: {
      ads: true,
      maxBitrateKbps: 128,
      offlineDownloads: 0,
      assistantRequestsPerDay: 10,
      lossless: false,
    },
  },
  {
    tier: 'premium' as const,
    name: 'Premium',
    priceCents: 1099,
    currency: 'USD',
    interval: 'month' as const,
    features: [
      'On-demand playback, no shuffle restriction',
      'Audio up to 320 kbps',
      'Offline downloads on mobile',
      'AI music assistant: unlimited',
      'Lyrics sync + immersive player',
    ],
    limits: {
      ads: false,
      maxBitrateKbps: 320,
      offlineDownloads: 100,
      assistantRequestsPerDay: 500,
      lossless: true,
    },
  },
];

export function planFor(tier: 'free' | 'premium') {
  return PLANS.find((p) => p.tier === tier) ?? PLANS[0]!;
}

/** Genre mood vocabulary shared by the assistant, seeds and shelf builders. */
export const MOODS: Record<string, { genres: string[]; energy: [number, number]; valence: [number, number] }> = {
  calm: { genres: ['ambient', 'lofi', 'neo-classical'], energy: [0, 0.35], valence: [0.2, 0.7] },
  focus: { genres: ['lofi', 'ambient', 'techno'], energy: [0.15, 0.5], valence: [0.2, 0.6] },
  sleep: { genres: ['ambient', 'neo-classical'], energy: [0, 0.2], valence: [0, 0.4] },
  energy: { genres: ['drum and bass', 'techno', 'hip hop'], energy: [0.75, 1], valence: [0.5, 1] },
  workout: { genres: ['techno', 'drum and bass', 'metal'], energy: [0.8, 1], valence: [0.4, 0.9] },
  happy: { genres: ['funk', 'synth-pop', 'indie pop'], energy: [0.5, 0.9], valence: [0.7, 1] },
  sad: { genres: ['neo-classical', 'indie folk', 'soul'], energy: [0, 0.4], valence: [0, 0.3] },
  romantic: { genres: ['soul', 'jazz', 'indie folk'], energy: [0.2, 0.55], valence: [0.4, 0.8] },
  night: { genres: ['synthwave', 'techno', 'lofi'], energy: [0.35, 0.8], valence: [0.2, 0.6] },
  party: { genres: ['funk', 'hip hop', 'synth-pop'], energy: [0.7, 1], valence: [0.7, 1] },
};

export const ACTIVITY_GENRES: Record<string, string[]> = {
  studying: ['lofi', 'ambient', 'neo-classical'],
  'late-night coding': ['lofi', 'synthwave', 'ambient'],
  coding: ['lofi', 'synthwave', 'ambient'],
  basketball: ['hip hop', 'drum and bass', 'techno'],
  running: ['techno', 'drum and bass'],
  driving: ['synth-pop', 'funk', 'indie rock'],
  cooking: ['soul', 'jazz', 'funk'],
  yoga: ['ambient', 'neo-classical'],
  gaming: ['drum and bass', 'techno', 'synthwave'],
  reading: ['neo-classical', 'ambient', 'jazz'],
  sleeping: ['ambient', 'lofi'],
  commuting: ['indie pop', 'synth-pop', 'lofi'],
  party: ['funk', 'hip hop', 'house'],
  relaxing: ['ambient', 'lofi', 'neo-classical'],
};
