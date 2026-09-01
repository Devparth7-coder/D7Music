# Deploying the API on Vercel

The **API tier only**, as Vercel Serverless Functions, with **Vercel Cron** running the scheduled
jobs. There is no front end in this repository (`apps/web` holds a manifest and nothing else), so
"deploy on Vercel" means: one Node function that answers every route, an external Postgres, an
external bucket, and cron endpoints in place of the worker.

Everything below was checked against this repository. Where something can only be checked by
actually deploying, §10 lists it as unverified instead of asserting it.

## 1. What this target does and does not do

| Capability | On Vercel | Why |
| --- | --- | --- |
| JSON API (`/api/*`), auth, sessions, search, home, playlists | works | Stateless request/response is exactly the function model. |
| Scheduled jobs (release sync, recommendations, trending, reindex, queue drain) | works, via Vercel Cron → `GET /api/jobs/<name>` | §6. No long-lived process exists, so the scheduler becomes the caller. |
| Streaming audio to clients | works **only** with `STORAGE_DRIVER=s3` + `STREAM_REDIRECT=true` | The function must 302 to a presigned URL; piping bytes burns the duration budget. |
| Album-art / waveform `/media/*` | works, cached | Small objects, and `vercel.json` gives them a year of `immutable`. |
| Uploading audio through the API | **does not work** | `POST /api/creator/tracks` buffers the multipart body in memory and `UPLOAD_MAX_MB` defaults to 60; Vercel's function body ceiling is far below that (4.5 MB at time of writing). Uploads need a compute target that can hold a request, or a direct-to-bucket flow this app does not implement. |
| `STORAGE_DRIVER=local`, `MAIL_OUTBOX_DIR`, any file write | **does not work** | The function filesystem is read-only except `/tmp`. |
| The in-process scheduler / queue pump (`RELEASE_SYNC_ENABLED`) | **not armed here, by construction** | `createContext({ headless: true })` — the serverless entry never starts the `setInterval` loops. |
| `DB_DRIVER=pglite` | refused at boot in production, and useless anyway | An isolate has no durable disk; the local cluster would be empty on the next request. |
| Redis-backed cache locks and BullMQ | works if you bring Redis | §9 explains the interaction — turning Redis on also moves the queue to BullMQ, where `drain()` is a deliberate no-op. |

## 2. How the single function is mounted

```
vercel.json  rewrites: /(.*)  ──►  api/index.ts  ──►  apps/api/src/vercel.ts
                                                        resolveRequestPath(req) → req.url
                                                        app.routing(req, res)
```

* `api/index.ts` is a one-function re-export of `apps/api/src/vercel.ts`. Vercel builds one function
  from it because `api/**` at the project root *is* the function directory.
* The bridge calls `app.routing()` — the same request listener `app.listen()` would have handed to
  `http.createServer`. `app.inject()` bypasses it, which is why `tests/vercel.test.ts` boots a real
  `http.createServer(handler)` and fetches over a socket instead.
* One app per warm isolate (`getServer()` memoises `buildServer(...)`). A failed boot clears the
  latch so the next invocation retries rather than being poisoned forever.
* `createHandler` only forwards paths under `/api`, `/media` or `/cdn`. Anything else gets
  `404 ROUTE_NOT_MOUNTED` **with the path candidates it considered** in the body — a mis-mounted
  deploy is otherwise indistinguishable from a broken router.
* Path fidelity is the one thing a rewrite-to-one-function runtime is inconsistent about, so
  `resolveRequestPath` tries, in order: `req.url`, `x-matched-path`, `x-original-url`,
  `x-invoke-path`, then `?__d7path=`. The `/api/index` mount itself is deliberately *not* trusted
  as a route. If a deploy ever answers `ROUTE_NOT_MOUNTED`, change the destination to
  `"/api/index?__d7path=/$1"` and the last fallback carries the path; the marker is stripped before
  Fastify sees the query.

## 3. What has to live somewhere else

| Need | Reasonable choice | Notes |
| --- | --- | --- |
| Postgres | Neon / Supabase / RDS, reachable over TLS | Use the **pooled** endpoint. `DB_POOL_MAX=1` per function; `pg.Pool` already sets `idleTimeoutMillis: 30000` and `connectionTimeoutMillis: 10000`. `DATABASE_URL` must carry `sslmode=require`. |
| Audio bytes | any S3-compatible bucket (R2, Backblaze, S3) | `STORAGE_DRIVER=s3` + `S3_*` (§7). The bucket, not Vercel Blob: nothing in this app speaks Blob. |
| Uploads + long jobs | a VM/container running `npm run worker`, or the Docker path in [DEPLOYMENT.md](DEPLOYMENT.md) §3 | Keep the Vercel project read-only with respect to ingest. |
| Redis (optional) | Upstash or similar | Changes cache *and* queue drivers at once; see §9 before you set it. |

