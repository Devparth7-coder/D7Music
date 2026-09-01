# Providers: audio, metadata, and licensing

Referenced by `.env.example` and by `packages/config/src/index.ts`. This is the whole contract for
plugging D7music into a licensed catalogue — no vendor names appear anywhere else in the app.

The rule the design rests on: **a provider descriptor can never make audio playable.** Playability comes
from a `licenses` row plus track `status='published'`. Providers supply catalogue and stream URLs;
`ALLOW_UNLICENSED_STREAM=false` and `REQUIRE_LICENSE_FOR_UPLOAD=true` are what enforce rights.

---

## 1. `MUSIC_PROVIDER` — pick exactly one (the audio side)

| Value | Needs | Behaviour |
| --- | --- | --- |
| `local_library` (default) | nothing | Audio comes from the platform's own catalog: seeded/demo files and creator uploads. No external calls at all. `checks.audioProvider.configured` is `false` and that is correct. |
| `json_http` | `MUSIC_PROVIDER_BASE_URL` + `MUSIC_PROVIDER_API_KEY` | Generic adapter for a private licensed JSON HTTP catalogue. Mapping is configuration (§2), so a new partner does not need a code change. |
| `none` / `off` | nothing | External audio disabled. Everything else keeps working; only uploaded/licensed tracks stream. |
| anything else | — | `NotConfiguredProvider` with the reason `no adapter registered for "<name>". Add one under packages/music-providers/src/audio/ and wire it here.` Boot continues — a typo in this variable degrades the catalog, it does not take the service down. |

`json_http` refuses to construct itself when base URL or key is empty, with those exact reasons visible
in `GET /api/health → checks.metadataProviders` / `/api/config → providers`. Bad JSON in
`MUSIC_PROVIDER_MAP_JSON` or `MUSIC_PROVIDER_ENDPOINTS_JSON` is collected as a reason string
(`MUSIC_PROVIDER_MAP_JSON is not valid JSON: …`) rather than thrown — check `/api/health` after every
mapping change.

Add a real vendor SDK by creating `packages/music-providers/src/audio/<name>.ts` implementing
`MusicProvider` (`packages/music-providers/src/types.ts`) and registering it in
`packages/music-providers/src/registry.ts`. The interface is small on purpose: `searchTracks`,
`getTrack`, `getAlbum`, `getArtist`, `listNewReleases`, `listTrending`, `listArtistReleases`,
`getPlaybackSource`, `healthCheck`, plus a `capabilities` block that tells the sync service what may be
skipped (`lyrics: false` on the HTTP adapter, for instance — the app will not pretend to have them).

---

## 2. `MUSIC_PROVIDER_MAP_JSON` — field mapping

A JSON object of dotted paths. Every key is optional; the default in parentheses is what the adapter
reads if you omit it.

| Key | Default | Meaning |
| --- | --- | --- |
| `listPath` | `items` | Where the array of results sits inside a list response (e.g. `data`, `results.items`). |
| `cursorPath` | `next_cursor` | Pagination cursor. Absent = single page per call. |
| `trackId` | `id` | Provider track id (stored as `provider_track_id`; idempotent upserts key on it). |
| `trackTitle` | `title` | |
| `trackArtistName` | `artist.name` | Falls back to `artist`, then `''`. |
| `trackArtistId` | `artist.id` | |
| `trackDurationMs` | `duration_ms` | Accepts ms, seconds, or ISO 8601 (`PT3M20S`) — see `parseDuration`. |
| `trackExplicit` | `explicit` | Truthiness decides the explicit flag that `explicitFilter` in user preferences then filters on. |
| `trackIsrc` | `isrc` | Used for dedupe across providers. |
| `albumId` | `id` | Within an album payload. |
| `albumTitle` | `title` | |
| `albumDate` | `release_date` | Normalised to a date. |
| `albumImage` | `image_url` | |
| `albumType` | `album_type` | Anything outside `album/single/ep/compilation` becomes `album`. |
| `albumLabel` | `label` | Lands in `albums.label_name`. |
| `albumTracksPath` | `tracks.items` | Embedded track list on an album response. |
| `playbackUrl` | `url` | The short-lived stream URL in a playback response. |
| `playbackExpiresIn` | `expires_in` | Its lifetime in seconds. |
| `popularity` | `popularity` | Feeds the (low-weight) popularity prior in recommendations. |

