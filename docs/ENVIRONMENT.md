# Environment reference

Every variable the app reads, with the **real default** (generated against `packages/config/src/index.ts`,
checked by `node scripts/check-env-docs.mjs`). `.env.example` carries the same list as copy-pasteable lines.

Production-only guards (`NODE_ENV=production`), all verified by booting with those values:

| Condition | Result |
| --- | --- |
| `APP_SECRET` still the built-in default | `FATAL: APP_SECRET must be set to a high-entropy value in production.` |
| `DB_DRIVER=pglite` | `FATAL: DB_DRIVER=pglite is not a production datastore. Use postgres.` |
| `DB_DRIVER=postgres` with empty `DATABASE_URL` | `FATAL: DATABASE_URL is required in production.` |
| any of the above fixed | boots |

Booleans accept `1/true/yes/on` (case-insensitive); integers and floats must parse or startup fails.
**An empty value means "unset"**: before parsing, `''` (and whitespace-only) is dropped so the schema
default applies — `APP_SECRET=` therefore fails the production guard instead of signing sessions with
an empty secret, and `STORAGE_PUBLIC_BASE_URL=` keeps its "the API serves media itself" meaning.
That rule is why `.env.example` allows no inline comments and why `@d7/config` searches upward for the
nearest `.env` (`packages/config/src/index.ts`, `findUp`).

## Runtime & logging

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | **set** | Selects the production guards below and turns the `devToken` leak in the password-reset reply off. Anything other than `production` is treated as development. |
| `LOG_LEVEL` | `info` | — | Levels are the pino vocabulary, emitted by the app's own line logger to stdout (stderr for `error`). `silent` quiets everything but fatal paths. |

## API server

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `API_HOST` | `0.0.0.0` | **set** | `0.0.0.0` is what a container needs; set `127.0.0.1` when a reverse proxy on the same box is the only client. The API never serves the web app, so it does not need a public bind in front of nginx. |
| `API_PORT` | `4000` | — | Also used to build two CORS/CSRF allow-list entries (`http://localhost:<port>`). |
| `API_PUBLIC_URL` | `http://localhost:4000` | **required** | Absolute origin of the API as seen by the browser. Used for signed stream URLs (`/api/stream/:key`), media URLs and OAuth redirect URIs. A trailing slash is stripped by the allow-list comparison but not by URL construction — write it without one. |
| `WEB_ORIGIN` | `http://localhost:3000` | **required** | Exact `Origin` of the front end. Compared literally by CORS and by the CSRF Origin check on every mutating request; in production an unmatched origin gets `403 CROSS_ORIGIN`, so a typo here logs users out rather than working by accident. |
| `TRUST_PROXY` | `false` | **set** | Passed to Fastify's `trustProxy`. Leave `false` unless every request passes through a proxy you operate: `request.ip` keys the anonymous rate-limit buckets, so trusting `X-Forwarded-For` when a client can reach the port directly hands out unlimited free buckets. |
| `API_MIGRATE_AT_BOOT` | `true` | **set** | The API runs `applyMigrations` when the process boots — idempotent and checksum-guarded, so it is safe on a restart. On a platform that spawns replicas without warning (Vercel), set it to `false` and migrate in the build step or from CI, so two cold starts never race the `schema_migrations` ledger. See [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).
| `APP_SECRET` | `d7-dev-secret-change-me-please-0123456789` | **required** | Signs session JWTs and stream URL signatures, and is the `@fastify/cookie` signing secret. Boot throws in production if it still equals the built-in default. Rotating it invalidates every session and every outstanding stream URL — do it in a maintenance window. |
| `SESSION_TTL_DAYS` | `30` | — | Session cookie `maxAge` and `auth_sessions.expires_at`. Revocation is authoritative in the DB row, so shortening this only affects new logins. |
| `BCRYPT_ROUNDS` | `11` | — | Cost for password hashing at signup/login. Raising it does not invalidate existing hashes. |

## Database

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `DB_DRIVER` | `postgres` | **required** | `postgres` for anything shared or durable; `pglite` is refused at boot in production (`FATAL: DB_DRIVER=pglite is not a production datastore`). |
| `DATABASE_URL` | `*(empty)*` | **required** | Connection string for the `pg` pool. `sslmode=require` in the string switches the pool to TLS with `rejectUnauthorized: false` (needed by most managed offers with rolling CA bundles); add your own CA pinning if that matters to you. |
| `PGLITE_DIR` | `.data/pglite` | dev only | Data directory for the embedded cluster. Files persist, empty directories do not — a snapshot-restored cluster that will not open is `npm run db:reset && npm run db:seed`. |
| `DB_POOL_MAX` | `10` | — | `pg.Pool.max` per process. Size it so `replicas × DB_POOL_MAX` stays under your Postgres `max_connections` minus superuser reserved slots. |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | — | Per-query `statement_timeout` on the pool. The recommendations/reindex paths run inside this budget; raise it for a big backfill instead of disabling it. |