## 4. Deploy

1. Push the repository and import it. **Set Root Directory to the repository root** (empty, or `.`),
   not `apps/api`: every `@d7/*` import resolves through a `node_modules` symlink into a sibling
   workspace, and a sub-directory root puts those files — and `vercel.json`, and `api/index.ts` —
   outside the traced project. This is the single most damaging setting on this target, and it does
   not announce itself as such; a real attempt produced `error TS5058: The specified path does not
   exist: 'tsconfig.json'` from inside `/vercel/path0/apps/api`, which reads like a TypeScript bug.
   `npm run deploy:check` prints exactly what is missing (see step 3).
   Three settings live only in the dashboard and each one has produced a failed deploy here:
   **Root Directory** = repository root, **Framework Preset** = Other, **Node.js Version** = 22.x
   (`vercel.json` also pins `runtime: nodejs22.x` for the function, which is the more specific
   setting — the dashboard one governs the *build*). Before pushing, confirm the lockfile is
   committed, because `installCommand` is `npm ci --include=dev` and that command refuses to run
   without it:

   ```bash
   git ls-files --error-unmatch package-lock.json   # prints the path, or errors
   npm ci --dry-run                                 # proves the lockfile matches every workspace manifest
   ```

   Both pass in this checkout (`npm ci --dry-run` exits 0 against the 109-package tree); an
   uncommitted lockfile is the difference between that and `npm error code EUSAGE` on Vercel.
2. Framework preset: **Other**. `framework: null` in `vercel.json` says the same; what must not
   happen is Vercel finding a Next.js app — there isn't one today, which is why `apps/web` contains
   no `next.config.*`.
3. `vercel.json` carries `installCommand`, `buildCommand`, the function settings and the rewrite, so
   there is nothing to configure in the dashboard for those:

   ```json
   "installCommand": "npm ci --include=dev",
   "buildCommand": "npm run deploy:check && npm run typecheck",
   "functions": { "api/index.ts": { "maxDuration": 60, "memory": 1024,
     "includeFiles": "packages/database/migrations/**" } }
   ```

   `includeFiles` is not decoration: migrations are discovered with `readdir`
   (`packages/database/src/migrate.ts`), and a build-time file tracer cannot see a file it was never
   imported. Without it the function boots, finds no `.sql`, and serves an empty schema.
   `buildCommand` starts with `npm run deploy:check`
   (`scripts/verify-vercel-layout.mjs`), which asserts from the build's own working directory that
   `api/index.ts`, `vercel.json`, the root `tsconfig.json`, `packages/config` and a non-empty
   `packages/database/migrations` are all present — i.e. that the build is looking at the repository
   root — and otherwise fails with that sentence instead of an unrelated complaint. It is a
   dependency-free `node` script, so it runs before dependencies are trusted and on a Hobby plan the
   same as anywhere. The rest is the root `typecheck` on purpose: `npm run build` would try to build
   `apps/web`.

   Run the same check locally before you deploy: `npm run deploy:check` →
   `vercel layout OK — /path/to/d7music`.
4. Add the environment (Settings → Environment Variables). Minimum viable set:

   | Variable | Value |
   | --- | --- |
   | `NODE_ENV` | `production` — but see the warning under this table: it also changes what the *build* installs |
   | `APP_SECRET` | 32+ random chars — the boot guard refuses the built-in default |
   | `DATABASE_URL` | pooled Postgres URL with `sslmode=require` |
   | `DB_POOL_MAX` | `1` |
   | `API_PUBLIC_URL` | `https://<your-project>.vercel.app` (no trailing slash) |
   | `WEB_ORIGIN` | your front end's exact origin, comma-separated list allowed |
   | `TRUST_PROXY` | `false` — Vercel's edge is not a proxy you operate on `request.ip` semantics you rely on; leave the default |
   | `API_MIGRATE_AT_BOOT` | `false` (§5) |
   | `CRON_SECRET` | a long random string (§6) |
   | `STORAGE_DRIVER` / `S3_*` | §7 |
   | `STREAM_REDIRECT` | `true` with an s3 driver, `false` otherwise |
   | `MUSIC_PROVIDER` | `none` unless you have licensed credentials; `local_library` is the default and needs no keys |

   **`NODE_ENV=production` is present during the Vercel build as well as at runtime, and npm derives
   `omit=dev` from it.** `npm ci` then installs no devDependencies, so `tsc` does not exist and the
   build dies on a missing binary while every source file is fine — reproduced locally: with
   `NODE_ENV=production` the install drops `node_modules/typescript` and `node_modules/vitest`
   (`npm config get omit` reports `dev`) and `npm run typecheck` exits with `sh: 1: tsc: not found`.
   The `--include=dev` in `installCommand` above is what neutralises it; `npm run deploy:check` names
   that exact cause when it sees the combination. The alternative is to drop the typecheck from
   `buildCommand` and let CI typecheck — nothing at *runtime* needs a devDependency, because `tsx` is
   declared as a production dependency on purpose.

   A variable set to the empty string means "unset" here — the schema drops `''` before parsing, so
   `APP_SECRET=` fails the production guard instead of signing sessions with an empty secret
   ([ENVIRONMENT.md](ENVIRONMENT.md) has the full contract).