Not configurable, intentionally: `track_number`, `disc_number`, `preview_url`, `album.id`/`albumId`,
`upc`, `artist.name`-as-fallback. Those paths are read literally by `mapTrack`/`mapAlbum`.

`fullAudioLicensed: true` is set on every mapped track by this adapter — the licence *record* is still
required. The provider asserts "the partner contract covers full audio"; the DB decides whether you
have paperwork for this specific entity.

---

## 3. `MUSIC_PROVIDER_ENDPOINTS_JSON` — path overrides

Keys are the operation, values are paths relative to `MUSIC_PROVIDER_BASE_URL`; `{id}` is substituted
(URI-encoded).

| Key | Default path |
| --- | --- |
| `search` | `/tracks/search` |
| `track` | `/tracks/{id}` |
| `album` | `/albums/{id}` |
| `artist` | `/artists/{id}` |
| `newReleases` | `/albums/new` |
| `trending` | `/tracks/trending` |
| `artistReleases` | `/artists/{id}/albums` |
| `playback` | `/tracks/{id}/stream` |

One wrinkle worth knowing before you wire a partner: `healthCheck()` calls the **`search`** endpoint if
you overrode it, otherwise `GET /health` with `?limit=1&q=a`. So a partner with no `/health` and a
default `search` will report `ok: false` in `GET /api/admin/providers`. Fix it by setting
`endpoints.search` to a cheap real endpoint, or expose `/health`.

Auth is `Authorization: Bearer <MUSIC_PROVIDER_API_KEY>` only. If your partner needs something else,
that is a code change (`ConfigurableProviderOptions.headers`), not an env var — deliberately, so a
misconfigured header cannot silently send our key somewhere unexpected.

Throttling and retries are ours, not theirs: a token bucket at `MUSIC_PROVIDER_RPS` (default 2/s) and
`MUSIC_PROVIDER_MAX_RETRIES` (4) applied only to retryable failures — `429`, `5xx`, network errors —
with exponential backoff and `Retry-After` honoured. Sustained provider errors make the sync run end
`failed` and push `next_run_at` out (visible as "release sync skipped (backoff)" in the log), which is
why the right response to a provider incident is to wait, not to raise `RELEASE_SYNC_PAGE_SIZE`.

Playback URLs are **never persisted**: `getPlaybackSource` returns the partner URL and expiry to the
caller, and the browser is pointed at our own signed `/api/stream/:key`. That indirection is what lets
us swap providers without leaking partner URLs to clients (or into their histories).

---

## 4. `METADATA_PROVIDERS` — discovery only

Comma-separated; currently `musicbrainz`. Metadata providers may fill in release dates, labels, artist
names and external ids, and are polled by the release-sync job. They have **no** audio capability, and
no code path lets a metadata response create a streamable track.

`MUSICBRAINZ_USER_AGENT` must contain a contact address — the adapter warns at boot (`/api/health`
reason string) unless it matches `/contact|mailto|@/`, because the public API policy requires it and
throttles agents without it. Point `MUSICBRAINZ_BASE_URL` at a mirror if you self-host lookups.
Rate-limit yourself: `MUSICBRAINZ` asks for ≤1 request/second, so keep `MUSIC_PROVIDER_RPS`-equivalent
courtesy in mind when you add more metadata sources.

---

## 5. Release sync, end to end

`ReleaseSyncService.runOnce()` (`services/release-sync/src/index.ts`) is used identically by the
scheduler, `npm run sync:releases`, `POST /api/admin/sync`, and the `index_refresh` queue job:

