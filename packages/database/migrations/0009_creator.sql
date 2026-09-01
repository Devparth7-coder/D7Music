-- ============================================================
-- 0009 — creator claims.
--
-- An artist page is created by catalog sync, so a human needs a way to claim one.
-- The claim (not the `users.role`) is what grants edit rights over an artist and their
-- releases; admins approve or deny it, and approval is what sets verified_kind
-- = 'creator_claim' on the artist row.
-- ============================================================

CREATE TABLE IF NOT EXISTS artist_claims (
  id           uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id    uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  evidence_url text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT artist_claims_uniq UNIQUE (user_id, artist_id)
);
CREATE INDEX IF NOT EXISTS artist_claims_status_idx ON artist_claims (status, created_at DESC);
CREATE INDEX IF NOT EXISTS artist_claims_artist_idx ON artist_claims (artist_id);

-- A user may hold an approved claim on at most one row per artist; partial unique index
-- keeps denied/re-filed claims from blocking a later approval.
CREATE UNIQUE INDEX IF NOT EXISTS artist_claims_approved_uniq ON artist_claims (artist_id) WHERE status = 'approved';

-- The provider registry is configuration data, and creator uploads are recorded as
-- tracks(provider_name='platform'). Register that pseudo-provider here so uploads work on a
-- fresh database, without waiting for `npm run db:seed`.
INSERT INTO music_providers (name, kind, enabled, capability, base_url, auth_mode, default_page_size, rate_limit_rps, respects_drm, notes)
VALUES ('platform','audio',true,'streaming',NULL,'none',50,0,true,'D7music-owned audio: creator uploads and platform-licensed masters, served from our own storage.')
ON CONFLICT (name) DO NOTHING;

-- A creator may keep several drafts of the same upload; the review queue needs the note.
ALTER TABLE uploaded_audio ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE uploaded_audio ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
