# Running D7music in anger

Day-2 knowledge: what to look at, what a number means, and what to do at 03:00.
Getting it up the first time is [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 1. The one endpoint that tells the truth

```bash
curl -fsS localhost:4000/api/health | python3 -m json.tool
```

`/api/health` is a **capability** report, not a liveness ping. It returns `200` with
`status: "ok"`, or `503` with `status: "degraded"` when the database or storage is unreachable.
Every field is worth understanding because each one maps to a feature the UI promises or withholds:

| Field | Value | What to do |
| --- | --- | --- |
| `checks.database.ok` / `.driver` / `.label` | `postgres` / `pglite@.data/pglite`, plus published `tracks`/`albums`/`artists` counts | `false` = connection or pool exhaustion. `pglite` in a production label = a misconfigured deploy. Counts dropping to 0 after a restore means you restored schema without data. |
| `checks.cache.driver` | `redis` or `memory` | `memory` means rate limits and locks are **per process**. Fine on one node; on three it silently triples every limit. |
| `checks.storage.ok` / `.driver` | `local` / `s3` | `ok: false` with `local` is almost always a read-only mount or a `STORAGE_LOCAL_DIR` the service user cannot write. |
| `checks.audioProvider.configured` | bool | `false` with `name: "local_library"` is normal: platform-owned uploads only. With `json_http` it means base URL/key are missing. |
| `checks.metadataProviders[]` | `{name, enabled, configured, reasons}` | `reasons` is a human sentence — read it before filing a bug about "sync does nothing". |
| `checks.queue.driver` | `postgres` or `bullmq` | Which claim path your jobs take (§4). |
| `checks.releaseSync` | `{enabled, everyMinutes, lastRun}` | The first place to look when "new releases stopped". Each tick takes the `release-sync` cache lock first, so `checks.cache.driver: memory` plus two armed processes means the lock is not protecting you (§1 of DEPLOYMENT). |
| `checks.assistant.engine` | `rules` or `llm+rules` | `rules` is a fully working deterministic parser, not a failure. |
| `checks.payments` | `manual` / `stripe` | `manual` = nobody is charged. |

`/api/version` (build version, node, env, `startedAt`) is the cheap liveness probe to use from
untrusted networks: it exposes nothing about your topology.

Also useful without a session: `GET /api/config` (what the client was told), and
`GET /api/admin/sync-runs` / `/api/admin/queue` / `/api/admin/overview` with an admin token —
see §5.

---

## 2. Logs

The API uses its own line logger (`apps/api/src/context.ts` → `makeLogger`), not pino's writer, so
the format is stable and greppable:

```
2026-09-01T11:03:07.611Z INFO  provider: local_library (audio) {"…":"…"}
2026-09-01T11:03:07.612Z WARN  release sync failed; backoff applied {"errors":1,"intervalMs":21600000}
```

- stdout = everything below `error`; stderr = `ERROR` lines only. Splitting them keeps an
  `exec`-based alert on stderr meaningful.
- Request logging is **off** (`disableRequestLogging: true`) because a music API is 90 % range
  requests; per-request identity is the `x-request-id` response header, which equals Fastify's
  `request.id`. Grep your proxy log for that id, then the app log for the surrounding lines.
- `LOG_LEVEL=debug` also emits one line per request (`METHOD url {ip}`) — useful behind the proxy,
  not worth running permanently.
- Worker/CLI processes prefix their own lines (`release-sync …`, `info: …`).

**Never log a token.** The reset/verify flows return `devToken` only outside production, and
webhook payloads are stored redacted (`redact(payload)` in `routes/subscription.ts`) — keep it that way
if you extend either.

---

## 3. Metrics worth wiring

Nothing exports Prometheus today (deliberate: no half-implemented exporter). Derive these from what
exists until you add a real sink:

| Signal | Source | Alarm when |
| --- | --- | --- |
| liveness | `GET /api/health` `tookMs` | > 1500 ms (it runs two queries + a storage probe; a slow number here is your earliest DB warning) |
| readiness | HTTP status of `/api/health` | any `503`, twice in a row |
| catalog size | `checks.database.tracks` | drops > 5 % day-over-day (bad restore, mass-unpublish) |
| 5xx rate | proxy access log | > 0.5 % over 5 min |
| rate-limit pressure | `x-ratelimit-remaining` on any 200, `429` count | a single user id pinned at 0 continuously = abuse or a broken client loop |
| queue backlog | `GET /api/admin/queue` → `queued/failed/dead/running` | `queued` growing for > 2 × interval; `dead > 0` |
| sync health | `GET /api/admin/sync-runs` (status, counts, error text) | `failed` twice consecutively → the provider cursor is now in backoff |
| stream integrity | proxy log for `/api/stream/` | any `403` spike = `APP_SECRET` rotation mid-session, or a proxy eating query params |
| auth friction | `POST /api/auth/login` 401 vs 429 ratio | 429s dominating = the limiter, not the password |

`GET /api/me/stats` and `GET /api/admin/overview` are per-user / platform-wide rollups built from
`stats_daily` (and `stats_daily_country`), so business reporting needs no new pipeline.

---

## 4. Queues and jobs

Two drivers, one interface (`services/release-sync/src/queue.ts`):

- **Postgres (default)** — jobs live in `sync_jobs`, claimed with `FOR UPDATE SKIP LOCKED`, retried
  with `retryInSec = min(3600, 30 · 2^attempts)`, then `dead`. Multiple consumers are safe and
  encouraged. `drain(5)` every 10 s per process.
- **BullMQ** (`REDIS_URL` set) — same handlers, worker pools, Redis visibility.

Job kinds today: `album_import` (`{provider, providerAlbumId}`) and `index_refresh`. A `POST
/api/admin/sync/album` with `?defer` enqueues instead of doing the work in-request (202), which is how
you should always drive imports from a UI.

Operations:

```bash
# backlog + failure detail
curl -s -H "Cookie: d7-session=$TOKEN" localhost:4000/api/admin/queue
# force a run now (also refreshes recommendations + search the way the scheduler does)
curl -s -XPOST -H "Cookie: d7-session=$TOKEN" localhost:4000/api/admin/sync
# one-shot from the CLI instead, identical code path
npm run sync:releases -- --max 50
npm run recommendations:update
```

To clear a wedged `dead` job, fix the cause, then re-enqueue via the admin route — there is
intentionally no "force retry all" button, because most dead jobs die on a provider that is currently
rate-limiting you.

`provider_health` rows reference `music_providers(name)`, so a provider whose name is not in that
registry (custom `MUSIC_PROVIDER` value, or a restore that skipped the registry rows) makes every
run end with a foreign-key error while still importing. `GET /api/admin/providers` lists the
registry; the fix is a row, not a code change.

---

## 5. Admin surface

Every route in `apps/api/src/routes/admin.ts` requires `requireRole('admin')` — no exceptions, and no
admin UI ships with this repo, so these are the sharp edges you drive from `curl` or an internal tool:

| Route | Use |
| --- | --- |
| `GET /api/admin/overview` | platform rollup (users, catalog, listens, revenue-shaped numbers) |
| `GET /api/admin/sync-runs` | last runs per provider, status, counts, errors |
| `GET /api/admin/providers` | provider health (`healthCheck()` per descriptor) |
| `POST /api/admin/sync` | run sync now (rate-limited 6 per 10 min) |
| `POST /api/admin/sync/album[?defer]` | import one provider album |
| `POST /api/admin/trending/refresh` | re-rank trending shelves |
| `POST /api/admin/reindex` | rebuild the search index; bumps `catalog_version`, so cached shelves drop |
| `PATCH /api/admin/tracks/:id`, `/albums/:id` | publish/unpublish, metadata fixes (the lever for a bad import) |
| `GET/PATCH /api/admin/reports[/:id]` | content report queue |
| `GET /api/admin/users`, `PATCH /api/admin/users/:id` | roles/status; suspending revokes sessions, and you cannot suspend yourself |
| `GET /api/admin/claims`, `POST /api/admin/claims/:id` | artist-claim approve/deny (notifies the user) |
| `POST /api/admin/notify` | broadcast/system notification |
| `GET /api/admin/queue` | §4 |
| `DELETE /api/admin/cache` | `clearNamespace()` — the "make it re-read the DB" button |

`POST /api/admin/reindex` and `DELETE /api/admin/cache` are the two safe, boring fixes for "the UI is
showing stale catalog data".

---

## 6. Cache

`packages/cache` keys every composed shelf with a `catalog_version` counter, so catalog writes
invalidate correctly without TTLs being short. What that means operationally:

- `CACHE_TTL_HOME_SEC=20` / `CACHE_TTL_CATALOG_SEC=240` are **ceilings on staleness**, not the only
  invalidation path. A track you unpublished stops being served as soon as its write commits.
- With the memory driver, `catalog_version` is per process: a write on node A does not bump node B's
  counter, so B serves its cached copy until TTL. That is the strongest argument for `REDIS_URL` once
  you have >1 node.
- `DELETE /api/admin/cache` clears the namespace prefix (`QUEUE_NAMESPACE`) — never `FLUSHALL` a shared
  Redis.

---

## 7. Backups and restore

`deploy/backup.sh` = `pg_dump -Fc` + tar of local-storage objects + a size/count manifest, keeping 7
daily and a `latest/` copy; `deploy/restore.sh` = the reverse, with a confirmation string.

Non-negotiables:

1. **Both halves or neither.** The DB holds keys, the bucket holds bytes. Restoring one without the
   other yields a library full of unplayable rows (or orphaned files).
2. Verify a restore quarterly, on a scratch database, and *play a track* afterwards — a dump that
   restores but has zero published tracks is a failed backup.
3. Nightly dumps are not a recovery point for user data (playlists, likes, payments). Enable provider
   WAL archiving/PITR.
4. Outbox files (`MAIL_OUTBOX_DIR`) contain live reset tokens: back them up *nowhere*, prune them.
5. `webhook_events` is your payment audit trail — include it in retention planning, and note it stores
   redacted payloads only.

Dev/preview cluster: `.data/pglite` is a real PGDATA. `npm run db:reset && npm run db:seed` if it gets
half-restored (see the `PGlite failed to initialize properly` row in DEPLOYMENT §14).

---

## 8. Rotating things

| Secret | How | Blast radius |
| --- | --- | --- |
| `APP_SECRET` | set new value, restart all processes at once | every session invalidated (all users sign in again), every outstanding signed stream URL 403s. Sessions are DB-backed, so sign-in works immediately afterwards. Do it in one restart wave: with two different secrets live, some nodes will reject cookies the others issued. |
| `S3_*` keys | rotate at the provider, then env + rolling restart | in-flight uploads fail briefly |
| `STRIPE_WEBHOOK_SECRET` | rotate at Stripe, then env + restart | deliveries during the gap are `400 BAD_SIGNATURE`; Stripe retries them |
| OAuth client secret | provider console + env + restart | in-progress logins fail; nothing persisted |
| `d7-session` tokens | `DELETE /api/auth/sessions` (per user) or `revokeAllSessions` | that user only |
| DB password | provider + `DATABASE_URL` + restart | connections drop; the pool reconnects |

---

## 9. Incidents worth knowing how to handle

**A sync run is `partial` and every row says the same thing.** Not a provider problem: `partial`
with per-album errors like `null value in column "slug"` means our mapping produced a NULL the schema
rejects. `0011_null_safe_slugs.sql` plus a default in `upsertAlbum` closed this; check
`rejected_invalid` in `GET /api/admin/sync-runs` to see whether the feed is missing titles/durations
instead, in which case the rejections are the correct outcome.

**Provider is rate-limiting us.** Sync runs go `failed`, backoff doubles, `next_run_at` moves out.
Do not "fix" it by lowering `MUSIC_PROVIDER_RPS`-ish values at 03:00 — the cursor already backs off.
Read `GET /api/admin/sync-runs`, confirm the 429, and let it ride; `RELEASE_SYNC_INTERVAL_MIN` is the
knob for the next day.

**A user reports "everything is silent".** Ask for the `x-request-id` of the failed `POST
/api/playback/events` or the stream request. `403` on `/api/stream/*` = signature/expiry (rotate
events, clock skew on the client does not matter — `exp` is server-issued), `404` = key missing from
the bucket, `409`/license error = `ALLOW_UNLICENSED_STREAM=false` doing its job on an unlicensed
upload. The right fix is usually `PATCH /api/admin/tracks/:id` to publish, or a license row.

**Search got worse after a bulk import.** The index lags the table: `POST /api/admin/reindex`, then
re-check `didYouMean` behaviour with a typo query. The fallback is a Dice-bigram candidate search over
the whole document set (not `pg_trgm`), so it degrades gracefully when the extension is missing — but
it only proposes ≤400 candidates per query.

**A deploy is on fire.** Roll back the *image*, not the schema: migrations are additive and the ledger
checksum makes reverting an applied file impossible by design. If a migration was genuinely wrong, add
`0011_fix_*.sql` that undoes it. Then `POST /api/admin/reindex` + `DELETE /api/admin/cache` so no node
serves a view of the broken state.

**Disk full.** The two writers are `STORAGE_LOCAL_DIR` (audio, ~1 MB/s of uploaded material) and the
outbox (reset mail). `df` first, then decide whether to move storage to S3 (`STORAGE_DRIVER=s3` needs
a data move — there is no importer in this build; upload-time writes only).

**CPU pinned by bcrypt.** `BCRYPT_ROUNDS` is a login/signup cost, and `RATE_LIMIT_AUTH=12`/60 s is the
only thing standing between you and a cheap DoS. If the limiter is being bypassed, `TRUST_PROXY` and
`REDIS_URL` are the two suspects (DEPLOYMENT §6 for why).
