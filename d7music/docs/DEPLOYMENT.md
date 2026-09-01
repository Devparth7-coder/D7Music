# Deploying D7music

Everything needed to take this repository from `git clone` to a running instance: which processes
exist, what they require, how to configure them, and what to check before you call it live.

**Status of this build.** The API, the queue worker, the two one-shot jobs, the database layer and
the audio-storage layer are implemented and covered by `npm test` (56 tests: 41 API
integration tests against a real PostgreSQL, plus 15 for the serverless bridge in `tests/vercel.test.ts`). `apps/web` currently contains only `package.json` — the Next.js front end is not
built yet, so today you deploy the API tier and point anything that speaks HTTP at it. Sections that
depend on the web tier say so explicitly. Nothing here is aspirational: if a file does not exist yet
you will see "pending" next to it.

- Full variable reference: [ENVIRONMENT.md](ENVIRONMENT.md) · provider wiring: [PROVIDERS.md](PROVIDERS.md)
- Day-2 running: [OPERATIONS.md](OPERATIONS.md)
- Serverless target (Vercel functions + Vercel Cron, and what that platform cannot host):
  [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md)

---

## 1. The processes

| Process | Command | Default bind | Notes |
| --- | --- | --- | --- |
| API | `npm start -w @d7/api` → `node --import tsx apps/api/src/main.ts` | `API_HOST:API_PORT` = `0.0.0.0:4000` | Stateless HTTP. Serves `/api/*`, `/media/*`, `/cdn/*`. |
| Queue + sync worker | `npm run worker` | — | Drains the job queue every 10 s and runs the release-sync scheduler. Split out so a slow provider can never hold a user request. |
| Release sync (one-shot) | `npm run sync:releases [-- --provider x --days 30 --max 100 --index-only]` | — | Same code path the scheduler uses. Cron this if you prefer timers to a long-lived worker. |
| Recommendations (one-shot) | `npm run recommendations:update` | — | Rebuilds per-user rows + related artists. |
| Migrations | `npm run db:migrate` | — | Also run automatically by every process at boot — see §4.3. |
| Web | `npm run dev -w @d7/web` / `next build && next start` | `0.0.0.0:3000` | **pending** — no source in `apps/web` yet. |

Relative data paths (`PGLITE_DIR`, `STORAGE_LOCAL_DIR`, `MAIL_OUTBOX_DIR`) are resolved against the
**repo root** — the directory holding the `.env` that was loaded, else the nearest
`package-lock.json` — not against the process cwd. `@d7/config` exports `resolveDataPath()` for this:
without it, `npm run db:seed` (cwd = repo root) and `npm run dev -w @d7/api` (cwd = `apps/api`) each
get their own `.data/pglite` cluster, which is how "the seed clearly worked but the app has no
catalog" happens. Same for `.env` itself: config searches upward for the nearest one, so a workspace
script does not silently start with defaults.

There is **no build step for the API tier**. Workspace packages export their TypeScript sources
(`"exports": { ".": "./src/index.ts" }`) and `tsx` transpiles on load, so the container runs exactly
the files the test suite ran. That makes `tsx` a *runtime* dependency: it is in
`dependencies`, not `devDependencies`, so `npm ci --omit=dev` still boots.

Only the API listens on a socket. Everything else is either a cron invocation or a process you keep
alive with systemd/Docker and give no port at all.

### 1.1 Requirements

| | Minimum | Recommended |
| --- | --- | --- |
| Node.js | 20.9 (`engines`) | **22 LTS.** `cookie@2` (pulled in by `@fastify/cookie`) declares `>=22` and npm prints an `EBADENGINE` warning on 20.x; it works, but 22 silences it and is what to run in prod. |
| PostgreSQL | any server you can reach | Match what the schema was developed against: **18.3** (the engine inside PGlite 0.5.8). Older servers have not been exercised here — migrate a copy first. |
| Redis | not required | 7.x, once you want a *shared* cache, cross-process locks, or BullMQ. |
| Object storage | local disk | Any S3-compatible bucket. `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` are declared **optionalDependencies** and installed by default. |
| CPU/RAM (API) | — | 1 vCPU / 512 MB per node is fine; bcrypt at `BCRYPT_ROUNDS=11` is the only CPU-heavy request path. |
| ffmpeg / sox | not needed | Audio analysis is pure JS (`parseWavHeader`, `analyzePcm`). Uploads are analysed for peak/loudness/clipping/silence without a native tool. |

