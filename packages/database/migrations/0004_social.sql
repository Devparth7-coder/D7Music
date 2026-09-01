-- ============================ playlists ============================

CREATE TABLE IF NOT EXISTS playlists (
  id           uuid PRIMARY KEY DEFAULT d7_uuid(),
  owner_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  image_url    text,
  visibility   text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public','collaborative')),
  collaborative boolean NOT NULL DEFAULT false,
  is_editorial boolean NOT NULL DEFAULT false,
  -- provenance for auto-generated playlists (mood mixes, AI assistant playlists)
  generated_by text,
  seed_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  title_key    text,
  follower_count integer NOT NULL DEFAULT 0,
  like_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playlists_owner_idx ON playlists (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS playlists_public_idx ON playlists (visibility, follower_count DESC) WHERE visibility = 'public';
CREATE TRIGGER playlists_keys BEFORE INSERT OR UPDATE OF title ON playlists
  FOR EACH ROW EXECUTE FUNCTION d7_keys_playlists();
CREATE UNIQUE INDEX IF NOT EXISTS playlists_owner_title_key ON playlists (owner_id, title_key);
CREATE TRIGGER playlists_touch BEFORE UPDATE ON playlists FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id  uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id     uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  added_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  note         text,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS playlist_tracks_position_key ON playlist_tracks (playlist_id, position);
CREATE INDEX IF NOT EXISTS playlist_tracks_pos_idx ON playlist_tracks (playlist_id, position);
CREATE INDEX IF NOT EXISTS playlist_tracks_track_idx ON playlist_tracks (track_id);

CREATE TABLE IF NOT EXISTS playlist_followers (
  playlist_id uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, user_id)
);

CREATE TABLE IF NOT EXISTS playlist_edit_events (
  id          uuid PRIMARY KEY DEFAULT d7_uuid(),
  playlist_id uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action IN ('add','remove','reorder','rename','artwork','visibility','create','delete')),
  track_id    uuid REFERENCES tracks(id) ON DELETE SET NULL,
  position    integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playlist_edit_events_idx ON playlist_edit_events (playlist_id, created_at DESC);

-- Collaborative playlist permission layer (accept/decline invites, per-member rights).
CREATE TABLE IF NOT EXISTS playlist_collaborators (
  playlist_id uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  text NOT NULL DEFAULT 'edit' CHECK (permission IN ('view','edit','manage')),
  status      text NOT NULL DEFAULT 'accepted' CHECK (status IN ('invited','accepted','declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, user_id)
);

-- ============================ likes / follows ============================

CREATE TABLE IF NOT EXISTS liked_tracks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  source     text,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS liked_tracks_track_idx ON liked_tracks (track_id);
CREATE INDEX IF NOT EXISTS liked_tracks_recent_idx ON liked_tracks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS liked_albums (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_id   uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, album_id)
);

CREATE TABLE IF NOT EXISTS followed_artists (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id  uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, artist_id)
);
CREATE INDEX IF NOT EXISTS followed_artists_artist_idx ON followed_artists (artist_id);
-- artist_followers is the same relationship viewed from the artist side (spec §3 lists both).
CREATE INDEX IF NOT EXISTS artist_followers_count_idx ON followed_artists (artist_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT user_follows_no_self CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS user_follows_followee_idx ON user_follows (followee_id);

-- ============================ listening telemetry ============================

-- Append-only event log. Written in batches from the player, never per second.
CREATE TABLE IF NOT EXISTS playback_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id text,
  track_id     uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  event        text NOT NULL
                 CHECK (event IN ('track_started','track_completed','track_skipped','track_liked',
                                  'track_unliked','track_added_to_playlist','track_replayed','progress_heartbeat')),
  context_type text NOT NULL DEFAULT 'unknown',
  context_id   text,
  position_ms  integer NOT NULL DEFAULT 0,
  duration_ms  integer NOT NULL DEFAULT 0,
  played_ms    integer NOT NULL DEFAULT 0,
  shuffle      boolean NOT NULL DEFAULT false,
  repeat_mode  text NOT NULL DEFAULT 'off' CHECK (repeat_mode IN ('off','all','one')),
  device       text,
  source       text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  ingested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playback_events_user_time_idx ON playback_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS playback_events_track_idx ON playback_events (track_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS playback_events_unclaimed_idx ON playback_events (occurred_at) WHERE user_id IS NULL;

-- Curated, deduplicated history (one row per user+track, refreshed on each play).
CREATE TABLE IF NOT EXISTS listening_history (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id      uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  play_count    integer NOT NULL DEFAULT 1,
  first_played  timestamptz NOT NULL DEFAULT now(),
  last_played   timestamptz NOT NULL DEFAULT now(),
  last_context  text,
  last_context_id text,
  total_listened_ms bigint NOT NULL DEFAULT 0,
  completes     integer NOT NULL DEFAULT 0,
  skips         integer NOT NULL DEFAULT 0,
  score         double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS listening_history_recent_idx ON listening_history (user_id, last_played DESC);
CREATE INDEX IF NOT EXISTS listening_history_score_idx ON listening_history (user_id, score DESC);

-- Denormalized "continue listening" strip, kept fresh by the event pipeline.
CREATE TABLE IF NOT EXISTS recently_played (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  context_type text NOT NULL DEFAULT 'unknown',
  context_id  text,
  position_ms integer NOT NULL DEFAULT 0,
  played_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS recently_played_idx ON recently_played (user_id, played_at DESC);

CREATE TABLE IF NOT EXISTS playback_queue_snapshots (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  context_type text NOT NULL DEFAULT 'unknown',
  context_id  text,
  track_ids   uuid[] NOT NULL DEFAULT '{}',
  index       integer NOT NULL DEFAULT 0,
  position_ms integer NOT NULL DEFAULT 0,
  shuffle     boolean NOT NULL DEFAULT false,
  repeat_mode text NOT NULL DEFAULT 'off',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Daily rollups power admin + creator analytics without scanning the event log.
CREATE TABLE IF NOT EXISTS stats_daily (
  day          date NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type IN ('track','album','artist','genre','platform')),
  entity_id    uuid,
  plays        bigint NOT NULL DEFAULT 0,
  unique_listeners bigint NOT NULL DEFAULT 0,
  completes    bigint NOT NULL DEFAULT 0,
  skips        bigint NOT NULL DEFAULT 0,
  minutes_streamed bigint NOT NULL DEFAULT 0,
  saves        bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS stats_daily_entity_idx ON stats_daily (entity_type, entity_id, day DESC);

CREATE TABLE IF NOT EXISTS stats_daily_country (
  day     date NOT NULL,
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  country text NOT NULL,
  listeners bigint NOT NULL DEFAULT 0,
  plays   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, artist_id, country)
);
