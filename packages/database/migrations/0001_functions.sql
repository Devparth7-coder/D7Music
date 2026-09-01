-- Shared helpers. All migrations are written to be re-runnable (idempotent).
-- Deliberately depends on NO extension: works on a stock managed Postgres.
-- Optional extensions (pg_trgm for fuzzy match) are attempted separately by the
-- migration runner and are never required; see packages/database/src/migrate.ts.

CREATE OR REPLACE FUNCTION d7_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Case/space-insensitive key used for search + duplicate detection ("Radiohead" == "radiohead").
CREATE OR REPLACE FUNCTION d7_normalize_text(input text) RETURNS text AS $$
SELECT lower(btrim(regexp_replace(coalesce(input, ''), '\s+', ' ', 'g')));
$$ LANGUAGE sql IMMUTABLE;

-- Strip featured artists so "Foo (feat. Bar)" matches "Foo".
CREATE OR REPLACE FUNCTION d7_artist_key(input text) RETURNS text AS $$
SELECT trim(split_part(d7_normalize_text(input), ' feat', 1));
$$ LANGUAGE sql IMMUTABLE;

-- Postgres >= 13 has gen_random_uuid(); this shim keeps older engines happy.
CREATE OR REPLACE FUNCTION d7_uuid() RETURNS uuid AS $$
SELECT gen_random_uuid();
$$ LANGUAGE sql VOLATILE;

-- Postgres forbids user-defined functions inside index *expressions*, so the
-- normalized/dedup keys used by unique indexes are stored in plain columns that
-- these triggers maintain. Cheaper at query time, portable across providers.
CREATE OR REPLACE FUNCTION d7_keys_users() RETURNS trigger AS $$
BEGIN
  NEW.username_key := d7_normalize_text(NEW.username);
  NEW.email_key    := d7_normalize_text(NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION d7_keys_artists() RETURNS trigger AS $$
BEGIN
  NEW.name_key := d7_artist_key(NEW.name);
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := regexp_replace(NEW.name_key, '[^a-z0-9]+', '-', 'g');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION d7_keys_genres() RETURNS trigger AS $$
BEGIN
  NEW.name_key := d7_normalize_text(NEW.name);
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := regexp_replace(NEW.name_key, '[^a-z0-9]+', '-', 'g');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION d7_keys_albums() RETURNS trigger AS $$
BEGIN
  NEW.title_key := d7_normalize_text(NEW.title);
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := substring(md5(NEW.artist_id::text || '|' || NEW.title_key || '|' || NEW.album_type) for 16);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION d7_keys_playlists() RETURNS trigger AS $$
BEGIN
  NEW.title_key := d7_normalize_text(NEW.title);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