5. Deploy, then check `https://<host>/api/health` — it is the one endpoint that proves DB, cache and
   storage in a single request, and it returns 503 (not 200) if the storage probe fails.

## 5. Migrations

Two workable patterns; pick one and be consistent.

* **Explicit (recommended).** Keep `API_MIGRATE_AT_BOOT=false` and run `npm run db:migrate` from CI
  on merge to `main`, before the Vercel production deploy is promoted. Concurrent cold starts can
  then never race the `schema_migrations` ledger.
* **At boot.** Leave `API_MIGRATE_AT_BOOT=true` (the default). It is idempotent and checksum-guarded,
  so the cost is a slower first request and a possible `relation already exists` churn under
  simultaneous starts — the ledger insert is in the same transaction as the migration, so a loser
  rolls back and re-reads. Fine for a personal project; noisy for a fleet.

Never edit an applied `.sql` file: the checksum is compared at boot and a mismatch is fatal. Add a
new numbered migration instead (`packages/database/migrations/`, currently `0001`–`0012`).

## 6. Vercel Cron and `/api/jobs/:job`

`vercel.json` ships five schedules, all daily so the free plan accepts them:

```json
"crons": [
  { "path": "/api/jobs/release-sync",   "schedule": "0 3 * * *" },
  { "path": "/api/jobs/recommendations","schedule": "0 4 * * *" },
  { "path": "/api/jobs/trending",       "schedule": "0 5 * * *" },
  { "path": "/api/jobs/reindex",        "schedule": "0 6 * * *" },
  { "path": "/api/jobs/queue-drain",    "schedule": "0 7 * * *" }
]
```

| Job | What it runs | Knobs (query string) |
| --- | --- | --- |
| `release-sync` | `ReleaseSyncService.runOnce`, the same method as `npm run sync:releases` and the worker | `lookbackDays` (1–3650, default `RELEASE_SYNC_LOOKBACK_DAYS`), `maxAlbums` (1–500, default `RELEASE_SYNC_MAX_ALBUMS_PER_RUN`), `indexOnly=true` |
| `recommendations` | `LinearScoringProvider.computeAndPersist` | `limit` (1–500, default 60) |
| `trending` | `refreshTrending` | `limit` (5–100, default 25) |
| `reindex` | `rebuildSearchIndex` + `catalog_version` bump | — |
| `queue-drain` | `queue.drain()` against the Postgres queue (`FOR UPDATE SKIP LOCKED`) | `limit` (1–50, default 10) |

Rules that come from the platform, not from us:

* Cron issues **`GET` only**. The route registers `GET` and `POST` on the same handler for that
  reason; `POST` is for `curl` and CI.
* Vercel is documented to send `Authorization: Bearer $CRON_SECRET` for cron requests when the
  project has a secret named *exactly* `CRON_SECRET` — which is why this variable is not called
  `JOB_TOKEN_SECRET` or anything nicer. Confirm it once in your first cron execution's request (or
  just curl the endpoint yourself, below) rather than trusting this sentence: the app-side rule is
  the one we control, `timingSafeEqual` over equal-length buffers, and a header that is not
  `Bearer <token>` is rejected outright.
* If `CRON_SECRET` is empty the endpoint answers **`501 CRON_NOT_CONFIGURED`** — before the job name
  is even checked. Forgetting the secret closes the door; it does not open it.
