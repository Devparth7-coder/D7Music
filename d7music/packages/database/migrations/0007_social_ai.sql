-- ============================ notifications ============================

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL
                CHECK (kind IN ('artist_new_release','playlist_update','collab_change','recommendation','system')),
  title       text NOT NULL,
  body        text,
  image_url   text,
  action_href text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_dedupe UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS content_reports (
  id          uuid PRIMARY KEY DEFAULT d7_uuid(),
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('track','album','artist','playlist')),
  entity_id   uuid NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('copyright','licensing','offensive','spam','impersonation','other')),
  details     text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','actioned','dismissed')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS content_reports_status_idx ON content_reports (status, created_at DESC);

-- ============================ AI assistant ============================

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id         uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              uuid PRIMARY KEY DEFAULT d7_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text NOT NULL,
  parsed_query    jsonb,
  engine          text,
  model           text,
  track_ids       uuid[] NOT NULL DEFAULT '{}',
  rejected        jsonb NOT NULL DEFAULT '[]'::jsonb,
  playlist_id     uuid REFERENCES playlists(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_messages_conv_idx ON assistant_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS assistant_usage (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        date NOT NULL,
  requests   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ============================ multi-artist credits ============================

CREATE TABLE IF NOT EXISTS track_artists (
  track_id     uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id    uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  credit_type  text NOT NULL DEFAULT 'primary'
                 CHECK (credit_type IN ('primary','featured','composer','lyricist','producer','remixer')),
  position     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, artist_id, credit_type)
);
CREATE INDEX IF NOT EXISTS track_artists_artist_idx ON track_artists (artist_id);

-- ============================ downloads (premium offline) ============================

CREATE TABLE IF NOT EXISTS offline_downloads (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  device_id  text,
  PRIMARY KEY (user_id, track_id)
);
