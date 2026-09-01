-- 0011: slug triggers must never produce NULL, and must not depend on a column that can be
-- NULL mid-insert.
--
-- Why this exists: `albums.slug` is NOT NULL and was filled by
--   md5(NEW.artist_id::text || NEW.title_key || NEW.album_type)
-- Inside a BEFORE INSERT trigger any NULL operand makes the whole concatenation NULL, so the slug
-- stayed NULL and the INSERT died on the NOT NULL constraint with a message that named *slug* —
-- three layers away from the actual cause (a provider feed that omitted album_type). Every new album
-- from that feed failed with "null value in column \"slug\"" while the real defect was a missing type.
--
-- The fix is defensive at both ends: upsertAlbum defaults the type (packages/database/src/sync.ts)
-- and the trigger cannot emit NULL whatever a caller passes.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, and slugs that already exist are left alone (the trigger
-- only fills an empty slug). 0001_functions.sql is *not* edited — its checksum is in
-- schema_migrations and rewriting history would break every deployed database.

CREATE OR REPLACE FUNCTION d7_keys_albums() RETURNS trigger AS $$
DECLARE
  base text;
BEGIN
  NEW.title_key := d7_normalize_text(NEW.title);
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base := trim(both '-' from regexp_replace(coalesce(NEW.title_key, ''), '[^a-z0-9]+', '-', 'g'));
    IF base = '' THEN
      base := 'album';
    END IF;
    -- The row identity is (artist, title_key, album_type); hashing those parts keeps the slug stable
    -- across retries of the same import, which an md5(random()) suffix would not.
    NEW.slug := base
      || '-'
      || substring(md5(
           coalesce(NEW.artist_id::text, 'no-artist') || '|' ||
           coalesce(NEW.title_key, '') || '|' ||
           coalesce(NEW.album_type, 'album')
         ) for 8);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION d7_keys_artists() RETURNS trigger AS $$
DECLARE
  base text;
BEGIN
  NEW.name_key := d7_artist_key(NEW.name);
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base := trim(both '-' from regexp_replace(coalesce(NEW.name_key, ''), '[^a-z0-9]+', '-', 'g'));
    IF base = '' THEN
      -- artists.slug is UNIQUE, so two nameless rows must not collide on ''.
      base := 'artist-' || substring(md5(coalesce(NEW.name, '') || '|' || coalesce(NEW.id::text, '')) for 10);
    END IF;
    NEW.slug := base;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