1. Pick the adapter: `providers.audio` (constructed from `MUSIC_PROVIDER*` env, see §1). The
   `music_providers` table is the *registry* the admin panel reads — migration `0012` seeds the four
   built-in names (`local_library`, `licensed_http`, `musicbrainz`, `platform`) so a production
   database has them without `db:seed` — `kind`, `capability`
   (`streaming` | `discovery` | `lyrics`), `enabled`, `rate_limit_rps`, `respects_drm`, `terms_url`,
   `last_success_at`, `last_error` — and `finishSyncRun` writes `last_success_at`/`last_error` back to
   it. It is not the switch that enables or disables an adapter; env is. Keep the two in agreement by
   hand, or the admin provider list will lie to you.
2. Query new releases within `RELEASE_SYNC_LOOKBACK_DAYS`, capped at
   `min(RELEASE_SYNC_MAX_ALBUMS_PER_RUN, 500)` and paged by `min(RELEASE_SYNC_PAGE_SIZE, 100)` — those
   ceilings are in code, so a heroic env value cannot launch an unbounded crawl.
3. `upsertAlbum` / `upsertTrack` (`packages/database/src/sync.ts`) — idempotent, keyed on
   `(provider, provider_album_id)` and `isrc`/`provider_track_id`. `validateTrackInput` rejects
   structurally invalid rows; the error text lands in `sync_runs`.
4. `registerNewRelease` decides whether a *new* album becomes `published` (licence present) or waits as
   a draft, and notifies followers of the artist.
5. Content-hash check: each payload is canonicalised (`stableStringify`, so provider key order cannot
   fake a change) and hashed to 24 chars; a matching hash means the album is *not* rewritten and counts
   in `extra.skippedHashes`. This is what makes an hourly run cheap against a mostly-static catalogue.
6. On success: bump `catalog_version` (invalidates cached shelves), recompute recommendations for up to
   40 affected users, refresh related artists, and write a `sync_runs` row (status
   `succeeded|partial|failed`, `triggered_by`, the fetched/inserted/updated counters, `duration_ms`).
7. On failure: `finishSyncRun` records the error, updates `music_providers.last_error`, and applies
   backoff to `sync_cursors.next_run_at` + `consecutive_failures`.

`--index-only` skips providers entirely and rebuilds local state instead: search documents for up to
5 000 published tracks, a popularity nudge (`0.9·old + 0.1·min(100, ln(1+plays)·22)`) and the
`new_releases.is_trending` flag (≥3 album plays in the last 7 days). That is the run to do after
changing a field mapping, and the run that cannot blame a partner for being slow.

Trending is refreshed by a separate call (`POST /api/admin/trending/refresh`) because it needs a
different provider query and is safe to run at a different cadence.

Importing one album on demand: `POST /api/admin/sync/album` with a provider album id — add `?defer` to
enqueue it (`202`) instead of doing the work in-request; that is what a UI should always do, since a
partner call for a 40-track album can take longer than any sane browser timeout.

### Verifying a provider change

```bash
npm run sync:releases -- --max 5            # small, real, and it prints each provider line
curl -s localhost:4000/api/admin/providers  # healthCheck latency per descriptor
curl -s localhost:4000/api/admin/sync-runs  # last run: counts, status, error text
```

Then confirm the catalogue is actually bigger:
`SELECT count(*) FROM albums WHERE content_source IN ('licensed_provider','partner_feed');`
(those two plus `platform_owned` are the only values the `albums.content_source` CHECK allows).
and that nothing unlicensed snuck in:
`SELECT count(*) FROM tracks t LEFT JOIN licenses l ON l.entity_type='track' AND l.entity_id=t.id WHERE t.status='published' AND l.id IS NULL;`
— zero is the only acceptable answer while `ALLOW_UNLICENSED_STREAM=false`.