---

## 2. Fastest path: one box, no Docker

```bash
git clone <repo> d7music && cd d7music
npm ci --omit=dev                      # runtime deps only; tsx is one of them
cp .env.example .env                   # then edit — see the block below
npm run db:migrate
npm run db:seed                        # DEV ONLY — see §2.2
```

**If your npm blocks install scripts** (npm 11 with `allow-scripts`, or `--ignore-scripts`), it will
print `1 package has install scripts not yet covered by allowScripts` naming `esbuild`. That is
informational here, and the two scripted packages in this tree are both safe to skip: `esbuild`'s
`install.js` only chmods and version-checks a binary that already ships as the `@esbuild/linux-x64`
*optional* dependency, and `msgpackr-extract` (under `bullmq`, which is only constructed when
`REDIS_URL` is set) builds an accelerator that `msgpackr` runs without. Verified by installing
`esbuild@0.28.2` with `--ignore-scripts` and transpiling TypeScript through it, and by running
`npx tsx` — the runtime every `npm run` entry in this section uses.

Two cases where you *do* need to approve the script: `npm ci --omit=optional`, or a lockfile installed
on a different platform than the one running it (the postinstall's fallback download is how esbuild
self-heals when its optional package is absent). Then `npm approve-scripts esbuild`, or point
`ESBUILD_BINARY_PATH` at a working binary. The failure mode is loud rather than silent: `require`
succeeds and the first call throws `The package "@esbuild/linux-x64" could not be found, and is needed
by esbuild.` — verified, and verified to be repaired by `ESBUILD_BINARY_PATH` alone.

### 2.1 `.env` for a real deployment

The smallest set that produces a working, honest production instance (full explanations in
[ENVIRONMENT.md](ENVIRONMENT.md)):

```ini
NODE_ENV=production
LOG_LEVEL=info

APP_SECRET=<32+ random chars: openssl rand -hex 32>
API_HOST=0.0.0.0
API_PORT=4000
API_PUBLIC_URL=https://api.example.com
WEB_ORIGIN=https://d7.example.com
TRUST_PROXY=true          # nginx fronts us; see §6 for why this pair matters

DB_DRIVER=postgres
DATABASE_URL=postgres://d7:***@db.internal:5432/d7music?sslmode=require
DB_POOL_MAX=10

STORAGE_DRIVER=s3
S3_BUCKET=d7-audio
S3_REGION=auto
S3_ENDPOINT=https://<your-s3-compatible-host>
S3_FORCE_PATH_STYLE=true
STORAGE_PUBLIC_BASE_URL=      # set only if a CDN serves public objects

MUSIC_PROVIDER=local_library  # or json_http with a licensed partner (docs/PROVIDERS.md)
RELEASE_SYNC_ENABLED=false    # the worker process sets this true; see §11
```

Generate the secret, do not invent one: `openssl rand -hex 32`. Everything omitted keeps its
documented default — and `npm run docs:check` guarantees those defaults are still documented.

### 2.2 Two things you must not do on a production box