* `release-sync` takes the *same* lock name the worker uses (`release-sync`), so a cron run and a
  `npm run worker` tick on a VM contend instead of both importing the same page of albums. The other
  four jobs are namespaced `job:<name>`.
* Schedules are **UTC**, and Vercel neither prevents overlap nor guarantees a single execution
  (retries and duplicates are possible). Two mechanisms cover that: every run holds
  `cache.withLock('job:<name>', ttl)`, and a contended run returns
  `{"job":"…","skipped":"locked"}` with a 200 instead of duplicating work; the underlying writes are
  upserts, so a second sync converges rather than double-importing (a re-run of `npm run sync:releases`
  reports `imported albums=+0/~0 tracks=+0/~41` for the same feed).

  Locally, two `GET /api/jobs/release-sync?maxAlbums=60` requests opened in the same tick on separate
  sockets came back as `200 {"ok":true,"tookMs":1063,"result":{"fetchedAlbums":12, …}}` and
  `200 {"job":"release-sync","skipped":"locked"}`. That is the behaviour to expect from a cron retry —
  a 200 that says nothing was duplicated, not a second run. The in-process half of the lock works on
  either cache driver; only Redis (`SET NX PX`, released by a Lua compare-and-delete) excludes
  *another isolate*, which is why §9 matters if you run several regions.
* Frequency limits are plan-dependent and Vercel has changed them (Hobby has been limited to one run
  per job per day, and a sub-daily expression on such a project fails the deploy outright; Vercel's
  published JSON schema caps the array itself at 100 entries). Read the deploy log; do not trust this
  sentence. Once you know your limit, the useful sub-daily shapes are:

  ```json
  { "path": "/api/jobs/release-sync", "schedule": "*/30 * * * *" },
  { "path": "/api/jobs/queue-drain",  "schedule": "*/10 * * * *" },
  { "path": "/api/jobs/trending",     "schedule": "15 * * * *" }
  ```

  Note that a 10-minute drain with a 4-minute lock TTL (`LOCK_TTL_MS['queue-drain']`) is a queue
  that can never be drained twice in a row — raise one or lower the other.
* Trigger one manually any time:

  ```bash
  curl -sS -H "Authorization: Bearer $CRON_SECRET" \
    "https://<host>/api/jobs/release-sync?maxAlbums=20"
  ```

  An admin can also force the same work through `POST /api/admin/sync` (session cookie, admin role,
  rate-limited 6/600 s) — that path is unchanged and is the one to use interactively.

`maxDuration` is the ceiling a job must fit inside. The sync run caps itself at 500 albums per run
for that reason; on a first import of a large catalogue, run `npm run sync:releases` from CI until it
stops reporting a full page, then let cron maintain it.

## 7. Storage and streaming

```
STORAGE_DRIVER=s3
S3_BUCKET=…  S3_REGION=…  S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # blank for AWS
S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true      # R2/MinIO need path style; leave true unless your endpoint differs
STORAGE_PUBLIC_BASE_URL=      # empty = the API serves media itself; set only if a CDN fronts the bucket
STREAM_REDIRECT=true
STREAM_URL_TTL_SEC=21600
```

`/api/stream/:key` normally proxies the object with `range` support. Under `STREAM_REDIRECT` it first
asks the provider for a presigned URL and, **only if that URL is on a different origin**, answers
`302` to it (`resolveStreamDelivery` in `apps/api/src/routes/media.ts`). The origin test is the whole
point: `LocalStorageProvider` reports `supportsPresign === true` while its signed URLs are
`/cdn/…` and `/api/stream/…` on this very API, so a `supportsPresign` check alone would produce a
redirect loop. Both branches are unit-tested in `tests/vercel.test.ts`.

Two consequences worth knowing:

* A 302 to a presigned URL expires independently of the session; `STREAM_URL_TTL_SEC` is the
  signature's lifetime and the client must re-request when it gets a 403 from the bucket.
* `packages/audio-storage/src/providers.ts` signs `key|exp|userId` with `APP_SECRET`. With
  `ALLOW_UNLICENSED_STREAM=false` (default) the licence check has already happened before the 302, and
  the bucket's own expiry is what protects the URL afterwards.

## 8. What this replaces

| Long-lived process | Vercel equivalent |
| --- | --- |
| `npm run worker` (scheduler + queue pump) | the five `crons` above |
| `d7music-api.service` × N | the single function, scaled by Vercel |
| nginx (`deploy/nginx.conf`) | Vercel routing + the `headers` block in `vercel.json` |
| `deploy/backup.sh` | your provider's snapshots, or a scheduled `pg_dump` in CI — Vercel has no cron that can run shell commands |

