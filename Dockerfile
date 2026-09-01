# syntax=docker/dockerfile:1
#
# One image for every process in this repo — API, worker, and the two one-shot jobs.
# Only the command differs, so a deploy that works for `npm run worker` works for the API.
#
# There is deliberately no bundling step: the workspace packages export their TypeScript
# sources and the container runs `node --import tsx …`, which is the exact same module graph
# `npm test` exercised. That is why `tsx` is a *runtime* dependency (see root package.json)
# and why `npm ci --omit=dev` still boots.

ARG NODE_IMAGE=node:22-bookworm-slim

# --------------------------------------------------------------------------- deps
# Manifests first so a source-only change re-uses the install layer.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY jobs/release-sync/package.json ./jobs/release-sync/
COPY jobs/recommendation-update/package.json ./jobs/recommendation-update/
COPY packages/audio-storage/package.json ./packages/audio-storage/
COPY packages/cache/package.json ./packages/cache/
COPY packages/config/package.json ./packages/config/
COPY packages/database/package.json ./packages/database/
COPY packages/music-providers/package.json ./packages/music-providers/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY services/ai-assistant/package.json ./services/ai-assistant/
COPY services/notifications/package.json ./services/notifications/
COPY services/recommendation-engine/package.json ./services/recommendation-engine/
COPY services/release-sync/package.json ./services/release-sync/
COPY services/search/package.json ./services/search/

RUN npm ci --omit=dev

# --------------------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY jobs ./jobs
COPY scripts ./scripts

# -------------------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime

RUN groupadd --gid 1001 d7music \
 && useradd --uid 1001 --gid d7music --shell /usr/sbin/nologin --create-home d7music

WORKDIR /app
COPY --from=build --chown=1001:1001 /app ./

# Writable, volume-friendly places for local audio, the outbox and the dev cluster.
RUN mkdir -p /app/.data/storage /app/.data/outbox && chown -R 1001:1001 /app/.data

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=512 \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    LOG_LEVEL=info \
    STORAGE_LOCAL_DIR=/app/.data/storage \
    MAIL_OUTBOX_DIR=/app/.data/outbox
# NODE_ENV=production is intentional: the config guards (APP_SECRET, DATABASE_URL,
# DB_DRIVER=pglite) then fire at boot instead of a half-configured service quietly
# serving defaults. Override it for local container work (`docker compose up` does).

EXPOSE 4000
USER 1001
VOLUME ["/app/.data"]

# No curl/wget in a slim image; node can ask itself.
HEALTHCHECK --interval=30s --timeout=4s --start-period=25s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

# Other processes (same image, same layers, different command):
#   docker run --env-file .env d7music node --import tsx packages/database/src/cli.ts migrate
#   docker run --env-file .env d7music node --import tsx services/release-sync/src/worker.ts
#   docker run --env-file .env d7music node --import tsx jobs/release-sync/src/run.ts -- --max 50
