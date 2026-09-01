-- ============================ provider registry & mapping ============================

-- Configuration, not credentials. Secrets stay in env/secret manager; DB rows hold
-- capability metadata so the UI and admin can explain which providers are live.
CREATE TABLE IF NOT EXISTS music_providers (
  name              text PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('audio','metadata')),
  enabled           boolean NOT NULL DEFAULT false,
  -- 'streaming' = we may play audio; 'discovery' = metadata only (never playable here).
  capability        text NOT NULL DEFAULT 'discovery' CHECK (capability IN ('streaming','discovery','lyrics')),
  base_url          text,
  auth_mode         text NOT NULL DEFAULT 'env' CHECK (auth_mode IN ('none','env','oauth','api_key','signed')),
  default_page_size integer NOT NULL DEFAULT 50,
  rate_limit_rps    double precision NOT NULL DEFAULT 2,
  respects_drm      boolean NOT NULL DEFAULT true,
  terms_url         text,
  notes             text,
  last_success_at   timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER providers_touch BEFORE UPDATE ON music_providers FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

CREATE TABLE IF NOT EXISTS provider_artists (
  provider         text NOT NULL REFERENCES music_providers(name) ON DELETE CASCADE,
  provider_artist_id text NOT NULL,
  artist_id        uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_artist_id)
);
CREATE INDEX IF NOT EXISTS provider_artists_artist_idx ON provider_artists (artist_id);

CREATE TABLE IF NOT EXISTS provider_albums (
  provider         text NOT NULL REFERENCES music_providers(name) ON DELETE CASCADE,
  provider_album_id text NOT NULL,
  album_id         uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  release_date     date,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_album_id)
);
CREATE INDEX IF NOT EXISTS provider_albums_album_idx ON provider_albums (album_id);

CREATE TABLE IF NOT EXISTS provider_tracks (
  provider         text NOT NULL REFERENCES music_providers(name) ON DELETE CASCADE,
  provider_track_id text NOT NULL,
  track_id         uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  provider_album_id text,
  preview_only     boolean NOT NULL DEFAULT true,
  -- Whether we may fetch/serve audio from this provider. False = metadata only.
  streamable       boolean NOT NULL DEFAULT false,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_track_id)
);
CREATE INDEX IF NOT EXISTS provider_tracks_track_idx ON provider_tracks (track_id);

-- ============================ new release pipeline ============================

CREATE TABLE IF NOT EXISTS new_releases (
  id            uuid PRIMARY KEY DEFAULT d7_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN ('album','track')),
  entity_id     uuid NOT NULL,
  artist_id     uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  release_date  date NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  is_trending   boolean NOT NULL DEFAULT false,
  notified_count integer NOT NULL DEFAULT 0,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT new_releases_uniq UNIQUE (entity_type, entity_id, provider)
);
CREATE INDEX IF NOT EXISTS new_releases_date_idx ON new_releases (release_date DESC, detected_at DESC);
CREATE INDEX IF NOT EXISTS new_releases_artist_idx ON new_releases (artist_id, release_date DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id               uuid PRIMARY KEY DEFAULT d7_uuid(),
  provider         text NOT NULL,
  job              text NOT NULL DEFAULT 'release_sync',
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed')),
  triggered_by     text NOT NULL DEFAULT 'schedule' CHECK (triggered_by IN ('schedule','manual','cli','api')),
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  duration_ms      integer,
  fetched_artists  integer NOT NULL DEFAULT 0,
  fetched_albums   integer NOT NULL DEFAULT 0,
  fetched_tracks   integer NOT NULL DEFAULT 0,
  inserted_albums  integer NOT NULL DEFAULT 0,
  inserted_tracks  integer NOT NULL DEFAULT 0,
  inserted_artists integer NOT NULL DEFAULT 0,
  updated_albums   integer NOT NULL DEFAULT 0,
  updated_tracks   integer NOT NULL DEFAULT 0,
  skipped_duplicates integer NOT NULL DEFAULT 0,
  rejected_invalid integer NOT NULL DEFAULT 0,
  errors           jsonb NOT NULL DEFAULT '[]'::jsonb,
  cursor_before    text,
  cursor_after     text,
  rate_limit_wait_ms integer NOT NULL DEFAULT 0,
  attempts         integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS sync_runs_recent_idx ON sync_runs (provider, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_failed_idx ON sync_runs (status, started_at DESC) WHERE status IN ('failed','partial');

-- Per-provider high-water mark. Restart-safe: the job never re-scans from scratch.
CREATE TABLE IF NOT EXISTS sync_cursors (
  provider     text NOT NULL,
  job          text NOT NULL DEFAULT 'release_sync',
  cursor       text,
  last_run_id  uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, job)
);

-- Retry/queue backing store used when Redis is unavailable (dev) so the design is honest:
-- rows are claimed by the worker with FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS sync_jobs (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  kind         text NOT NULL DEFAULT 'album_import',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after    timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_jobs_dedupe UNIQUE (provider, kind, payload)
);
CREATE INDEX IF NOT EXISTS sync_jobs_claim_idx ON sync_jobs (run_after) WHERE status IN ('queued','failed');
CREATE TRIGGER sync_jobs_touch BEFORE UPDATE ON sync_jobs FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

-- ============================ provider health ============================

CREATE TABLE IF NOT EXISTS provider_health (
  provider             text PRIMARY KEY REFERENCES music_providers(name) ON DELETE CASCADE,
  state                text NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy','degraded','down','disabled')),
  latency_ms           integer,
  success_count        bigint NOT NULL DEFAULT 0,
  failure_count        bigint NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_check_at        timestamptz,
  last_error           text
);