## Cache, locks and the queue

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `REDIS_URL` | `*(empty)*` | **set** | Empty → in-process LRU cache and the Postgres job queue (`FOR UPDATE SKIP LOCKED`), which is a legitimate single-node production setup. Set it to share cached home shelves across nodes, to make `withLock` cross-process, and to switch the queue to BullMQ. |
| `QUEUE_NAMESPACE` | `d7music` | **set** | Prefix for every cache key and queue name. Two environments sharing one Redis must not share it. |
| `CACHE_TTL_HOME_SEC` | `20` | — | TTL of the composed home page. Every key also embeds `catalog_version`, so a catalog change invalidates immediately regardless of TTL. |
| `CACHE_TTL_CATALOG_SEC` | `240` | — | TTL for album/artist/track lookups. Same `catalog_version` guard. |

## Audio storage

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `STORAGE_DRIVER` | `local` | **set** | `local` = files on disk served by the API; `s3` = any S3-compatible bucket (needs the optional `@aws-sdk/client-s3`, already declared as an optionalDependency). |
| `STORAGE_LOCAL_DIR` | `storage/audio` | **set** | Where uploaded and synthesized audio lives. Put it on a volume you back up; the database stores only keys. |
| `STORAGE_PUBLIC_BASE_URL` | `*(empty)*` | — | Public base for *public* objects such as artwork. Streams stay signed even when this is set; leaving it empty makes the API serve `/media/*` itself. |
| `S3_ENDPOINT` | `*(empty)*` | — | Empty means real AWS S3. Set it for MinIO/R2/Wasabi/Backblaze and pair with `S3_FORCE_PATH_STYLE=true`. |
| `S3_BUCKET` | `*(empty)*` | **required** | Required with `STORAGE_DRIVER=s3` — the factory throws rather than writing audio somewhere surprising. |
| `S3_REGION` | `us-east-1` | — | Signature region; `us-east-1` works for most S3-compatible hosts. |
| `S3_ACCESS_KEY_ID` | `*(empty)*` | **set** | Leave both key and secret empty to use the instance profile / IRSA / workload identity chain. |
| `S3_SECRET_ACCESS_KEY` | `*(empty)*` | **set** | See above. |
| `S3_FORCE_PATH_STYLE` | `true` | **set** | `true` (default) for path-style `host/bucket/key`; `false` for virtual-hosted style, which is what AWS wants. |
| `STREAM_URL_TTL_SEC` | `21600` | **set** | Validity of a signed stream URL. Long enough for a download-manager backlog, short enough that a leaked URL expires; the signature is HMAC over key + expiry + viewer. |
| `STREAM_REDIRECT` | `false` | — | Ask the API to 302 the client to the storage provider's presigned URL instead of piping audio bytes through the process. It only pays off when that URL is on *another* origin: `resolveStreamDelivery` (`apps/api/src/routes/media.ts`) compares origins and keeps a proxy when they match, which is what the local driver produces (`/cdn/*`, `/api/stream/*` are our own routes). |

## Music (audio) provider

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `MUSIC_PROVIDER` | `local_library` | **set** | Which audio provider adapter to construct at boot. `local_library` needs no credentials; `json_http` needs base URL + key; `none` disables external audio entirely. Unknown names fall back to a disabled provider with a log line, they do not crash the boot. |
| `MUSIC_PROVIDER_BASE_URL` | `*(empty)*` | **set** | Root of the partner API (no trailing slash needed). |
| `MUSIC_PROVIDER_API_KEY` | `*(empty)*` | **set** | Sent as a bearer token by the `json_http` adapter. |
| `MUSIC_PROVIDER_TIMEOUT_MS` | `12000` | — | Per-request timeout; requests are also bounded by the caller's rate limit. |
| `MUSIC_PROVIDER_RPS` | `2` | — | Client-side token bucket. Keep it at or below the partner's documented limit — MusicBrainz bans above one request per second. |
| `MUSIC_PROVIDER_MAX_RETRIES` | `4` | — | Retries apply only to retryable failures (429, 5xx, network), with exponential backoff and `Retry-After` respected. |
| `MUSIC_PROVIDER_MAP_JSON` | `*(empty)*` | **set** | Field mapping for `json_http`; see docs/PROVIDERS.md. |
| `MUSIC_PROVIDER_ENDPOINTS_JSON` | `*(empty)*` | **set** | Endpoint overrides for `json_http`; see docs/PROVIDERS.md. |
| `MUSIC_PROVIDER_SEED_IDS` | `*(empty)*` | — | Comma separated provider album ids imported by the first sync run, useful for a cold-start catalog. |