- **`npm run db:seed`** inserts a synthetic catalog, 55 generated WAV files and *two known-credential
  accounts* (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`). It is for local dev and demos only.
- **`DB_DRIVER=pglite`** is refused at boot in production, deliberately: an embedded single-writer
  cluster is not a datastore for a service with several processes.

### 2.3 systemd

Units live in [`../deploy/systemd`](../deploy/systemd): `d7music-api.service`,
`d7music-worker.service`, and two timers for the one-shot jobs. Install with:

```bash
sudo cp deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now d7music-api d7music-worker d7music-release-sync.timer d7music-recommendations.timer
systemctl status --no-pager d7music-api
```

They assume a `d7music` system user, `/srv/d7music`, and `EnvironmentFile=/etc/d7music/d7music.env`
(chmod `0640`, root:d7music) so the secret never lands in a unit file or in `docker inspect`-style
output.

---

## 3. Docker

[`../Dockerfile`](../Dockerfile) is a single image used for all four processes — only the command
differs. Build it once, tag it with the git SHA, and never rebuild per environment.

```bash
docker build -t d7music:$(git rev-parse --short HEAD) .
docker run --rm --env-file /etc/d7music/d7music.env \
  -p 4000:4000 -v d7-audio:/app/.data \
  d7music:$(git rev-parse --short HEAD) npm run db:migrate

docker run -d --name d7music-api --env-file /etc/d7music/d7music.env \
  -p 127.0.0.1:4000:4000 -v d7-audio:/app/.data \
  d7music:$(git rev-parse --short HEAD)
```

Notes that will bite you otherwise:

- The image runs as **uid 1001** and `WORKDIR /app`. With `STORAGE_DRIVER=local`, mount the
  `STORAGE_LOCAL_DIR` parent (`/app/.data`) as a writable volume; without a volume your uploads
  vanish on the next container and nothing warns you.
- `-p 127.0.0.1:4000:4000` on purpose: the API should be reachable only from your proxy.
- The `HEALTHCHECK` in the image polls `/api/health`, which reports *capability*, not just liveness:
  `docker exec d7music-api wget -qO- localhost:4000/api/health | head -c 400`.
- Compose ([`../docker-compose.yml`](../docker-compose.yml)) brings up Postgres + Redis + API +
  worker for local integration work, plus optional `minio` and `edge` profiles. It is **not** a
  production template: no secrets, no TLS, no backup story.

---

## 4. Database

### 4.1 Provisioning checklist

1. One role per app process (`LOGIN NOCREATEDB`), one database, `utf8` + `libc` collation from the
   provider (never `SQL_ASCII`).
2. TLS: `?sslmode=require` in `DATABASE_URL`. The pool sets
   `{ ssl: { rejectUnauthorized: false } }` when it sees that marker — it encrypts, it does not
   verify the chain. If you need pinning, set `sslmode=disable` and tunnel, or extend
   `packages/database/src/client.ts` (`createDb`) with your CA.
3. Sizing: `replicas × DB_POOL_MAX + workers × DB_POOL_MAX < max_connections − 10`.
4. `DB_STATEMENT_TIMEOUT_MS=15000` applies per query. If a backfill starts timing out, run the
   backfill through the CLI (which has its own connection) rather than raising the global timeout.

### 4.2 Extensions are optional by design

`pg_trgm`, `unaccent`, `fuzzystrmatch` are attempted with `CREATE EXTENSION IF NOT EXISTS` at the end
of every migration run, and a failure is reported, not fatal:

```
optional extensions unavailable (app runs without them): pg_trgm, unaccent, fuzzystrmatch
```

Search quality drops a little (the code falls back to its own Dice-bigram similarity over the
document set), nothing breaks. On managed tiers that forbid superuser extensions, ask for them in
`shared_preload_libraries`/`available_extensions` — or skip it. **No `citext`, `pgcrypto` or
`pg_trgm` is a hard dependency**, and that is deliberate.

### 4.3 Migrations

`packages/database/migrations/*.sql` apply in filename order, each inside its own transaction, and
`schema_migrations (name, checksum, applied_at, duration_ms)` records them. Two behaviours matter
operationally:

- **Re-running is a no-op** (verified: `migrations applied=0 skipped=10`), so boot-time migration is
  safe and a failed deploy retried is cheap.
- **Editing an applied file is fatal**, by design:
  `Migration 0007_social_ai.sql changed after being applied (ledger … vs file …)`. Add migration
  `0011_*.sql`; never rewrite history.
- **Migrations create the rows the app cannot function without**: `0012_builtin_provider_rows.sql`
  registers `local_library`, `licensed_http`, `musicbrainz` and `platform` in `music_providers`.
  Before that, a production database (migrated, never seeded) had an empty provider registry and the
  first catalogue import died on the `provider_albums_provider_fkey` FK. A fresh deploy needs
  `db:migrate` and nothing else — `db:seed` stays a demo tool.
- Every process calls `applyMigrations` at boot (`apps/api/src/context.ts`), *without* a cross-process
  advisory lock. During a rolling restart, two replicas can both try to insert the same ledger row.
  Consequence: a `duplicate key value violates unique constraint "schema_migrations_pkey"` in one
  replica's log while the other wins. **Run `npm run db:migrate` as an explicit release step before
  the fleet restarts** and the race disappears (it stays in the code as a safety net, not a plan).
- After a migration applies, `NOTIFY d7music, 'schema_changed'` is sent (best effort). Nothing
  listens today; the `cache` invalidation that matters is `catalog_version`, bumped by catalog
  writes.

### 4.4 Backups

[`../deploy/backup.sh`](../deploy/backup.sh) wraps `pg_dump -Fc` plus a tar of the local-storage
directory, keeps N daily + 30 in `latest/`, and verifies the archive is a readable dump before
pruning. Restore: [`../deploy/restore.sh`](../deploy/restore.sh). Schedules are in the systemd timers.
For anything user-facing also enable PITR/WAL archiving at the provider — a nightly dump is not a
recovery point.

---

## 5. Storage, media and uploads

| Path | What it is | Auth |
| --- | --- | --- |
| `GET /api/stream/:key` | Signed audio stream, supports `Range` (needed by players) | `sig` + `exp` query params, HMAC with `APP_SECRET`; a forged signature is a 403 |
| `GET /media/*` | Public objects (artwork, cover images) when `STORAGE_PUBLIC_BASE_URL` is empty | public |
| `GET /cdn/*` | Proxy to `STORAGE_PUBLIC_BASE_URL` for the same objects | public |
| `POST /api/creator/uploads` | Multipart audio/artwork upload | creator/admin session; `UPLOAD_MAX_MB` |

Rules that follow from this:

- **Audio bytes never go in Postgres.** The DB stores keys. Back the bucket (or `STORAGE_LOCAL_DIR`)
  up separately, or your schema restore yields a player with nothing to play.
- Signed URLs are valid for `STREAM_URL_TTL_SEC` (6 h). Anything that queues downloads for later must
  re-request the stream URL, not cache the old one.
- A CDN in front of `/api/stream/:key` must **forward `Range` and pass `206` responses through**, and
  must not serve one signed URL to another viewer (the signature is bound to the viewer).
- `UPLOAD_MAX_MB=60` is enforced twice in the app (multipart limits + route check) and once by you:
  the proxy's body-size limit must be at least as large, or uploads fail with `413` before the app
  sees them. `deploy/nginx.conf` sets `client_max_body_size 64m` to match.

---

## 6. TLS, proxy, CORS, CSRF

`deploy/nginx.conf` is a complete server block: TLS 1.2+, HSTS, `X-Forwarded-For`, `client_max_body_size`,
no buffering of the stream path, and `/api` + `/media` + `/cdn` routed to the API.

The pairs that must be set together:

| Set | Because |
| --- | --- |
| `TRUST_PROXY=true` **and** only-proxy-on-the-port | `request.ip` keys anonymous rate-limit buckets. Trusting `X-Forwarded-For` while clients can reach `:4000` directly lets them pick their own bucket. |
| `WEB_ORIGIN=https://d7.example.com` exactly | CORS allow-list and the CSRF `Origin` check on every mutating request compare full origins. A mismatch is not a warning: browsers get `403 CROSS_ORIGIN` and logins "fail" for no visible reason. |
| `API_PUBLIC_URL=https://api.example.com` | Stream URLs and OAuth `redirect_uri` are built from it. If it says `localhost:4000`, audio works on the deployment box and nowhere else. |
| HTTPS on both origins | The session cookie is `Secure` when `NODE_ENV=production`; over plain HTTP the browser never sends it and every user appears signed out. |
| Same site for both origins | The cookie is `SameSite=Lax`. Splitting the API onto a different *site* (not just subdomain) turns cross-site POSTs into unauthenticated ones — plan `d7.example.com` + `api.d7.example.com`, or expect a `SameSite=None` change in `apps/api/src/plugins/session.ts`. |

The API sets `x-content-type-options: nosniff` and `referrer-policy: no-referrer` on every response,
serves no HTML, and has no admin UI behind a different port — so `Content-Security-Policy` belongs to
the web tier, not here. Add `strict-transport-security` at the proxy (nginx file does).

---

## 7. The web tier (pending)

`apps/web` is a `package.json` only. When it lands, deploy it as a **separate** Next.js app
(`output: 'standalone'`, its own container), and remember:

- It needs no build-time API URL. The client bootstraps from `GET /api/config`, which returns
  `apiBaseUrl`, plans, moods, feature flags, provider descriptors and limits — no secrets, no internal
  hostnames. That is the contract, so a single web image can be promoted across environments.
- Requests must carry cookies (`credentials: 'include'`), and mutating requests must send a matching
  `Origin`.
- `features.oauth`, `features.assistantLlm`, `features.unlicensedStreaming` and `payments` in
  `/api/config` come from server env. Do not hard-code them in the front end or you will ship a button
  that 501s.

---

## 8. Mail

Password reset and address verification send through `apps/api/src/lib/mail.ts`, which — in this build —
**writes JSON files to `MAIL_OUTBOX_DIR` and returns `mode: 'outbox'`**. Setting `SMTP_URL` does not
start delivery: the app emits a process warning and still writes the file, so nothing is silently
dropped.

Two consequences for a real deploy:

1. Until you wire a transport (`nodemailer`, SES, Postmark — swap `deliver()`; nothing else reads
   mail), a user who requests a reset gets an email that goes nowhere. `POST /api/auth/password/forgot`
   returns `devToken` **only when `NODE_ENV !== 'production'`**, so you cannot even read the link from
   the API in production. Either wire the transport or turn the "Forgot password" flow off at the edge.
2. If you *do* keep the outbox as the delivery mechanism (some operators pipe that directory into a
   mail-sending agent), treat `MAIL_OUTBOX_DIR` as containing live credentials: a reset token is a
   session. It must not be world-readable, must not be in an object-storage bucket with a public ACL,
   and must be pruned (`find … -mtime +1 -delete`).

Links are built with `WEB_ORIGIN`, so a wrong `WEB_ORIGIN` produces emails whose links point at
localhost.

---

## 9. Payments

`PAYMENT_PROVIDER=manual` (the default) means **no real charging**: `/api/subscription/*` reports the
plan, and tiers move only through `/api/webhooks/manual`.

- `/api/webhooks/manual` exists for demos and tests. It is now refused with `501` when
  `NODE_ENV=production`, because it authenticates nothing — leaving it open would let anyone grant
  themselves Premium with a single POST. Verified below.
- With `PAYMENT_PROVIDER=stripe`, deliveries arrive at `POST /api/webhooks/stripe`: the raw body is
  kept for HMAC verification (`app.ts` installs a string JSON parser for exactly this), the event is
  recorded in `webhook_events` with `ON CONFLICT (provider, external_id) DO NOTHING` so a replayed
  delivery applies nothing twice, then `applyGatewayEvent` maps `subscription.created|renewed|grant`
  to a tier change.
- Without `STRIPE_WEBHOOK_SECRET` the endpoint answers `501 WEBHOOK_NOT_CONFIGURED` rather than
  accepting unverified events. That 501 is *expected behaviour* and appears in test logs by design.
- Plan definitions (prices, limits, feature strings) live in `PLANS` in `packages/config` — code, not
  rows, so entitlements cannot drift from a DB edit.

---

## 10. OAuth

`OAUTH_PROVIDERS=google,github,oidc` gates the two routes (`GET /api/auth/oauth/:provider` and
`.../callback`). A listed provider without credentials is a `501` with a message naming the exact
variables to set; an unlisted one is not offered at all (and not advertised in `/api/config`).

Register the redirect URI in the provider console as:

```
{API_PUBLIC_URL}/api/auth/oauth/<provider>/callback
```

- Google: `authorize=accounts.google.com/o/oauth2/v2/auth`, scopes `openid email profile`.
- GitHub: `github.com/login/oauth/authorize`, scopes `read:user user:email`.
- OIDC: `{OIDC_ISSUER}/authorize` and `/token` — a discovery-relative issuer works only if your IdP
  really serves those paths (Keycloak needs `/protocol/openid-connect/…`, so put the full path in
  `OIDC_ISSUER` or extend `oauthConfig`).
- `state` is compared against the `d7_oauth_state` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in
  production, 10 min). Clock skew is irrelevant; cookie loss (private browsing across the redirect) is
  the usual "expired or tampered" report.
- After a successful exchange the user lands on `{WEB_ORIGIN}/?signedin=1` (or
  `/onboarding?oauth=1` for a brand-new account).

---

## 11. Jobs, queues, and what is safe to run twice

| Component | Safe to run on N nodes? | Why |
| --- | --- | --- |
| API request handling | yes | stateless; cache is shared only if `REDIS_URL` is set (a memory cache is per-process, which costs hit-rate, never correctness) |
| Release-sync scheduler | **one** in practice | Each tick takes `cache.withLock('release-sync', …)` and then re-checks the provider cursor. With `REDIS_URL` that is a genuine cross-process lock (`SET NX` + compare-and-delete), so arming it on several nodes costs nothing; with the memory driver the lock is per-process, so arm exactly one. Recommended either way: `RELEASE_SYNC_ENABLED=false` on the API nodes. |
| Queue consumption (Postgres driver) | yes | jobs are claimed with `FOR UPDATE SKIP LOCKED`; failures retry with exponential backoff and land in `dead`, visible at `GET /api/admin/queue` |
| Queue consumption (BullMQ, `REDIS_URL` set) | yes | worker pools are the point |
| `/api/jobs/:job` (HTTP-triggered runs, e.g. Vercel Cron) | one at a time **per process** unless `REDIS_URL` is set | Same service methods as the worker and the CLI, each wrapped in `cache.withLock` — `release-sync` shares the scheduler's lock name, the rest use `job:<name>`. A contended call answers `200 {"skipped":"locked"}`. Requires `CRON_SECRET`; see [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md) §6. |
| `recommendations:update` | one at a time | recomputes rows; two runs waste CPU and thrash the same rows. `deploy/systemd/d7music-jobs.service` is `Type=oneshot`, and systemd will not start a unit that is still active, so this timer cannot overlap itself. |

Both the API and the worker arm the scheduler *and* drain the queue. That duplication is only a
problem if you run both with `RELEASE_SYNC_ENABLED=true`; the recommended topology is:

To avoid keeping a process alive at all, run `d7music-jobs.timer` instead of the worker. A CLI run
does not consult `sync_cursors.next_run_at`, so with the timer **the timer is the cadence** and
`RELEASE_SYNC_INTERVAL_MIN` only governs the worker's own scheduler — set both to the same rhythm.

```
API nodes (RELEASE_SYNC_ENABLED=false, queue still drains)  ×N
worker        (RELEASE_SYNC_ENABLED=true)                   ×1
```

`withLock` (cache layer) is what makes coalescing cross-process, and it is Redis-backed only. With the
memory driver, a lock protects one process, full stop — the health endpoint reports
`checks.cache.driver: "memory"` so you can see which regime you are in.

---

## 12. Security pre-flight

- [ ] `APP_SECRET` is `openssl rand -hex 32` output, not the default (boot would have refused anyway).
- [ ] `NODE_ENV=production`; `DB_DRIVER=postgres`; `DATABASE_URL` has `sslmode=require`.
- [ ] `db:seed` was never run against this database. Confirm:
      `select count(*) from users where email in ('admin@d7music.test','demo@d7music.test');` must be 0.
- [ ] `:4000` is not reachable from the public internet (only the proxy).
- [ ] `TRUST_PROXY` matches the real topology; `WEB_ORIGIN`/`API_PUBLIC_URL` are the exact public origins.
- [ ] `ALLOW_UNLICENSED_STREAM=false`, `REQUIRE_LICENSE_FOR_UPLOAD=true`.
- [ ] `RATE_LIMIT_DISABLED=false`.
- [ ] `/api/webhooks/manual` returns `501` (see §14, row "manual webhook answered").
- [ ] `PAYMENT_PROVIDER=manual` is *intended*, or `STRIPE_WEBHOOK_SECRET` is set and the Stripe
      dashboard shows this endpoint.
- [ ] `MAIL_OUTBOX_DIR` is either pruned/restricted or replaced by a wired transport.
- [ ] `POST /api/health` from an unauthenticated client: it exposes catalog counts, driver names and
  provider reasons. Public marketing sites should not proxy it; your monitoring should. If it must be
  reachable, restrict it at the proxy (`location = /api/health { allow 10.0.0.0/8; deny all; }`) and
  use `/api/version` for a dumb liveness ping instead.
- [ ] Admin role granted to as few users as possible: `select email from users where role='admin';`

---

## 13. Launch sequence (copy-paste)

```bash
# 1. install + config
npm ci --omit=dev && npm run docs:check && npm test

# 2. schema (explicit, so a fleet boot never races it)
npm run db:migrate

# 3. start the worker first, so the queue is being drained while the fleet rolls
systemctl start d7music-worker

# 4. API nodes, one at a time
systemctl restart d7music-api && sleep 5 \
  && curl -fsS https://api.example.com/api/health | python3 -m json.tool

# 5. arm the interesting parts only once they are configured
npm run sync:releases -- --max 20            # smoke-run the provider
npm run recommendations:update
```

Acceptance checks worth running against a fresh deploy (all are in the automated suite too):

```bash
curl -fsS localhost:4000/api/health | head -c 300        # 200, "status":"ok"
curl -s localhost:4000/api/health | grep -o '"tookMs":[0-9]*'
curl -si localhost:4000/api/tracks/00000000-0000-0000-0000-000000000000 | head -1   # 404, not 500
curl -s -XPOST localhost:4000/api/webhooks/manual -H 'content-type: application/json' \
     -d '{"id":"probe","type":"grant","data":{"object":{"user_id":"nobody"}}}'       # 501 in prod
```

---

## 14. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `FATAL: APP_SECRET must be set…` / `…pglite is not a production datastore` / `DATABASE_URL is required in production` | Boot guards, working as intended. §2.1. |
| `PGlite failed to initialize properly` | The dev cluster's *empty directories* did not survive a copy/restore (snapshots keep files, not dirs). `npm run db:reset && npm run db:seed`. The CLI now prints this hint too. |
| API answers, audio 403s | `APP_SECRET` rotated after the URL was issued, or a proxy stripped the `sig`/`exp` query params. Re-request the stream URL. |
| Users appear signed out immediately after login | Proxy terminating TLS without the app knowing (`secure` cookie + `http://`), or `WEB_ORIGIN` mismatch → `403 CROSS_ORIGIN` on POSTs. Check `d7-session` in DevTools → Application → Cookies. |
| `429` with `retry-after` | The documented per-60 s buckets (`RATE_LIMIT_*`). With the memory cache these are per process, so a fleet multiplies the effective limit — set `REDIS_URL` for honest global limits. |
| `/api/health` → `503 degraded` | `checks.database.ok` or `checks.storage.ok` is false. Storage usually means a read-only mount or an unwritable `STORAGE_LOCAL_DIR`. |
| `GET /api/health` reports `database.tracks: 0` on a box you just migrated | Expected. Migrations create the schema and the provider registry, not the catalog: content arrives via creator uploads, a provider sync, or `db:seed` (dev only). |
| Sync never runs | `RELEASE_SYNC_ENABLED=false` (set on API nodes and left false on the "worker" you forgot to start), or the provider cursor is in backoff: `GET /api/admin/sync-runs`, or `next_run_at` in the provider row. |
| Search returns nothing for a typo | Expected if `usedFuzzy` cannot propose candidates; check `/api/health` `metadataProviders` and that `rebuildSearchIndex` ran after a bulk import (`POST /api/admin/reindex`). |
| `multiple assignments to same column` / `could not determine data type of parameter $N` | Postgres rejects those; if a new query in a repo does, bind every parameter exactly once and give each placeholder one type. (This is how three 500s in this repo were found.) |
| `npm start` → `Cannot find package 'tsx'` | `--omit=dev` with an old lockfile. `tsx` is in `dependencies` now; re-run `npm install --package-lock-only`. |
| Node prints `EBADENGINE … cookie@2.0.1 … >=22` | Cosmetic on Node 20. Use Node 22 (§1.1). |
| Sync run is `partial`, one error per album, `null value in column "slug" …` | A provider payload arrived without `album_type`, and the slug trigger used to hash NULL into NULL. `upsertAlbum` defaults the type and migration `0011_null_safe_slugs.sql` makes the trigger NULL-safe; if an older image still shows this, the feed is really missing titles/durations and `validateTrackInput` rejecting it is correct behaviour. |
| A provider never appears in `GET /api/admin/providers`, or `provider_health` stays empty | The registry row for that name is missing: the `provider_*` mapping tables and `provider_health` have FKs to `music_providers(name)`, and an unregistered name is now *skipped* instead of failing the write (built-in names come from migration 0012). Add a row for a custom adapter if you want its health, cursor and rate limit tracked. |
| `npm test` passes but the running box behaves like an empty install | Compare `checks.database.label` in `/api/health` with the directory `npm run db:status` used. Two different databases, usually from running one command in a subdirectory on an older build (§1). |

---

## 15. What CI does

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs, in order: `npm ci`, `npm run
docs:check` (env contract vs docs), `npm run typecheck`, `npm test`, then `docker build` and a
`/api/health` smoke test of the built image. The test suite is the deploy gate: it boots the real
Fastify app over an ephemeral PostgreSQL and exercises auth, playlists, uploads/licensing, playback
telemetry, search, recommendations, the assistant and webhooks.
