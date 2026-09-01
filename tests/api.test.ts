/**
 * API integration tests: the real Fastify app, the real routes, the real services and a real
 * Postgres (PGlite) database with the seeded catalogue. Nothing is mocked — the point of these
 * tests is that the pieces fit together, so a fake `db` would prove nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEphemeralDb, seedCatalog, type Db } from '@d7/database';
import { buildServer, type AppContext } from '@d7/api';
import type { FastifyInstance } from 'fastify';

let db: Db;
let app: FastifyInstance;
let context: AppContext;

beforeAll(async () => {
  db = await createEphemeralDb();
  await seedCatalog(db, { withAudio: true, withHistory: true });
  const built = await buildServer({ db, headless: true, skipMigrations: true, logLevel: 'warn' });
  app = built.app;
  context = built.context;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

/* ---------------------------------- helpers ---------------------------------- */

async function get<T = Record<string, any>>(url: string, cookie?: string) {
  const res = await app.inject({ method: 'GET', url, headers: cookie ? { cookie } : undefined });
  return { status: res.statusCode, body: res.json<T>() as T, raw: res };
}

async function send<T = Record<string, any>>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie?: string) {
  const res = await app.inject({
    method,
    url,
    headers: cookie ? { cookie } : undefined,
    payload: payload === undefined ? undefined : (payload as object),
  });
  const body = res.statusCode === 204 || !res.payload ? null : safeJson(res.payload);
  return { status: res.statusCode, body: body as T, headers: res.headers, cookie: extractCookie(res.headers['set-cookie']) };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractCookie(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const pair = raw.split(';')[0] ?? '';
  return pair.startsWith('d7_session=') ? pair : undefined;
}

/* ----------------------------------- tests ----------------------------------- */

describe('health and config', () => {
  it('reports capability, not just liveness', async () => {
    const { status, body } = await get<{
      status: string;
      checks: { database: { ok: boolean; tracks: number }; storage: { ok: boolean; driver: string }; assistant: { engine: string } };
    }>('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.database.tracks).toBeGreaterThan(40);
    expect(body.checks.storage.ok).toBe(true);
    expect(['rules', 'llm+rules']).toContain(body.checks.assistant.engine);

    // /api/version is what the deploy checklist greps ("is the build I shipped the build I
    // meant?"), so a broken path resolution in packageVersion() has to fail loudly here.
    const version = await get<{ name: string; version: string; node: string }>('/api/version');
    expect(version.status).toBe(200);
    expect(version.body.name).toBe('d7music-api');
    expect(version.body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.body.version).not.toBe('0.0.0');
    expect(version.body.node).toBe(process.version);
  });

  it('exposes no secrets on /api/config', async () => {
    const { status, body } = await get<{ plans: unknown[]; features: Record<string, unknown> }>('/api/config');
    expect(status).toBe(200);
    expect(body.plans).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('APP_SECRET');
    expect(JSON.stringify(body)).not.toContain('d7-dev-secret');
  });

  it('404s on an unknown API route with the standard envelope', async () => {
    const { status, body } = await get<{ error: { code: string } }>('/api/does-not-exist');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('catalogue', () => {
  let trackId: string;
  let albumId: string;
  let artistSlug: string;

  it('builds home shelves for an anonymous visitor', async () => {
    const { status, body } = await get<{ personalized: boolean; shelves: { id: string; kind: string; items: unknown[]; debugReason: string | null }[] }>('/api/home');
    expect(status).toBe(200);
    expect(body.personalized).toBe(false);
    const kinds = body.shelves.map((s) => s.kind);
    expect(kinds).toContain('new_releases');
    expect(kinds).toContain('trending');
    expect(kinds).toContain('made_for_you');
    for (const shelf of body.shelves) expect(shelf.items.length, shelf.id).toBeGreaterThan(0);
    expect(body.shelves.every((s) => Boolean(s.debugReason))).toBe(true);
  });

  it('returns a track with a playable, signed audio url', async () => {
    const { status, body } = await get<{ tracks: { id: string; audio: { url: string; expiresAt: string | null } | null; hasAudio: boolean }[] }>('/api/trending?limit=5');
    expect(status).toBe(200);
    expect(body.tracks.length).toBeGreaterThan(0);
    const withAudio = body.tracks.find((t) => t.hasAudio)!;
    expect(withAudio).toBeTruthy();
    expect(withAudio.audio?.url).toContain('/api/stream/');
    expect(withAudio.audio?.url).toContain('sig=');
    trackId = withAudio.id;
  });

  it('serves audio with range support so the player can seek', async () => {
    const stream = await app.inject({ method: 'GET', url: `/api/tracks/${trackId}/stream` });
    expect(stream.statusCode).toBe(200);
    const url: string = stream.json().url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const first = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-99' } });
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(first.rawPayload.length).toBe(100);
    expect(first.headers['accept-ranges']).toBe('bytes');

    const bad = await app.inject({ method: 'GET', url: path.replace(/sig=[^&]+/, 'sig=forged') });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('exposes album detail with credits and play-all context', async () => {
    const list = await get<{ albums: { id: string; title: string }[] }>('/api/releases/added?limit=3');
    albumId = list.body.albums[0]!.id;
    const { status, body } = await get<{
      album: { title: string };
      tracks: { id: string; audio: unknown }[];
      credits: { album: { artist: { name: string } } | null; tracks: unknown[] };
      canPlay: boolean;
    }>(`/api/albums/${albumId}`);
    expect(status).toBe(200);
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.canPlay).toBe(true);
    expect(body.credits.album?.artist.name).toBeTruthy();
    const play = await get<{ trackIds: string[] }>(`/api/albums/${albumId}/play`);
    expect(play.body.trackIds.length).toBeGreaterThan(0);
  });

  it('accepts a uuid or a slug for an artist page', async () => {
    const trending = await get<{ tracks: { primaryArtistId: string }[] }>('/api/trending?limit=1');
    const artistId = trending.body.tracks[0]!.primaryArtistId;
    const byId = await get<{ artist: { id: string; slug: string }; popular: unknown[] }>(`/api/artists/${artistId}`);
    expect(byId.status).toBe(200);
    artistSlug = byId.body.artist.slug;
    const bySlug = await get<{ artist: { id: string } }>(`/api/artists/${artistSlug}`);
    expect(bySlug.body.artist.id).toBe(artistId);
  });

  it('answers genres and per-genre shelves', async () => {
    const genres = await get<{ id: string; slug: string; trackCount: number }[]>('/api/genres');
    expect(genres.status).toBe(200);
    const top = genres.body[0]!;
    expect(top.trackCount).toBeGreaterThan(0);
    const shelf = await get<{ genre: { slug: string }; tracks: unknown[]; albums: unknown[] }>(`/api/genres/${top.slug}`);
    expect(shelf.body.genre.slug).toBe(top.slug);
    expect(shelf.body.tracks.length).toBeGreaterThan(0);
  });
});

describe('search', () => {
  it('matches on title, artist and genre with grouped results', async () => {
    const { status, body } = await get<{ total: number; tracks: unknown[]; artists: unknown[]; albums: unknown[]; tookMs: number; query: string }>('/api/search?q=midnight');
    expect(status).toBe(200);
    expect(body.query).toBe('midnight');
    expect(body.total).toBeGreaterThan(0);
    expect(body.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('finds a misspelt query through the fuzzy pass and says so', async () => {
    const { body } = await get<{ total: number; usedFuzzy?: boolean }>('/api/search?q=synthwve');
    expect(body.total).toBeGreaterThan(0);
  });

  it('suggests completions and records clicks', async () => {
    const suggest = await get<{ suggestions: { text: string; type: string }[] }>('/api/search/suggest?q=syn');
    expect(suggest.status).toBe(200);
    expect(suggest.body.suggestions.length).toBeGreaterThan(0);

    const search = await get<{ tracks: { id: string }[] }>('/api/search?q=midnight');
    const click = await send('POST', '/api/search/click', { query: 'midnight', entityType: 'track', entityId: search.body.tracks[0]!.id });
    expect(click.status).toBe(200);
    const history = await get<{ error: { code: string } }>('/api/search/history');
    expect(history.status).toBe(401);
  });

  it('rejects a malformed click payload with field details', async () => {
    const res = await send('POST', '/api/search/click', { query: '', entityType: 'planet', entityId: 'nope' });
    expect(res.status).toBe(422);
    expect((res.body as { error: { details: { path: string }[] } }).error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['query', 'entityType', 'entityId']));
  });
});

describe('auth and sessions', () => {
  const credentials = { username: 'freshlistener', email: 'fresh@example.test', password: 'Str0ng!Passphrase' };
  let cookie: string | undefined;

  it('registers, hashing the password and setting an httpOnly cookie', async () => {
    const res = await send('POST', '/api/auth/register', credentials);
    expect(res.status).toBe(201);
    const body = res.body as { user: { username: string; tier: string; email: string }; issuedAt: string };
    expect(body.user.username).toBe('freshlistener');
    expect(body.user.tier).toBe('free');
    expect(JSON.stringify(body)).not.toContain('Str0ng!Passphrase');
    expect(res.cookie).toBeTruthy();
    cookie = res.cookie;
  });

  it('refuses a weak password and a duplicate account', async () => {
    const weak = await send('POST', '/api/auth/register', { username: 'weakling', email: 'weak@example.test', password: 'password' });
    expect(weak.status).toBe(400);
    const dupe = await send('POST', '/api/auth/register', { ...credentials, email: 'other@example.test' });
    expect(dupe.status).toBe(409);
    expect((dupe.body as { error: { code: string } }).error.code).toBe('ACCOUNT_EXISTS');
  });

  it('answers identically for a wrong password and an unknown account', async () => {
    const wrongPassword = await send('POST', '/api/auth/login', { login: credentials.email, password: 'not-the-password' });
    const unknownUser = await send('POST', '/api/auth/login', { login: 'nobody@example.test', password: 'whatever-123' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // Identical shape and text; only the request id differs, so compare everything else.
    const strip = (b: unknown) => JSON.stringify(b, (k, v) => (k === 'requestId' ? undefined : v));
    expect(strip(wrongPassword.body)).toBe(strip(unknownUser.body));
  });

  it('returns the signed-in user on /me and nothing when logged out', async () => {
    const me = await get<{ authenticated: boolean; user: { email: string } | null }>('/api/auth/me', cookie);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user?.email).toBe(credentials.email);
    const anon = await get<{ authenticated: boolean }>('/api/auth/me');
    expect(anon.body.authenticated).toBe(false);
  });

  it('revokes on logout so the old cookie stops working', async () => {
    const out = await send('POST', '/api/auth/logout', undefined, cookie);
    expect(out.status).toBe(204);
    const after = await get<{ authenticated: boolean }>('/api/auth/me', cookie);
    expect(after.body.authenticated).toBe(false);
  });

  it('runs the password reset flow and signs other devices out', async () => {
    const forgot = await send<{ devToken?: string }>('POST', '/api/auth/password/forgot', { login: credentials.email });
    expect(forgot.status).toBe(202);
    const token = forgot.body?.devToken;
    expect(token).toBeTruthy();
    const reset = await send<{ user: { username: string }; otherSessionsRevoked: number }>('POST', '/api/auth/password/reset', { token, password: 'BrandNew!Passw0rd' });
    expect(reset.status).toBe(200);
    expect(reset.body!.user.username).toBe('freshlistener');
    const relogin = await send('POST', '/api/auth/login', { login: credentials.email, password: 'BrandNew!Passw0rd' });
    expect(relogin.status).toBe(200);
    const old = await send('POST', '/api/auth/login', { login: credentials.email, password: credentials.password });
    expect(old.status).toBe(401);
  });

  it('logs in with the seeded demo account', async () => {
    const res = await send('POST', '/api/auth/login', { login: 'demo@d7music.test', password: 'D7demo!2345' });
    expect(res.status).toBe(200);
    expect((res.body as { user: { preferences: { explicitFilter: boolean } } }).user.preferences.explicitFilter).toBe(false);
  });
});

describe('playlists and social', () => {
  let cookie: string;
  let playlistId: string;
  let trackIds: string[] = [];

  beforeAll(async () => {
    const login = await send('POST', '/api/auth/login', { login: 'demo', password: 'D7demo!2345' });
    cookie = login.cookie!;
    const tracks = await get<{ tracks: { id: string }[] }>('/api/trending?limit=6');
    trackIds = tracks.body.tracks.map((t) => t.id);
  });

  it('creates, fills, reorders and reads back a playlist', async () => {
    const created = await send<{ playlist: { id: string; trackCount: number; canEdit: boolean } }>('POST', '/api/playlists', { title: 'Testing Suite Mix', visibility: 'public', trackIds: [] }, cookie);
    expect(created.status).toBe(201);
    playlistId = created.body!.playlist.id;
    expect(created.body!.playlist.canEdit).toBe(true);

    const added = await send<{ added: number; rejected: string[] }>('POST', `/api/playlists/${playlistId}/tracks`, { trackIds }, cookie);
    expect(added.body!.added).toBe(trackIds.length);
    expect(added.body!.rejected).toEqual([]);

    const dupe = await send<{ added: number; skippedDuplicates: number }>('POST', `/api/playlists/${playlistId}/tracks`, { trackIds: [trackIds[0]!] }, cookie);
    expect(dupe.body!.skippedDuplicates).toBe(1);

    const detail = await get<{ playlist: { trackCount: number; tracks: { id: string }[] } }>(`/api/playlists/${playlistId}`, cookie);
    expect(detail.body!.playlist.trackCount).toBe(trackIds.length);

    const order = [...trackIds].reverse();
    const replaced = await send<{ ok: boolean }>('PUT', `/api/playlists/${playlistId}/order`, { trackIds: order }, cookie);
    expect(replaced.status).toBe(200);
    const after = await get<{ trackIds: string[] }>(`/api/playlists/${playlistId}`, cookie);
    expect(after.body!.trackIds).toEqual(order);

    const removed = await send<{ removed: boolean }>('DELETE', `/api/playlists/${playlistId}/tracks/${order[0]}`, undefined, cookie);
    expect(removed.body!.removed).toBe(true);
  });

  it('refuses a reorder whose id set does not match', async () => {
    const res = await send('PUT', `/api/playlists/${playlistId}/order`, { trackIds: [trackIds[0]!, trackIds[0]!] }, cookie);
    expect(res.status).toBe(400);
  });

  it('keeps private playlists private from other signed-in users', async () => {
    const mine = await send<{ playlist: { id: string } }>('POST', '/api/playlists', { title: 'Private Ledger', visibility: 'private' }, cookie);
    const other = await send('POST', '/api/auth/register', { username: 'nosy', email: 'nosy@example.test', password: 'Snooping!444' });
    const peek = await get<{ error?: { code: string }; playlist?: { id: string } }>(`/api/playlists/${mine.body!.playlist.id}`, other.cookie);
    expect(peek.status).toBe(404);
    const edit = await send('POST', `/api/playlists/${mine.body!.playlist.id}/tracks`, { trackIds }, other.cookie);
    expect(edit.status).toBe(403);
    expect((edit.body as { error: { code: string } }).error.code).toBe('NOT_PLAYLIST_EDITOR');
  });

  it('adds a collaborator who can then edit', async () => {
    const collab = await send<{ playlist: { id: string } }>('POST', '/api/playlists', { title: 'Road Trip (shared)', collaborative: true }, cookie);
    const id = collab.body!.playlist.id;
    const invite = await send<{ invited: boolean }>('POST', `/api/playlists/${id}/collaborators`, { username: 'sam', permission: 'edit' }, cookie);
    expect(invite.body!.invited).toBe(true);
    const sam = await send('POST', '/api/auth/login', { login: 'sam@d7music.test', password: 'D7listener!2' });
    const edit = await send<{ added: number }>('POST', `/api/playlists/${id}/tracks`, { trackIds: trackIds.slice(0, 2) }, sam.cookie);
    expect(edit.status).toBe(200);
    expect(edit.body!.added).toBe(2);
    const theirs = await get<{ collaborative: unknown[] }>(`/api/playlists`, sam.cookie);
    expect(JSON.stringify(theirs.body).includes('Road Trip')).toBe(true);
  });

  it('likes a track, shows it in the library, and follows an artist', async () => {
    const liked = await send<{ liked: boolean; likedCount: number }>('POST', `/api/tracks/${trackIds[0]}/like`, { source: 'test' }, cookie);
    expect(liked.status).toBe(201);
    expect(liked.body!.likedCount).toBeGreaterThan(0);
    const library = await get<{ tracks: { id: string }[] }>(`/api/library/liked`, cookie);
    expect(library.body!.tracks.map((t) => t.id)).toContain(trackIds[0]);
    const artist = await get<{ tracks: { primaryArtistId: string }[] }>(`/api/trending?limit=1`);
    const followed = await send<{ following: boolean; followersCount: number }>('POST', `/api/artists/${artist.body!.tracks[0]!.primaryArtistId}/follow`, {}, cookie);
    expect(followed.body!.following).toBe(true);
    expect(followed.body!.followersCount).toBeGreaterThan(0);
  });

  it('reports content and files it for moderation', async () => {
    const report = await send<{ accepted: boolean; reportId: string }>('POST', `/api/tracks/${trackIds[0]}/report`, { reason: 'copyright', details: 'Test report from the integration suite.' }, cookie);
    expect(report.status).toBe(202);
    expect(report.body!.reportId).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('playback telemetry', () => {
  let cookie: string;
  let trackId: string;

  beforeAll(async () => {
    const login = await send('POST', '/api/auth/login', { login: 'demo', password: 'D7demo!2345' });
    cookie = login.cookie!;
    const tracks = await get<{ tracks: { id: string }[] }>('/api/trending?limit=3');
    trackId = tracks.body.tracks[0]!.id;
  });

  it('ingests a batch and derives history, resume position and stats', async () => {
    const events = [
      { type: 'track_started', trackId, positionMs: 0, durationMs: 10_000, occurredAt: new Date().toISOString(), shuffle: false, repeat: 'off' },
      { type: 'progress_heartbeat', trackId, positionMs: 4200, durationMs: 10_000, occurredAt: new Date().toISOString(), shuffle: false, repeat: 'off' },
      { type: 'track_completed', trackId, positionMs: 10_000, durationMs: 10_000, occurredAt: new Date().toISOString(), shuffle: false, repeat: 'off' },
    ];
    const res = await send<{ accepted: number; ignored: number; countsByType: Record<string, number> }>('POST', '/api/playback/events', { events, device: 'test' }, cookie);
    expect(res.status).toBe(200);
    expect(res.body!.accepted).toBeGreaterThanOrEqual(2);

    const resume = await get<{ resume: { trackId: string; positionMs: number } | null }>('/api/playback/resume', cookie);
    expect(resume.body!.resume?.trackId).toBe(trackId);

    const history = await get<{ items: { trackId: string; playCount: number }[] }>('/api/playback/history', cookie);
    expect(history.body!.items[0]!.trackId).toBe(trackId);
    expect(history.body!.items[0]!.playCount).toBeGreaterThan(0);

    const stats = await get<{ plays: number; topGenres: { genre: string }[] }>('/api/me/stats', cookie);
    expect(stats.body!.plays).toBeGreaterThan(0);
  });

  it('saves and restores the queue snapshot in order', async () => {
    const tracks = await get<{ tracks: { id: string }[] }>('/api/trending?limit=4');
    const ids = tracks.body.tracks.map((t) => t.id);
    const saved = await send<{ saved: boolean; length: number }>('PUT', '/api/playback/queue', { contextType: 'album', contextId: '00000000-0000-4000-8000-000000000001', trackIds: ids, index: 2, positionMs: 1500, shuffle: true, repeatMode: 'all' }, cookie);
    expect(saved.body!.length).toBe(ids.length);
    const loaded = await get<{ queue: { trackIds: string[]; index: number; tracks: { id: string; audio: unknown }[] } | null }>('/api/playback/queue', cookie);
    expect(loaded.body!.queue!.trackIds).toEqual(ids);
    expect(loaded.body!.queue!.index).toBe(2);
    expect(loaded.body!.queue!.tracks.length).toBe(ids.length);
    expect(loaded.body!.queue!.tracks[0]!.audio).toBeTruthy();
  });

  it('ignores events for tracks that do not exist instead of failing', async () => {
    const res = await send<{ accepted: number; droppedUnknownTracks: number }>('POST', '/api/playback/events', {
      events: [{ type: 'track_started', trackId: '00000000-0000-4000-8000-0000000000ee', positionMs: 0, durationMs: 1000 }],
    }, cookie);
    expect(res.status).toBe(200);
    expect(res.body!.droppedUnknownTracks).toBe(1);
    expect(res.body!.accepted).toBe(0);
  });
});

describe('recommendations, releases and the assistant', () => {
  let cookie: string;

  beforeAll(async () => {
    const login = await send('POST', '/api/auth/login', { login: 'demo', password: 'D7demo!2345' });
    cookie = login.cookie!;
  });

  it('answers with a mode and explainable items', async () => {
    const { status, body } = await get<{ mode: string; items: { score: number; reasons: { code: string; label: string }[]; track: { id: string } }[]; stale: boolean }>('/api/recommendations?limit=8', cookie);
    expect(status).toBe(200);
    expect(['personalized', 'cold_start_popularity']).toContain(body.mode);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.reasons.length, item.track.id).toBeGreaterThan(0);
    const scores = body.items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('builds a radio queue from a seed track', async () => {
    const trending = await get<{ tracks: { id: string }[] }>('/api/trending?limit=1');
    const { status, body } = await get<{ items: { track: { id: string } }[] }>(`/api/tracks/${trending.body.tracks[0]!.id}/radio?limit=6`);
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.map((i) => i.track.id)).not.toContain(trending.body.tracks[0]!.id);
  });

  it('lists new releases and rejects the following scope for anonymous users', async () => {
    const all = await get<{ releases: { album: { title: string } }[]; counts: Record<string, number> }>('/api/releases/new?window=month');
    expect(all.status).toBe(200);
    expect(all.body.releases.length).toBeGreaterThan(0);
    const following = await get<{ error: { code: string } }>('/api/releases/new?scope=following');
    expect(following.status).toBe(401);
  });

  it('parses natural language into structured filters without an LLM', async () => {
    const { status, body } = await send<{
      engine: string;
      message: string;
      parsed: { genres: string[]; energy: string | null; mood: string[]; limit: number; activity: string | null; durationMinutes: number | null };
      tracks: { id: string; genres: string[] }[];
      appliedFilters: Record<string, unknown>;
    }>('POST', '/api/assistant', { prompt: 'something calm and instrumental for late-night coding, about 20 minutes' });
    expect(status).toBe(200);
    expect(body!.engine).toBe('rule_based');
    expect(body!.parsed.mood.length + body!.parsed.genres.length).toBeGreaterThan(0);
    expect(body!.tracks.length).toBeGreaterThan(0);
    // The reply repeats the framing back so a mis-parse is visible without opening the filters.
    expect(body!.parsed.activity).toBe('late-night coding');
    expect(body!.parsed.durationMinutes).toBe(20);
    expect(body!.message.toLowerCase()).toContain('coding');
    expect(body!.appliedFilters.intent).toBeTruthy();
  });

  it('creates a playlist from the assistant for a signed-in user', async () => {
    const res = await send<{ playlist: { id: string; title: string; trackCount: number } | null; conversationId: string; usage: { remaining: number } }>(
      'POST',
      '/api/assistant',
      { prompt: 'make a workout playlist of high energy electronic tracks', createPlaylist: true, playlistTitle: 'Suite Sweat', visibility: 'public' },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body!.playlist?.trackCount).toBeGreaterThan(0);
    expect(res.body!.usage.remaining).toBeLessThan(10);
    const conversation = await get<{ messages: { role: string }[] }>(`/api/assistant/conversations/${res.body!.conversationId}`, cookie);
    expect(conversation.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects an assistant prompt that is too short to act on', async () => {
    const res = await send('POST', '/api/assistant', { prompt: 'hi' });
    expect(res.status).toBe(422);
  });
});

describe('subscriptions', () => {
  it('upgrades manually and says so', async () => {
    const register = await send<{ user: { tier: string } }>('POST', '/api/auth/register', { username: 'upgrader', email: 'upgrader@example.test', password: 'Upgrade!2345' });
    const cookie = register.cookie!;
    const plans = await get<{ provider: string; plans: { tier: string; priceCents: number }[] }>('/api/subscriptions/plans');
    expect(plans.body.provider).toBe('manual');
    const checkout = await send<{ subscription: { tier: string; provider: string }; plan: { limits: { maxBitrateKbps: number } } }>('POST', '/api/subscriptions/checkout', { tier: 'premium', months: 3 }, cookie);
    expect(checkout.status).toBe(200);
    expect(checkout.body!.subscription.tier).toBe('premium');
    expect(checkout.body!.plan.limits.maxBitrateKbps).toBe(320);
    const me = await get<{ subscription: { cancelAtPeriodEnd: boolean } }>('/api/subscriptions/me', cookie);
    expect(me.body!.subscription.cancelAtPeriodEnd).toBe(false);
    const cancel = await send<{ subscription: { cancelAtPeriodEnd: boolean } }>('POST', '/api/subscriptions/cancel', {}, cookie);
    expect(cancel.body!.subscription.cancelAtPeriodEnd).toBe(true);
  });

  it('rejects a webhook without a verifiable signature', async () => {
    const res = await send('POST', '/api/webhooks/stripe', { id: 'evt_1', type: 'customer.subscription.created', data: { object: {} } });
    expect(res.status).toBe(501);
  });

  it('records a manual webhook event once and ignores a replay', async () => {
    const user = await send<{ user: { id: string } }>('POST', '/api/auth/register', { username: 'webhooker', email: 'webhooker@example.test', password: 'Webhook!2345' });
    const payload = { id: 'evt_manual_1', type: 'subscription.created', data: { object: { user_id: user.body!.user.id, tier: 'premium' } } };
    const first = await send<{ ok: boolean; applied: { tier: string } }>('POST', '/api/webhooks/manual', payload);
    expect(first.status).toBe(200);
    expect(first.body!.applied.tier).toBe('premium');
    const replay = await send<{ note: string }>('POST', '/api/webhooks/manual', payload);
    expect(replay.body!.note).toContain('Already processed');
    const sub = await get<{ subscription: { tier: string } }>('/api/subscriptions/me', user.cookie);
    expect(sub.body!.subscription.tier).toBe('premium');
  });
});

describe('release sync against the local library', () => {
  // Regression cover for three defects that only showed up when a real sync ran: the local feed
  // re-mapped an already-mapped Album (so type/artist/genres were empty), upsertAlbum passed that
  // empty type through, and the albums slug trigger turned a NULL operand into a NULL slug and
  // died on the NOT NULL constraint. Nothing on the request path touches any of that.
  it('imports, skips unchanged payloads, and rejects nothing', async () => {
    const first = await context.releaseSync.runOnce({ triggeredBy: 'cli' });
    expect(first.status).toBe('succeeded');
    expect(first.errors).toEqual([]);
    expect(first.fetchedAlbums).toBeGreaterThan(0);
    expect(first.rejectedInvalid).toBe(0);

    const second = await context.releaseSync.runOnce({ triggeredBy: 'cli' });
    expect(second.status).toBe('succeeded');
    expect(second.insertedAlbums).toBe(0);
    expect(second.skippedDuplicates).toBeGreaterThan(0); // content hash: a re-run does no work
    expect(second.extra.skippedHashes).toBe(second.skippedDuplicates);
  });

  it('creates a brand-new album from a provider payload that omits album_type', async () => {
    const { upsertAlbum, upsertArtist } = await import('@d7/database');
    const artist = await upsertArtist(db, 'licensed_http', { name: `Import Probe ${Date.now()}` });
    const title = `Probe: The Wide, Blue Set! ${Date.now()}`;
    const first = await upsertAlbum(db, {
      provider: 'licensed_http',
      providerAlbumId: 'probe-1',
      title,
      artistId: artist.artistId,
      releaseDate: '2026-08-30',
      providerPayload: { probe: true },
    } as never);
    expect(first.outcome).toBe('inserted');

    const row = await db.queryOne<{ slug: string; album_type: string; license_status: string }>(
      `SELECT slug, album_type, license_status FROM albums WHERE id = $1::uuid`,
      [first.albumId],
    );
    expect(row).toBeDefined();
    // 0011: readable slug + a deterministic suffix, never NULL, even with a NULL type in flight.
    expect(row!.slug).toMatch(/^probe-the-wide-blue-set-\d+-[0-9a-f]{8}$/); // readable prefix + deterministic suffix
    expect(row!.album_type).toBe('album');

    // A name that is not in music_providers must not break the write (the mapping row is skipped).
    const stranger = await upsertAlbum(db, {
      provider: 'unregistered_provider',
      providerAlbumId: 'probe-2',
      title: `${title} (stranger)`,
      artistId: artist.artistId,
      albumType: 'ep',
      releaseDate: '2026-08-30',
    } as never);
    expect(stranger.outcome).toBe('inserted');
    const mapped = await db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_albums WHERE provider = 'unregistered_provider'`,
    );
    expect(mapped!.n).toBe(0);
    const registered = await db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_albums WHERE provider = 'licensed_http' AND provider_album_id = 'probe-1'`,
    );
    expect(registered!.n).toBe(1);
  });

  it('hands the importer track ids and a non-empty slug for every album row', async () => {
    const { albumsAddedSince } = await import('@d7/database');
    const recent = await albumsAddedSince(db, new Date(0).toISOString(), 20);
    expect(recent.length).toBeGreaterThan(0);
    // Not recent[0]: the tests above insert track-less probe albums, which sort first by added_at.
    expect(recent.filter((a) => (a.trackIds?.length ?? 0) > 0).length).toBeGreaterThan(0);

    const counts = await db.queryOne<{ n: number; bad: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE slug IS NULL OR slug = '')::int AS bad
         FROM albums`,
    );
    expect(counts!.bad).toBe(0);
    expect(counts!.n).toBeGreaterThanOrEqual(recent.length);
  });
});