## Metadata / discovery providers

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `METADATA_PROVIDERS` | `*(empty)*` | — | Comma separated list of metadata-only providers (e.g. `musicbrainz`). Metadata can never make unlicensed audio streamable — that invariant lives in the license check, not in this list. |
| `MUSICBRAINZ_USER_AGENT` | `D7music/0.1 (contact@example.com)` | **set** | MusicBrainz requires a contact address here and rate-limits anonymous agents. |
| `MUSICBRAINZ_BASE_URL` | `https://musicbrainz.org/ws/2` | — | Swap for a mirror if you self-host lookups. |

## Release sync job

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `RELEASE_SYNC_ENABLED` | `true` | **set** | Arms the in-process scheduler (in the API *and* in `npm run worker`). The provider cursor (`next_run_at`) plus a random 0–90 s jitter keep a fleet from stampeding, but it is best-effort: with more than one process alive, set this false everywhere except the dedicated worker. |
| `RELEASE_SYNC_INTERVAL_MIN` | `360` | — | Scheduler interval; the cursor's `next_run_at` is what actually gates a run. |
| `RELEASE_SYNC_PAGE_SIZE` | `50` | — | Pages fetched per provider per run. |
| `RELEASE_SYNC_LOOKBACK_DAYS` | `45` | — | How far back `new releases` queries reach. |
| `RELEASE_SYNC_MAX_ALBUMS_PER_RUN` | `150` | — | Hard cap on work per run; a run that hits it schedules the next one sooner rather than importing 10 000 albums on a Friday. |

## Scheduled jobs

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `CRON_SECRET` | `*(empty)*` | **set** | Bearer token accepted by `GET\|POST /api/jobs/:job`, the endpoint an external scheduler calls instead of a long-lived worker. **Empty means the endpoint answers `501 CRON_NOT_CONFIGURED`** — there is no unauthenticated way to trigger a job, and forgetting the secret is a closed door, not an open one. Vercel is documented to add `Authorization: Bearer $CRON_SECRET` to cron requests when the project has a secret with exactly that name — that naming is for the platform, not taste. Each run takes a `cache.withLock` lease, so a cron retry or an overlapping schedule returns `{"skipped":"locked"}` instead of a second sync. |

## Recommendations

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `RECAND_WINDOW_DAYS` | `60` | — | How much listening history counts as a signal. |
| `RECAND_CANDIDATE_LIMIT` | `400` | — | Pool size per user before scoring. |
| `RECAND_WEIGHT_ARTIST` | `1.6` | — | Weight of shared-artist signal. |
| `RECAND_WEIGHT_GENRE` | `1` | — | Weight of shared-genre signal. |
| `RECAND_WEIGHT_LIKES` | `1.4` | — | Weight of the like graph. |
| `RECAND_WEIGHT_FREQUENCY` | `1.2` | — | Weight of repeat plays (a strong, cheap signal). |
| `RECAND_WEIGHT_RECENCY` | `0.9` | — | Bias toward recent tracks. |
| `RECAND_WEIGHT_POPULARITY` | `0.7` | — | Global popularity prior — keep it low or everyone gets the same list. |
| `RECAND_SKIP_PENALTY` | `1.1` | — | Multiplier applied to signals from skipped tracks. |
| `RECOMMENDATION_UPDATE_INTERVAL_MIN` | `180` | — | Documented cadence for the `recommendations:update` timer. |

## AI assistant

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `LLM_BASE_URL` | `*(empty)*` | **set** | OpenAI-compatible base. Empty → the deterministic in-house parser answers every query (fully functional, no key required). |
| `LLM_API_KEY` | `*(empty)*` | **set** | Required together with `LLM_BASE_URL`; `/api/health` reports `assistant.engine` as `llm+rules` only when both are set. |
| `LLM_MODEL` | `gpt-4o-mini` | — | Model name passed through to the chat endpoint. |
| `LLM_TIMEOUT_MS` | `20000` | — | Assistant requests are counted against the per-user daily limit only after a successful parse. |
| `ASSISTANT_DAILY_LIMIT_FREE` | `10` | — | Requests/day for the `free` tier. |
| `ASSISTANT_DAILY_LIMIT_PREMIUM` | `500` | — | Requests/day for `premium`. |

