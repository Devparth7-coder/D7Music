-- ============================ search ============================

CREATE TABLE IF NOT EXISTS search_documents (
  entity_type  text NOT NULL CHECK (entity_type IN ('track','album','artist','playlist','genre')),
  entity_id    uuid NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  keywords     text NOT NULL DEFAULT '',
  popularity   double precision NOT NULL DEFAULT 0,
  is_new       boolean NOT NULL DEFAULT false,
  added_at     timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  tsv          tsvector,
  norm_title   text,
  norm_body    text,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS search_docs_tsv_idx ON search_documents USING gin (tsv);
CREATE INDEX IF NOT EXISTS search_docs_norm_title_idx ON search_documents (norm_title);
CREATE UNIQUE INDEX IF NOT EXISTS search_docs_track_title_key ON search_documents (entity_id, entity_type);

CREATE OR REPLACE FUNCTION d7_index_search_document() RETURNS trigger AS $$
DECLARE
  t text;
BEGIN
  t := coalesce(NEW.title,'') || ' ' || coalesce(NEW.body,'') || ' ' || coalesce(NEW.keywords,'');
  NEW.tsv :=
      setweight(to_tsvector('simple', coalesce(NEW.title,'')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.body,'')), 'B')
   || setweight(to_tsvector('simple', coalesce(NEW.keywords,'')), 'C');
  NEW.norm_title := d7_normalize_text(NEW.title);
  NEW.norm_body  := d7_normalize_text(coalesce(NEW.body,'') || ' ' || coalesce(NEW.keywords,''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS search_docs_index ON search_documents;
CREATE TRIGGER search_docs_index BEFORE INSERT OR UPDATE OF title, body, keywords
  ON search_documents FOR EACH ROW EXECUTE FUNCTION d7_index_search_document();

CREATE TABLE IF NOT EXISTS search_queries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  raw_query    text NOT NULL,
  norm_query   text NOT NULL,
  filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_count integer NOT NULL DEFAULT 0,
  clicked_type text,
  clicked_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_queries_user_idx ON search_queries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS search_queries_norm_idx ON search_queries (norm_query);

CREATE TABLE IF NOT EXISTS search_clicks (
  norm_query text NOT NULL,
  entity_type text NOT NULL,
  entity_id  uuid NOT NULL,
  clicks     integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (norm_query, entity_type, entity_id)
);

-- ============================ recommendations ============================

CREATE TABLE IF NOT EXISTS track_features (
  track_id       uuid PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  genre_vector   jsonb NOT NULL DEFAULT '{}'::jsonb,
  artist_ids     uuid[] NOT NULL DEFAULT '{}',
  similar_track_ids uuid[] NOT NULL DEFAULT '{}',
  computed_at    timestamptz NOT NULL DEFAULT now()
);

-- Materialized per-user output of the scoring engine (later replaceable by an ML
-- model that writes the same shape).
CREATE TABLE IF NOT EXISTS recommendations (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  score       double precision NOT NULL,
  rank       integer NOT NULL,
  algorithm   text NOT NULL DEFAULT 'v1_linear_scoring',
  reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS recommendations_rank_idx ON recommendations (user_id, rank);

CREATE TABLE IF NOT EXISTS recommendation_runs (
  id           uuid PRIMARY KEY DEFAULT d7_uuid(),
  users_computed integer NOT NULL DEFAULT 0,
  users_skipped  integer NOT NULL DEFAULT 0,
  tracks_indexed integer NOT NULL DEFAULT 0,
  algorithm    text NOT NULL,
  duration_ms  integer,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS related_artists (
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  related_id  uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  weight      double precision NOT NULL,
  method      text NOT NULL DEFAULT 'co_listening',
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, related_id)
);

-- Mood/energy tags used by the AI assistant + mood shelves (kept separate from genre
-- taxonomy because they are editorial, not genre, metadata).
CREATE TABLE IF NOT EXISTS track_moods (
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  tag      text NOT NULL,
  weight   double precision NOT NULL DEFAULT 1.0,
  PRIMARY KEY (track_id, tag)
);
CREATE INDEX IF NOT EXISTS track_moods_tag_idx ON track_moods (tag, weight DESC);
