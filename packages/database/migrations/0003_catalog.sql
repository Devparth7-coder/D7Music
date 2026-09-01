-- ============================ artists ============================

CREATE TABLE IF NOT EXISTS artists (
  id                uuid PRIMARY KEY DEFAULT d7_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL,
  bio               text,
  image_url         text,
  banner_url        text,
  -- verified badge architecture: how the badge was earned, not just a boolean.
  verified          boolean NOT NULL DEFAULT false,
  verified_kind     text CHECK (verified_kind IN ('platform','label','distributor','creator_claim')),
  verified_at       timestamptz,
  verified_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  monthly_listeners integer NOT NULL DEFAULT 0,
  followers_count   integer NOT NULL DEFAULT 0,
  popularity        double precision NOT NULL DEFAULT 0,
  listener_regions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_links    jsonb NOT NULL DEFAULT '{}'::jsonb,
  name_key          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER artists_keys BEFORE INSERT OR UPDATE OF name ON artists
  FOR EACH ROW EXECUTE FUNCTION d7_keys_artists();
CREATE UNIQUE INDEX IF NOT EXISTS artists_name_key ON artists (name_key);
CREATE UNIQUE INDEX IF NOT EXISTS artists_slug_key ON artists (slug);
CREATE INDEX IF NOT EXISTS artists_popularity_idx ON artists (popularity DESC);

-- Artist-owned profile claimed by a creator (1:1 with a user account).
CREATE TABLE IF NOT EXISTS artist_profiles (
  id            uuid PRIMARY KEY DEFAULT d7_uuid(),
  artist_id     uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','manager','label')),
  claim_status  text NOT NULL DEFAULT 'claimed' CHECK (claim_status IN ('pending','claimed','rejected','released')),
  verified      boolean NOT NULL DEFAULT false,
  payout_entity text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artist_profiles_uniq UNIQUE (artist_id, user_id)
);
CREATE INDEX IF NOT EXISTS artist_profiles_user_idx ON artist_profiles (user_id);

CREATE TABLE IF NOT EXISTS genres (
  id           uuid PRIMARY KEY DEFAULT d7_uuid(),
  slug         text NOT NULL,
  name         text NOT NULL,
  description  text,
  accent_color text,
  track_count  integer NOT NULL DEFAULT 0,
  parent_slug  text,
  name_key     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT genres_slug_key UNIQUE (slug)
);
CREATE TRIGGER genres_keys BEFORE INSERT OR UPDATE OF name ON genres
  FOR EACH ROW EXECUTE FUNCTION d7_keys_genres();
CREATE UNIQUE INDEX IF NOT EXISTS genres_name_key ON genres (name_key);

-- ============================ albums & tracks ============================

CREATE TABLE IF NOT EXISTS albums (
  id             uuid PRIMARY KEY DEFAULT d7_uuid(),
  title          text NOT NULL,
  slug           text NOT NULL,
  artist_id      uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  album_type     text NOT NULL DEFAULT 'album' CHECK (album_type IN ('album','single','ep','compilation')),
  release_date   date NOT NULL,
  -- When the release became visible on the platform (drives "New Releases").
  added_at       timestamptz NOT NULL DEFAULT now(),
  scheduled_at   timestamptz,
  image_url      text,
  primary_color  text,
  label_name     text,
  copyright_note text,
  upc            text,
  popularity     double precision NOT NULL DEFAULT 0,
  -- ---- legal posture: every release states where it came from and its rights ----
  content_source text NOT NULL DEFAULT 'platform_owned'
                   CHECK (content_source IN ('platform_owned','licensed_provider','partner_feed')),
  license_status text NOT NULL DEFAULT 'licensed'
                   CHECK (license_status IN ('unlicensed','pending_review','licensed','rejected','expired')),
  -- ---- creator dashboard release workflow ----
  status         text NOT NULL DEFAULT 'published'
                   CHECK (status IN ('draft','submitted','approved','rejected','scheduled','published')),
  -- editorial "new release" pitch used by the discovery shelf
  pitch          text,
  title_key      text,
  explicit       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS albums_artist_idx ON albums (artist_id, release_date DESC);
CREATE INDEX IF NOT EXISTS albums_added_idx ON albums (added_at DESC);
CREATE INDEX IF NOT EXISTS albums_release_idx ON albums (release_date DESC);
CREATE INDEX IF NOT EXISTS albums_status_idx ON albums (status, added_at DESC);
CREATE TRIGGER albums_touch BEFORE UPDATE ON albums FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

-- Hard anti-duplicate guard: one (artist, normalized title, type) per catalog.
-- Provider imports additionally key off provider_album_id (see provider_albums).
CREATE TRIGGER albums_keys BEFORE INSERT OR UPDATE OF title, artist_id ON albums
  FOR EACH ROW EXECUTE FUNCTION d7_keys_albums();
-- Idempotency guard for sync: re-importing an album with a corrected date must UPDATE,
-- never insert a second copy.
CREATE UNIQUE INDEX IF NOT EXISTS albums_uniq_artist_title
  ON albums (artist_id, title_key, album_type);

CREATE TABLE IF NOT EXISTS tracks (
  id                uuid PRIMARY KEY DEFAULT d7_uuid(),
  album_id          uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  primary_artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title             text NOT NULL,
  track_number      integer NOT NULL DEFAULT 1,
  disc_number       integer NOT NULL DEFAULT 1,
  duration_ms       integer NOT NULL CHECK (duration_ms > 0),
  explicit          boolean NOT NULL DEFAULT false,
  isrc              text,
  -- audio location (object storage key, never a blob in the database)
  storage_key       text,
  mime_type         text,
  byte_size         bigint,
  peak_dbfs         double precision,
  loudness_lufs     double precision,
  -- ---- audio-side legal provenance ----
  content_source    text NOT NULL DEFAULT 'platform_owned'
                      CHECK (content_source IN ('platform_owned','licensed_provider','partner_feed')),
  license_status    text NOT NULL DEFAULT 'licensed'
                      CHECK (license_status IN ('unlicensed','pending_review','licensed','rejected','expired')),
  provider_name     text,
  provider_track_id text,
  status            text NOT NULL DEFAULT 'published'
                      CHECK (status IN ('draft','submitted','approved','rejected','scheduled','published')),
  streamable        boolean NOT NULL DEFAULT false,
  -- ---- audio analysis features (feed the recommender; ML-ready columns) ----
  energy            double precision NOT NULL DEFAULT 0.5,
  valence           double precision NOT NULL DEFAULT 0.5,
  danceability      double precision NOT NULL DEFAULT 0.5,
  acousticness      double precision NOT NULL DEFAULT 0.2,
  instrumentalness  double precision NOT NULL DEFAULT 0,
  key_scale         text,
  bpm               double precision,
  popularity        double precision NOT NULL DEFAULT 0,
  play_count        bigint NOT NULL DEFAULT 0,
  skip_count        bigint NOT NULL DEFAULT 0,
  save_count        integer NOT NULL DEFAULT 0,
  release_date      date NOT NULL,
  added_at          timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tracks_duration_positive CHECK (duration_ms > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS tracks_uniq_album_position
  ON tracks (album_id, disc_number, track_number);
CREATE UNIQUE INDEX IF NOT EXISTS tracks_uniq_provider
  ON tracks (provider_name, provider_track_id) WHERE provider_track_id IS NOT NULL;
-- ISRC is normalized to upper-case by the write path (see packages/database/src/sync.ts)
-- so this is a plain unique index, valid on any Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS tracks_isrc_key ON tracks (isrc) WHERE isrc IS NOT NULL AND isrc <> '';
CREATE INDEX IF NOT EXISTS tracks_artist_idx ON tracks (primary_artist_id);
CREATE INDEX IF NOT EXISTS tracks_popularity_idx ON tracks (popularity DESC);
CREATE INDEX IF NOT EXISTS tracks_streamable_idx ON tracks (streamable, status) WHERE streamable;
CREATE INDEX IF NOT EXISTS tracks_added_idx ON tracks (added_at DESC);
CREATE TRIGGER tracks_touch BEFORE UPDATE ON tracks FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

CREATE TABLE IF NOT EXISTS track_genres (
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre_id uuid NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  weight   double precision NOT NULL DEFAULT 1.0,
  PRIMARY KEY (track_id, genre_id)
);
CREATE INDEX IF NOT EXISTS track_genres_genre_idx ON track_genres (genre_id, weight DESC);

CREATE TABLE IF NOT EXISTS album_genres (
  album_id uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  genre_id uuid NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (album_id, genre_id)
);

-- ============================ lyrics ============================

CREATE TABLE IF NOT EXISTS lyrics (
  id          uuid PRIMARY KEY DEFAULT d7_uuid(),
  track_id    uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  language    text NOT NULL DEFAULT 'en',
  provider    text,
  is_synced   boolean NOT NULL DEFAULT false,
  is_placeholder boolean NOT NULL DEFAULT false,
  content     text,
  lines       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lyrics_one_per_track_lang UNIQUE (track_id, language)
);
CREATE INDEX IF NOT EXISTS lyrics_track_idx ON lyrics (track_id);

-- ============================ uploads & licenses ============================

-- Every audio object the platform stores, with provenance + integrity.
CREATE TABLE IF NOT EXISTS uploaded_audio (
  id            uuid PRIMARY KEY DEFAULT d7_uuid(),
  uploader_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id     uuid REFERENCES artists(id) ON DELETE SET NULL,
  album_id      uuid REFERENCES albums(id) ON DELETE SET NULL,
  track_id      uuid REFERENCES tracks(id) ON DELETE SET NULL,
  storage_key   text NOT NULL,
  original_name text,
  mime_type     text NOT NULL,
  byte_size     bigint NOT NULL,
  sha256        text NOT NULL,
  duration_ms   integer,
  sample_rate   integer,
  channels      smallint,
  codec         text,
  scan_status   text NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('pending','clean','infected','error')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uploaded_audio_key UNIQUE (storage_key)
);
-- Content-addressed dedupe: the same bytes cannot be uploaded twice as two tracks.
CREATE UNIQUE INDEX IF NOT EXISTS uploaded_audio_sha_uniq ON uploaded_audio (sha256) WHERE track_id IS NULL;

CREATE TABLE IF NOT EXISTS licenses (
  id             uuid PRIMARY KEY DEFAULT d7_uuid(),
  entity_type    text NOT NULL CHECK (entity_type IN ('track','album','artist')),
  entity_id      uuid NOT NULL,
  holder         text NOT NULL,
  agreement_ref  text,
  territory      text NOT NULL DEFAULT 'worldwide',
  rights         text[] NOT NULL DEFAULT '{stream}',
  start_date     date NOT NULL,
  end_date       date,
  status         text NOT NULL DEFAULT 'licensed'
                   CHECK (status IN ('pending_review','licensed','rejected','expired','revoked')),
  evidence_url   text,
  notes          text,
  recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licenses_entity_uniq UNIQUE (entity_type, entity_id, holder, start_date)
);
CREATE INDEX IF NOT EXISTS licenses_status_idx ON licenses (status, end_date);
