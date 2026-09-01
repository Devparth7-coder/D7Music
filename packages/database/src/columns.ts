/** Reusable column projections (kept separate to avoid import cycles). */

export const ALBUM_RELEASE_COLS = `
  al.id, al.title, al.slug, al.album_type, to_char(al.release_date, 'YYYY-MM-DD') AS release_date,
  al.added_at, al.image_url, al.primary_color, al.label_name, al.copyright_note, al.upc,
  al.popularity, al.content_source, al.license_status, al.status, al.pitch, al.explicit,
  jsonb_build_object('id', ar.id, 'name', ar.name, 'verified', ar.verified) AS artist_json,
  ar.id AS primary_artist_id,
  (SELECT count(*) FROM tracks t WHERE t.album_id = al.id AND t.status = 'published')::int AS track_count,
  coalesce((SELECT sum(t.duration_ms) FROM tracks t WHERE t.album_id = al.id AND t.status = 'published'), 0)::int AS duration_ms,
  coalesce((SELECT jsonb_agg(g.slug) FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = al.id), '[]'::jsonb) AS genre_slugs,
  coalesce((SELECT jsonb_agg(t.id ORDER BY t.disc_number, t.track_number) FROM tracks t WHERE t.album_id = al.id AND t.status='published' LIMIT 60), '[]'::jsonb) AS track_ids,
  coalesce((SELECT jsonb_agg(DISTINCT ta.artist_id) FROM tracks t JOIN track_artists ta ON ta.track_id = t.id WHERE t.album_id = al.id), '[]'::jsonb) AS artist_ids
`;