`RELEASE_SYNC_ENABLED` keeps meaning something on the worker/VM path and nothing on this one: the
serverless entry builds the context with `headless: true`, so the interval scheduler is never armed
(`apps/api/src/context.ts`). Nothing here reads a flag and hopes.

## 9. Cache, locks and Redis

Without `REDIS_URL` the cache driver is `memory` **per isolate**. So:

* rate-limit counters, `catalog_version` and short-lived query caches are per-isolate and will be
  occasionally stale/inconsistent between them — acceptable for this app's read paths, which is why
  they are caches and not sources of truth;
* the `withLock` guard on §6 is then best-effort rather than cluster-wide. The pieces that must not
  double-run do not rely on it: queue claims use `FOR UPDATE SKIP LOCKED`, and sync writes are upserts.

With `REDIS_URL` set, the cache becomes shared **and** `createJobQueue` switches to BullMQ —
whose `drain()` is a documented no-op ("the worker owns execution", `services/release-sync/src/queue.ts`).
That means `/api/jobs/queue-drain` starts returning `{"processed":0}` forever and any album enqueued
by `POST /api/admin/sync?defer=true` waits for a worker that Vercel will not run. If you want BullMQ,
run the worker on a VM/container alongside this deploy; if you only wanted shared locks, that is the
wrong trade and you should stay on the Postgres queue.

## 10. Verified here, and what you must verify there

Verified in this repository (`npm run typecheck`, `npm test`, `npm run docs:check`):

* the bridge serves the real app over a real socket (`/api/health`, `/api/version`), recovers a
  rewritten path, and reports `ROUTE_NOT_MOUNTED` with its candidates otherwise;
* `cronTokenMatches` (bearer-shape and length rules), `resolveStreamDelivery` (same-origin proxy,
  cross-origin redirect, scheme and junk guards), and `/api/jobs` failing closed with `501`;
* the authorised path, by running the Vercel entry (`getHandler()` over `http.createServer`) with
  `CRON_SECRET` set: `401` without the header, `404 UNKNOWN_JOB` for an unknown name, and `200` for
  `release-sync` (`fetchedAlbums: 12`), `recommendations` (`computed: 3, users: 3`), `reindex`
  (`documents: 110`), `trending` and `queue-drain` (`processed: 0`, empty queue) — plus the contended
  run in §6. Boot ran with `API_MIGRATE_AT_BOOT=false`, which is the setting a Vercel deploy should use;
* the per-workspace scripts a platform actually invokes: `npm run typecheck -w @d7/api` now passes
  (it previously failed with `TS5058`, because `apps/api` advertises a `typecheck` script pointing at a
  `tsconfig.json` that has never existed there — this repository typechecks as *one* project at the
  root), `npm run typecheck --workspaces --if-present` is a CI step so it cannot rot again, and
  `scripts/verify-vercel-layout.mjs` was tested by running it from the repo root (passes), from
  `apps/api` (fails, naming all six missing things) and from a doctored root with `api/index.ts`
  removed (fails, naming just that);
* the devDependencies trap and its fix, end to end: `NODE_ENV=production npm ci` in this repository
  removed `typescript` and `vitest`, `npm run typecheck` then failed with `sh: 1: tsc: not found`,
  `npm run deploy:check` failed naming `NODE_ENV` and `omit=dev`, and `NODE_ENV=production npm ci
  --include=dev` put both back so the whole sweep passed again (typecheck clean, 56 tests,
  `docs:check` OK);
* `vercel.json` validates against Vercel's published JSON schema (`additionalProperties: false`, so
  the file cannot carry unknown keys or stray comments);
* the three new variables (`API_MIGRATE_AT_BOOT`, `STREAM_REDIRECT`, `CRON_SECRET`) exist in the
  config contract, `.env.example` and [ENVIRONMENT.md](ENVIRONMENT.md) — 94 of them, all cross-checked.

Not verified here, by definition (no Vercel account or CLI in this environment):

* that the function builds, its bundle size, and cold-start time. Expect the bundle to *contain*
  `@electric-sql/pglite` because `packages/database/src/client.ts` imports it with a literal dynamic
  `import()` even though production refuses that driver; it is dead weight, not a failure. If the
  payload or cold start bothers you, move Postgres access behind a lighter entry or accept it.
* that your plan accepts the cron expressions and `maxDuration: 60` (both are plan-gated; the deploy
  log states the real limits).