## Auth

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `OAUTH_PROVIDERS` | `*(empty)*` | — | Comma separated enabled providers (`google,github,oidc`). Listed-but-unconfigured providers answer `501 OAUTH_NOT_CONFIGURED`, and `/api/config` only advertises the ones that are both listed and credentialed. |
| `GOOGLE_CLIENT_ID` | `*(empty)*` | **set** | Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | `*(empty)*` | **set** | Google OAuth client secret. |
| `GITHUB_CLIENT_ID` | `*(empty)*` | **set** | GitHub OAuth client id. |
| `GITHUB_CLIENT_SECRET` | `*(empty)*` | **set** | GitHub OAuth client secret. |
| `OIDC_ISSUER` | `*(empty)*` | **set** | Discovery base; `/authorize` and `/token` are appended to it. |
| `OIDC_CLIENT_ID` | `*(empty)*` | **set** | OIDC client id. |
| `OIDC_CLIENT_SECRET` | `*(empty)*` | **set** | OIDC client secret. |
| `OAUTH_REDIRECT_BASE` | `http://localhost:3000` | **set** | Front-end origin used for post-login redirects (`/?signedin=1`, `/onboarding?oauth=1`). |

## Mail

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `SMTP_URL` | `*(empty)*` | **set** | Parsed and advertised, but no SMTP transport is bundled in this build: with it set, messages still land in `MAIL_OUTBOX_DIR` and a process warning says so, so nothing is silently dropped. Wire a real transport in `apps/api/src/lib/mail.ts`. |
| `MAIL_FROM` | `D7music <no-reply@d7music.local)` | — | From line on every outgoing message. |
| `MAIL_OUTBOX_DIR` | `.data/outbox` | **set** | Directory the JSON messages are written to. Must be writable by the service user and, in production, either on a volume you watch or replaced by a transport — password-reset links go here. |

## Payments

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `PAYMENT_PROVIDER` | `manual` | **set** | `manual` = no real charging: upgrades go through `/api/webhooks/manual`, which is dev/test-gated. `/api/webhooks/:provider` verifies signatures for the configured provider. |
| `STRIPE_SECRET_KEY` | `*(empty)*` | — | Needed before `PAYMENT_PROVIDER=stripe` can do anything. |
| `STRIPE_WEBHOOK_SECRET` | `*(empty)*` | — | Without it `/api/webhooks/stripe` refuses with `501` by design — a webhook you cannot verify is a way to grant yourself Premium. |

## Rate limits

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `RATE_LIMIT_DISABLED` | `false` | dev only | Turns every limiter into a no-op. Tests and a single-user dev box only. |
| `RATE_LIMIT_AUTH` | `12` | — | Per 60 s, keyed by user id or IP, for login/register/reset traffic. |
| `RATE_LIMIT_WRITE` | `90` | — | Per 60 s for mutating calls (playlists, likes, uploads). |
| `RATE_LIMIT_SEARCH` | `150` | — | Per 60 s. |
| `RATE_LIMIT_PLAYBACK` | `600` | — | Per 60 s — heartbeat/telemetry is chatty by nature. |
| `RATE_LIMIT_ASSISTANT` | `40` | — | Per 60 s, on top of the per-tier daily quota. |
| `UPLOAD_MAX_MB` | `60` | **set** | Creator upload cap, applied to both `@fastify/multipart` limits and the route's own check. Nginx's `client_max_body_size` must be at least this big or uploads fail before the app sees them. |

## Content safety

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `ALLOW_UNLICENSED_STREAM` | `false` | — | If a track has no license record, streaming is refused. Setting this true is a legal decision, not a debugging toggle. |
| `REQUIRE_LICENSE_FOR_UPLOAD` | `true` | **set** | Creator uploads without a license row stay unpublished when true. |
| `REPORT_REVIEW_URL` | `*(empty)*` | — | Appeal link shown to the reporter/creator. Empty = no link. |

## Seed (never against production)

| Variable | Default | Prod | Meaning |
| --- | --- | --- | --- |
| `SEED_ADMIN_EMAIL` | `admin@d7music.test` | dev only | Login of the seeded admin. |
| `SEED_ADMIN_PASSWORD` | `D7admin!234` | dev only | Password of the seeded admin. |
| `SEED_DEMO_EMAIL` | `demo@d7music.test` | dev only | Login of the seeded demo listener. |
| `SEED_DEMO_PASSWORD` | `D7demo!2345` | dev only | Password of the seeded demo listener. |
