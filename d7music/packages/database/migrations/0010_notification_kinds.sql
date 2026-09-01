-- ============================================================
-- 0010 — widen the notification taxonomy.
--
-- 0007 constrained `kind` inline, so Postgres named the check `notifications_kind_check`.
-- Followers and creator-claim decisions both need to notify, and a text column with a list of
-- allowed values is cheaper than a lookup table at this scale.
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (
  kind IN ('artist_new_release','playlist_update','collab_change','recommendation','system','new_follower','claim_approved','claim_denied')
);
