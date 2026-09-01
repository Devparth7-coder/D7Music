# D7music docs

| Document | Read it when |
| --- | --- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | You are putting this somewhere other than your laptop: processes, sizing, env, storage, TLS, OAuth, mail, payments, launch checklist, troubleshooting. |
| [ENVIRONMENT.md](ENVIRONMENT.md) | You need what a variable does, its real default, and whether production requires it. Generated against the schema; `npm run docs:check` keeps it honest. |
| [OPERATIONS.md](OPERATIONS.md) | It is running and you need to know what a number means: `/api/health` fields, logs, metrics to derive, queues, admin routes, cache semantics, backups, secret rotation, incidents. |
| [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md) | You want the API on Vercel (functions + Vercel Cron) rather than a box you own: how the single function is mounted, which jobs cron can and cannot carry, and what this platform cannot host at all. |
| [PROVIDERS.md](PROVIDERS.md) | You are wiring a licensed catalogue API (or MusicBrainz) and need the exact field-mapping and endpoint-override contract, plus how release sync decides what becomes playable. |

## How the pieces fit

```
                         ┌──────────────┐   ┌──────────────┐
 browser ── https ──►    │  nginx (TLS) │──►│  API ×N      │  Fastify 5, /api/*, /media/*, /cdn/*
                         └──────────────┘   │  :4000       │  boots → migrates → serves
                                            └──────┬───────┘
                                                   │ Db (pg)         Cache (memory | redis)
                          ┌──────────────┐         │                 │
                          │ worker ×1    │◄────────┴────┬────────────┘
                          │ queue + sync │              │
                          └──────────────┘   Postgres   │  S3-compatible bucket (audio bytes)
                                          (schema+keys)│
                                             one-shot jobs: sync:releases · recommendations:update
```

Nothing in the app reaches a music vendor unless `MUSIC_PROVIDER`/`METADATA_PROVIDERS` say so, and no
provider response can make audio streamable — that decision belongs to the `licenses` table
(`docs/PROVIDERS.md` §5 has the exact query to prove it).

## Repository map (the four things you deploy)

| Path | What it is |
| --- | --- |
| `apps/api` | HTTP tier: `src/app.ts` (factory), `src/context.ts` (composition root), `src/routes/*` (15 files), `src/lib/*` |
| `apps/web` | **pending** — manifest only, no front end yet |
| `services/release-sync` | scheduler + queue adapter + standalone `worker.ts` |
| `jobs/*` | the two one-shot entry points the timers run |
| `packages/database` | `client.ts` (two drivers), `migrations/0001…0012`, `seed.ts`, and the repos (`catalog`, `playlists`, `social`, `searchIndex`, `sync`, `admin`, `creator`, `assistant`, `telemetry`, `accounts`, `jobs`) |
| `packages/{config,types,cache,audio-storage,music-providers,ui}` | env contract, shared types, cache+locks, storage providers, provider adapters, React primitives |

## Commands you will actually run

```bash
npm run dev                  # migrate + API (+ web when it exists), one terminal
npm test                     # 56 tests: 41 API integration + 15 serverless (real embedded PostgreSQL, ~35 s)
npm run typecheck            # tsc --noEmit over packages, services, jobs, apps/api, tests
npm run docs:check            # docs lint + env contract (`.env.example`, ENVIRONMENT.md)
npm run deploy:check          # Vercel-only: proves the project root looks like this repository
npm run db:status             # [x] per applied migration, with checksum timing
npm run db:migrate           # idempotent; safe to re-run
npm run db:seed              # dev only
npm run worker               # scheduler + queue consumer
npm run sync:releases -- --max 20
npm run recommendations:update
```

`docs/DEPLOYMENT.md` §2 is the copy-paste deploy; §15 is what CI enforces before a tag means anything.
