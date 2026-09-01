-- 0012: register the built-in provider names in every database, not just seeded ones.
--
-- `provider_albums.provider`, `provider_tracks.provider`, `provider_health.provider`,
-- `sync_cursors.provider` and `new_releases.provider` all reference music_providers(name). Those
-- rows used to be created only by `db:seed` — which must never run against production — so a fresh
-- production database had an empty registry and the *first* album import failed with
--   insert or update on table "provider_albums" violates foreign key constraint "provider_albums_provider_fkey"
-- i.e. a licensed-catalogue deployment could not import anything at all.
--
-- These four rows are the platform's own adapters (they exist because the code does), so they belong
-- to the schema baseline. Partner-specific rows (`licensed_partner_example`, a real vendor) are
-- still deployment configuration: an operator or the seeder adds them, and `MUSIC_PROVIDER=json_http`
-- registers its adapter under `licensed_http`, which is why that name appears here.
--
-- Idempotent and non-destructive: DO NOTHING, so an operator's edits to `enabled`, `notes`,
-- `terms_url` or the rate limit survive every future migration.

INSERT INTO music_providers (name, kind, enabled, capability, rate_limit_rps, respects_drm, notes, default_page_size)
VALUES
  ('local_library', 'audio',   true,  'streaming', 20, true,
   'Platform-owned uploads and this deployment''s own catalog. Streams are served by our API with signed, range-capable URLs.', 50),
  ('licensed_http', 'audio',   false, 'streaming',  2, true,
   'Adapter built from MUSIC_PROVIDER=json_http for a licensed partner catalogue API. Enable it by configuring the base URL and key; the field mapping lives in docs/PROVIDERS.md.', 50),
  ('musicbrainz',   'metadata', true, 'discovery',  1, true,
   'Open release metadata (CC-0). Metadata only: it can never make audio playable here.', 25),
  ('platform',      'audio',    true, 'streaming', 20, true,
   'Rows this platform owns directly (creator uploads, editorial entries) as opposed to a feed.', 50)
ON CONFLICT (name) DO NOTHING;