* that `packages/database/migrations/**` lands in the payload as intended — after deploying, run
  `npm run db:migrate` from CI anyway (§5), then check `GET /api/health` reports the seeded catalogue.
* Vercel's request-body ceiling for uploads, cited above from their docs.

First five checks after a deploy:

```bash
curl -sS https://<host>/api/health | head -c 400   # status ok, storage ok, driver postgres
curl -sS https://<host>/api/config                  # what the (future) web tier would configure itself from
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/index.html   # 404 ROUTE_NOT_MOUNTED = rewrite works, no web tier
curl -sS https://<host>/api/jobs/trending           # 501 if CRON_SECRET missing, 401 if header missing
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/trending
```

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `error TS5058: The specified path does not exist: 'tsconfig.json'`, with `npm error path /vercel/path0/apps/api` | Root Directory is `apps/api`, so the build ran that workspace's script from inside it. Fixed at the repo level (workspace scripts now point at the root project, so they work from either directory), but this deploy cannot work from a sub-directory root at all: set Root Directory to the repository root and redeploy. `npm run deploy:check` from `apps/api` reproduces the whole list. §4 step 1. |
| `Cannot find module '@d7/config'` **during the build** (a file-not-found about a sibling directory) | Same cause as the row above: Root Directory is not the repository root. §4 step 1. |
| `Cannot find module '@d7/config'` **when the function runs** (build succeeded, every request 500s) | The workspace manifests resolve `@d7/*` to TypeScript sources (`packages/config/package.json` → `"exports": { ".": "./src/index.ts" }`), which `tsx` reads happily and a compiled-lambda layout may not. This has not been reproduced here — no Vercel credentials — so if you hit it, paste the runtime log: the fix is a real build step (emit `dist/` per package and point `main`/`exports` at it) rather than a config tweak. |
| `sh: 1: tsc: not found` (or `error TS2307: Cannot find module 'vitest'`) with no other complaint | `NODE_ENV=production` made the build's `npm ci` omit devDependencies. Use `npm ci --include=dev`, or remove the typecheck from `buildCommand`. §4 step 4. |
| `npm error code EUSAGE` / “package-lock.json is necessary” | `package-lock.json` is not committed, and `installCommand: npm ci --include=dev` requires it. Commit it, or set the dashboard Install Command to `npm install`. |
| `Couldn't find any \`pages\` or \`app\` directory` | Root Directory is `apps/web` (`next` is a dependency there, so Vercel detected Next.js). This deploy has no web tier; the root must be the repository root. |
| Function fails to start with an ESM/`SyntaxError` about `import` | The project's Node.js version is below 20. `engines.node` is `>=20.9.0` and `vercel.json` pins `nodejs22.x` for the function; align the dashboard setting too. |
| Build fails with a Next.js error | Framework preset is not **Other**, or a `next.config.*` turned up at the repository root and made Vercel detect a framework again. Set the preset; keep `framework: null`. |
| Every route 404s but `/api/index` alone answers | The rewrite is missing or the runtime replaced `req.url` with the destination and sent no `x-matched-path`. Use the `?__d7path=/$1` destination (§2). |
| `404 NOT_FOUND` from Fastify for `/api/health`, and the Vercel 404 page elsewhere | You deployed with the rewrite matching only part of the tree, or `KNOWN_PREFIXES` no longer covers a route you added — extend it in `apps/api/src/vercel.ts`. |
| Boot error `FATAL: DB_DRIVER=pglite…` / `FATAL: DATABASE_URL is required…` | Those guards are working; set `DB_DRIVER=postgres` and a real URL. |
| 503 from `/api/health` with `checks.storage.ok: false` | `STORAGE_DRIVER=local` on a read-only filesystem. Set `s3`. |
| Cron runs show 401 in the Vercel cron log | The project secret is not named `CRON_SECRET`, or it was added after the cron was created — redeploy so Vercel re-reads it. |
| Cron shows `{"skipped":"locked"}` every time | A previous run's lock is still held (or `maxDuration` killed it mid-run and the TTL has not expired). Check the TTL in `apps/api/src/routes/jobs.ts` against your schedule. |
| A sync run dies at the duration limit with a truncated catalogue | Lower `maxAlbums` per run (cron knob or `RELEASE_SYNC_MAX_ALBUMS_PER_RUN`), or raise `maxDuration` if your plan allows, and re-run until the page comes back short. |
| `/api/jobs/queue-drain` always returns `processed: 0` | `REDIS_URL` is set and the queue is BullMQ — §9. |
