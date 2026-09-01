/**
 * Seed data.
 *
 * Everything generated here is original to this project: fictional artists, fictional
 * titles, cover art generated from hashes, and audio synthesized in-process
 * (`@d7/audio-storage/synth`). No third-party recording, cover, or sample is included,
 * so the repository can be run and shared without any rights questions.
 *
 * The listening history is written through `ingestPlaybackEvents` (the real pipeline)
 * rather than INSERTing convenience rows — so the seed also exercises the analytics path.
 */
import { env, resolveDataPath } from '@d7/config';
import { LocalStorageProvider, estimateFeatures, synthesizeTrack, type SynthGenre } from '@d7/audio-storage';
import { generateArtworkSvg } from '@d7/ui';
import type { Db } from './client.js';
import { ingestPlaybackEvents } from './telemetry.js';
import { upsertArtist, upsertAlbum, upsertTrack, registerNewRelease, touchSearchDocument } from './sync.js';
import { rebuildSearchIndex } from './searchIndex.js';
import { createPlaylist, addTracks } from './playlists.js';
import { createUser, setArtistFollow, setLikedTrack } from './social.js';
import { hashPassword } from './auth-hash.js';

interface SeedTrack {
  title: string;
  seconds: number;
  genre: SynthGenre;
  explicit?: boolean;
  isrc?: string;
  moods?: string[];
}
interface SeedAlbum {
  title: string;
  type: 'album' | 'single' | 'ep';
  release: string;
  addedDaysAgo?: number;
  label?: string;
  tracks: SeedTrack[];
}
interface SeedArtist {
  name: string;
  bio: string;
  genres: string[];
  verified?: 'platform' | 'label' | 'creator_claim';
  popularity: number;
  artistUsername?: string;
  albums: SeedAlbum[];
}

const CATALOG: SeedArtist[] = [
  {
    name: 'Vela Nine',
    bio: 'Production project operating out of a converted textile mill; breakbeats, sub-bass, and field recordings from the harbour.',
    genres: ['drum-and-bass', 'techno'],
    verified: 'creator_claim',
    popularity: 74,
    artistUsername: 'vela.nine',
    albums: [
      {
        title: 'Ninth Signal',
        type: 'album',
        release: '2026-08-29',
        addedDaysAgo: 1,
        label: 'Harbourwork',
        tracks: [
          { title: 'Launch Window', seconds: 11, genre: 'drumandbass', moods: ['energy', 'night'] },
          { title: 'Cold Ignition', seconds: 10, genre: 'drumandbass', moods: ['energy', 'focus'] },
          { title: 'Tidebreaker', seconds: 12, genre: 'drumandbass', moods: ['energy'] },
          { title: 'Reentry', seconds: 9, genre: 'techno', moods: ['night', 'energy'] },
        ],
      },
      {
        title: 'Low Orbit Sessions',
        type: 'ep',
        release: '2026-05-15',
        addedDaysAgo: 60,
        label: 'Harbourwork',
        tracks: [
          { title: 'Perigee', seconds: 10, genre: 'drumandbass', moods: ['focus'] },
          { title: 'Aphelion', seconds: 11, genre: 'techno', moods: ['night'] },
          { title: 'Drift Correction', seconds: 9, genre: 'drumandbass', moods: ['energy'] },
        ],
      },
    ],
  },
  {
    name: 'Nova Kestrel',
    bio: 'Analog synthesist building arpeggiated night-drive music on a wall of secondhand machines.',
    genres: ['synthwave', 'electronic'],
    verified: 'label',
    popularity: 88,
    artistUsername: 'nova.kestrel',
    albums: [
      {
        title: 'Chromatic Drift',
        type: 'album',
        release: '2026-07-24',
        addedDaysAgo: 6,
        label: 'Neon Cartography',
        tracks: [
          { title: 'Freeway of Glass', seconds: 12, genre: 'synthwave', isrc: 'USXY12600001', moods: ['night', 'energy'] },
          { title: 'Chrome Rain', seconds: 11, genre: 'synthwave', moods: ['night', 'sad'] },
          { title: 'Signal Lost', seconds: 10, genre: 'synthwave', moods: ['focus', 'night'] },
          { title: 'Turbo Lullaby', seconds: 11, genre: 'synthwave', moods: ['romantic', 'night'] },
          { title: 'Afterglow Protocol', seconds: 9, genre: 'synthwave', moods: ['calm', 'night'] },
        ],
      },
      {
        title: 'Static Bloom',
        type: 'ep',
        release: '2026-03-11',
        addedDaysAgo: 170,
        label: 'Neon Cartography',
        tracks: [
          { title: 'Bloom Cycle', seconds: 10, genre: 'synthwave', moods: ['happy'] },
          { title: 'Interference', seconds: 9, genre: 'techno', moods: ['focus'] },
          { title: 'Paper Antenna', seconds: 11, genre: 'synthwave', moods: ['calm'] },
        ],
      },
    ],
  },
  {
    name: 'Yuna Fields',
    bio: 'Prepared piano, tape hiss, and long silences. Writes for empty buildings.',
    genres: ['ambient', 'neo-classical'],
    popularity: 61,
    albums: [
      {
        title: 'Quiet Machines',
        type: 'album',
        release: '2026-08-27',
        addedDaysAgo: 2,
        tracks: [
          { title: 'Room Tone', seconds: 12, genre: 'ambient', moods: ['calm', 'sleep', 'focus'] },
          { title: 'Paper Weather', seconds: 11, genre: 'classical', moods: ['sad', 'calm'] },
          { title: 'Slow Dynamo', seconds: 13, genre: 'ambient', moods: ['focus', 'calm'] },
          { title: 'Window, Unopened', seconds: 10, genre: 'ambient', moods: ['sad', 'sleep'] },
        ],
      },
      {
        title: 'Letters to Rain',
        type: 'single',
        release: '2026-07-02',
        addedDaysAgo: 30,
        tracks: [{ title: 'Letters to Rain', seconds: 11, genre: 'ambient', moods: ['calm', 'romantic'] }],
      },
    ],
  },
  {
    name: 'Marrow & Pine',
    bio: 'Two siblings, one guitar, a four-track in a barn outside the city.',
    genres: ['indie-folk', 'singer-songwriter'],
    popularity: 55,
    albums: [
      {
        title: 'Longwave Hymns',
        type: 'album',
        release: '2026-08-14',
        addedDaysAgo: 9,
        tracks: [
          { title: 'Cold Kitchen', seconds: 10, genre: 'jazz', moods: ['sad', 'focus'] },
          { title: 'The Ferry Song', seconds: 11, genre: 'classical', moods: ['calm'] },
          { title: 'Birch & Bone', seconds: 9, genre: 'jazz', moods: ['sad'] },
          { title: 'Harvest Debt', seconds: 12, genre: 'classical', moods: ['reflective'] },
        ],
      },
    ],
  },
  {
    name: 'Kito Verde',
    bio: 'Producer-DJ routing Brazilian percussion through modular synthesis.',
    genres: ['house', 'afro-latin'],
    verified: 'platform',
    popularity: 79,
    artistUsername: 'kito.verde',
    albums: [
      {
        title: 'Verão Digital',
        type: 'album',
        release: '2026-06-30',
        addedDaysAgo: 20,
        label: 'Costa Alta',
        tracks: [
          { title: 'Rua Nova', seconds: 11, genre: 'techno', moods: ['party', 'happy'], isrc: 'BRXY12600007' },
          { title: 'Sol Elétrico', seconds: 10, genre: 'hiphop', moods: ['party', 'energy'] },
          { title: 'Maré Alta', seconds: 12, genre: 'techno', moods: ['dance', 'happy'] },
          { title: 'Vidro Fumê', seconds: 9, genre: 'synthwave', moods: ['night'] },
        ],
      },
      {
        title: 'Batuque Binário',
        type: 'single',
        release: '2026-08-22',
        addedDaysAgo: 4,
        tracks: [{ title: 'Batuque Binário', seconds: 10, genre: 'drumandbass', moods: ['energy', 'party'] }],
      },
    ],
  },
  {
    name: 'Lil Quartz',
    bio: 'Rapper and beatmaker. Slick hi-hats, dusty chords, zero features.',
    genres: ['hip-hop', 'rap'],
    popularity: 92,
    albums: [
      {
        title: 'Geode Season',
        type: 'album',
        release: '2026-08-06',
        addedDaysAgo: 12,
        label: 'Facet',
        tracks: [
          { title: 'Pressure', seconds: 11, genre: 'hiphop', explicit: true, moods: ['energy', 'workout'] },
          { title: 'Fault Lines', seconds: 10, genre: 'hiphop', explicit: true, moods: ['energy'] },
          { title: 'Cold Cut', seconds: 9, genre: 'hiphop', moods: ['night', 'focus'] },
          { title: 'Facets', seconds: 12, genre: 'hiphop', explicit: true, moods: ['party'] },
          { title: 'Stone Money', seconds: 10, genre: 'hiphop', explicit: true, moods: ['energy'] },
        ],
      },
      {
        title: 'Fine Lines',
        type: 'single',
        release: '2026-08-25',
        addedDaysAgo: 2,
        tracks: [{ title: 'Fine Lines', seconds: 9, genre: 'hiphop', explicit: true, moods: ['energy'] }],
      },
    ],
  },
  {
    name: 'Sable Unit',
    bio: 'Hard, functional, and uninterested in being liked.',
    genres: ['techno', 'industrial'],
    popularity: 47,
    albums: [
      {
        title: 'Machine Elegy',
        type: 'album',
        release: '2026-05-08',
        addedDaysAgo: 80,
        tracks: [
          { title: 'Piston Choir', seconds: 10, genre: 'techno', moods: ['energy', 'workout'] },
          { title: 'Shift Work', seconds: 11, genre: 'techno', moods: ['focus', 'dark'] },
          { title: 'Cold Plant', seconds: 12, genre: 'techno', moods: ['night'] },
          { title: 'Concrete Bloom', seconds: 9, genre: 'techno', moods: ['energy'] },
        ],
      },
    ],
  },
  {
    name: 'The Paper Satellites',
    bio: 'Four-piece writing songs aboutMaps and moving house.',
    genres: ['indie-pop', 'indie-rock'],
    popularity: 66,
    albums: [
      {
        title: 'Orbit Lightweight',
        type: 'album',
        release: '2026-02-20',
        addedDaysAgo: 190,
        tracks: [
          { title: 'Cardboard Moon', seconds: 10, genre: 'synthwave', moods: ['happy', 'driving'] },
          { title: 'Small Rooms', seconds: 9, genre: 'jazz', moods: ['sad', 'romantic'] },
          { title: 'Relay', seconds: 11, genre: 'synthwave', moods: ['energy', 'happy'] },
          { title: 'Packing Tape', seconds: 10, genre: 'classical', moods: ['reflective'] },
        ],
      },
    ],
  },
  {
    name: 'Brass Meridian',
    bio: 'Twelve-piece jazz orchestra; arranges for tape machine, not streaming.',
    genres: ['jazz', 'big-band'],
    verified: 'label',
    popularity: 58,
    albums: [
      {
        title: 'Midnight Cartography',
        type: 'album',
        release: '2026-07-17',
        addedDaysAgo: 14,
        label: 'Ninth Ward Rooms',
        tracks: [
          { title: 'Compass Rose', seconds: 12, genre: 'jazz', moods: ['romantic', 'night'] },
          { title: 'Meridian Line', seconds: 11, genre: 'jazz', moods: ['focus'] },
          { title: 'Blue Projection', seconds: 10, genre: 'jazz', moods: ['sad', 'night'] },
          { title: 'North by Northeast', seconds: 13, genre: 'jazz', moods: ['party', 'romantic'] },
        ],
      },
    ],
  },
  {
    name: 'Hollow Radio',
    bio: 'Lo-fi broadcaster beaming loops to no one in particular, on purpose.',
    genres: ['lofi', 'chillhop'],
    popularity: 70,
    albums: [
      {
        title: 'Late Frequencies',
        type: 'album',
        release: '2026-08-19',
        addedDaysAgo: 5,
        tracks: [
          { title: 'Static Sleep', seconds: 10, genre: 'lofi', moods: ['sleep', 'calm', 'focus'] },
          { title: 'AM Ghost', seconds: 11, genre: 'lofi', moods: ['focus', 'sad'] },
          { title: 'Tape Hymn', seconds: 9, genre: 'lofi', moods: ['calm'] },
          { title: 'Night Shift', seconds: 12, genre: 'lofi', moods: ['focus', 'night', 'studying'] },
          { title: 'Dial Tone Sky', seconds: 10, genre: 'lofi', moods: ['calm', 'sleep'] },
        ],
      },
      {
        title: 'Study Carrel',
        type: 'ep',
        release: '2026-06-11',
        addedDaysAgo: 25,
        tracks: [
          { title: 'Highlighter', seconds: 9, genre: 'lofi', moods: ['focus', 'studying'] },
          { title: 'Library Rain', seconds: 11, genre: 'lofi', moods: ['calm', 'studying'] },
          { title: 'Second Cup', seconds: 10, genre: 'lofi', moods: ['focus'] },
        ],
      },
    ],
  },
];

const EXTRA_GENRES = ['soul', 'funk', 'metal', 'house', 'electronic', 'rap', 'big-band', 'indie-rock', 'afro-latin', 'singer-songwriter', 'chillhop', 'industrial', 'drum-and-bass'];

const LYRIC_WORDS_A = ['static', 'harbour', 'lantern', 'concrete', 'midnight', 'paper', 'engine', 'willow', 'signal', 'ash', 'copper', 'river'];
const LYRIC_WORDS_B = ['keeps', 'is calling', 'won’t hold', 'again', 'under water', 'and waits', 'in the dark', 'turning over', 'toward the exit', 'of the room'];

/** Deliberately synthetic verse material — flagged is_placeholder in the DB and in the UI. */
function placeholderLyrics(seedStr: string, lines: number, durationMs: number) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619) >>> 0;
  const pick = (arr: string[], n: number) => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return arr[h % (arr.length - n)]! + (n > 1 ? ' ' + arr[(h >>> 3) % arr.length]! : '');
  };
  const out: { lineNumber: number; timeMs: number; text: string }[] = [];
  const step = durationMs / (lines + 1);
  for (let i = 0; i < lines; i += 1) {
    const a = pick(LYRIC_WORDS_A, 1);
    const b = pick(LYRIC_WORDS_B, 1);
    const text = `${a[0]!.toUpperCase()}${a.slice(1)} ${b}`;
    out.push({ lineNumber: i + 1, timeMs: Math.round(step * (i + 1)), text });
  }
  return out;
}

export interface SeedOptions {
  /** Write synthesized audio + artwork objects (set false for a fast schema-only seed). */
  withAudio?: boolean;
  /** Generate listening history for the demo accounts. */
  withHistory?: boolean;
  storageDir?: string;
}

export interface SeedResult {
  artists: number;
  albums: number;
  tracks: number;
  audioObjects: number;
  lyrics: number;
  users: { admin: string; demo: string; premium: string; artists: string[] };
  playlists: number;
  events: number;
  searchDocuments: number;
  warnings: string[];
}

export async function seedCatalog(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const withAudio = opts.withAudio ?? true;
  const storage = new LocalStorageProvider(resolveDataPath(opts.storageDir ?? env.STORAGE_LOCAL_DIR), {
    secret: env.APP_SECRET,
    publicBase: env.API_PUBLIC_URL,
  });
  const warnings: string[] = [];
  const result: SeedResult = {
    artists: 0,
    albums: 0,
    tracks: 0,
    audioObjects: 0,
    lyrics: 0,
    users: { admin: '', demo: '', premium: '', artists: [] },
    playlists: 0,
    events: 0,
    searchDocuments: 0,
    warnings,
  };

  /* -------- genres -------- */
  const genreSlugs = new Set<string>();
  for (const a of CATALOG) for (const g of a.genres) genreSlugs.add(g);
  for (const g of EXTRA_GENRES) genreSlugs.add(g);
  for (const g of ['lofi', 'ambient', 'synthwave', 'techno', 'hip-hop', 'jazz', 'neo-classical', 'indie-folk', 'drum-and-bass', 'house']) genreSlugs.add(g);
  for (const slug of genreSlugs) {
    const name = slug
      .split('-')
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(' ');
    await db.execute(
      `INSERT INTO genres (id, slug, name, description, accent_color)
       VALUES (d7_uuid(), $1, $2, $3, $4) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
      [slug, name, `Catalog shelf for ${name.toLowerCase()} releases on D7music.`, '#6d5ef7'],
    );
  }

  /* -------- provider registry rows (config, not credentials) -------- */
  await db.execute(
    `INSERT INTO music_providers (name, kind, enabled, capability, rate_limit_rps, respects_drm, notes, default_page_size)
     VALUES ('local_library','audio',true,'streaming',20,true,'Platform-owned uploads and this sample catalog. Streams are served by our API with signed, range-capable URLs.',50)
     ON CONFLICT (name) DO UPDATE SET enabled = true, kind = 'audio'`,
  );
  await db.execute(
    `INSERT INTO music_providers (name, kind, enabled, capability, rate_limit_rps, respects_drm, notes, terms_url, default_page_size)
     VALUES ('musicbrainz','metadata',true,'discovery',1,true,'Open release metadata (CC-0). Metadata only: never used to obtain audio or artwork.', 'https://musicbrainz.org/doc/About', 25)
     ON CONFLICT (name) DO UPDATE SET kind = 'metadata'`,
  );
  await db.execute(
    `INSERT INTO music_providers (name, kind, enabled, capability, respects_drm, notes, default_page_size)
     VALUES ('licensed_partner_example','audio',false,'streaming',true,'Template row for a licensed catalogue API. Enable by setting MUSIC_PROVIDER=json_http plus base URL/key; no audio is fetched unless those are configured.',50)
     ON CONFLICT (name) DO NOTHING`,
  );

  /* -------- users -------- */
  const admin = await findOrCreateUser(db, 'admin', 'admin@d7music.test', env.SEED_ADMIN_PASSWORD, { role: 'admin', displayName: 'D7 Operations' });
  const demo = await findOrCreateUser(db, 'demo', 'demo@d7music.test', env.SEED_DEMO_PASSWORD, { displayName: 'Demo Listener' });
  const premium = await findOrCreateUser(db, 'mira', 'mira@d7music.test', 'D7premium!23', { displayName: 'Mira', emailVerified: true });
  await db.execute(
    `UPDATE subscriptions SET tier='premium', status='active', current_period_end = now() + interval '30 days' WHERE user_id = $1::uuid`,
    [premium.id],
  );
  result.users.admin = admin.id;
  result.users.demo = demo.id;
  result.users.premium = premium.id;

  const artistUserIdFor = new Map<string, string>();
  for (const a of CATALOG) {
    if (!a.artistUsername) continue;
    const u = await findOrCreateUser(db, a.artistUsername, `${a.artistUsername}@d7music.test`, 'D7artist!234', {
      role: 'artist',
      displayName: a.name,
    });
    artistUserIdFor.set(a.name, u.id);
    result.users.artists.push(u.id);
  }
  const listenerB = await findOrCreateUser(db, 'sam', 'sam@d7music.test', 'D7listener!2', { displayName: 'Sam' });
  // Demo listeners see the whole catalog: explicit_filter=false means "do not hide explicit".
  await db.execute(`UPDATE user_preferences SET explicit_filter = false WHERE user_id = ANY($1::uuid[])`, [
    [demo.id, premium.id, listenerB.id],
  ]);

  /* -------- catalog -------- */
  const artistIds: string[] = [];
  const trackIdsByGenre = new Map<string, string[]>();
  const allTrackIds: string[] = [];
  const artistIdByName = new Map<string, string>();

  for (const seed of CATALOG) {
    const { artistId } = await upsertArtist(db, 'local_library', {
      name: seed.name,
      bio: seed.bio,
      popularity: seed.popularity,
      imageUrl: null,
      providerArtistId: `seed-artist:${slugify(seed.name)}`,
    });
    artistIds.push(artistId);
    artistIdByName.set(seed.name, artistId);
    result.artists += 1;

    // artwork (public, unsigned) — one image per artist
    if (withAudio) {
      const art = generateArtworkSvg({ seed: `artist:${seed.name}`, title: seed.name, kind: 'artist', size: 512 });
      const up = await storage.upload({ key: `artwork/artist-${slugify(seed.name)}.svg`, body: Buffer.from(art, 'utf8'), contentType: 'image/svg+xml' });
      await db.execute(`UPDATE artists SET image_url = $2, banner_url = $3 WHERE id = $1::uuid`, [
        artistId,
        `/media/${up.key}`,
        `/media/artwork/artist-${slugify(seed.name)}.svg`,
      ]);
    }
    await db.execute(
      `UPDATE artists SET monthly_listeners = $2, popularity = $3, verified = $4,
              verified_kind = CASE WHEN $4 THEN coalesce(verified_kind, $5) END,
              verified_at = CASE WHEN $4 THEN now() END
        WHERE id = $1::uuid`,
      [artistId, Math.round(seed.popularity * 9000 + 4000), seed.popularity, !!seed.verified, seed.verified ?? null],
    );
    for (const g of seed.genres) {
      await db.execute(
        `INSERT INTO track_genres (track_id, genre_id, weight)
         SELECT t.id, g.id, 1 FROM tracks t JOIN genres g ON g.slug = $2 WHERE t.primary_artist_id = $1::uuid
         ON CONFLICT DO NOTHING`,
        [artistId, g],
      );
    }

    const ownerId = artistUserIdFor.get(seed.name) ?? admin.id;
    await db.execute(
      `INSERT INTO artist_profiles (id, artist_id, user_id, role, claim_status, verified)
       VALUES (d7_uuid(), $1::uuid, $2::uuid, 'primary', 'claimed', true) ON CONFLICT (artist_id, user_id) DO NOTHING`,
      [artistId, ownerId],
    );

    for (const album of seed.albums) {
      const { albumId } = await upsertAlbum(db, {
        provider: 'local_library',
        providerAlbumId: `seed-album:${slugify(seed.name)}:${slugify(album.title)}`,
        title: album.title,
        artistId,
        albumType: album.type,
        releaseDate: album.release,
        labelName: album.label ?? 'Self-released',
        copyrightNote: `℗ ${album.release.slice(0, 4)} ${seed.name} · distributed by D7music (sample catalog)`,
        upc: `000000000000${String(result.albums).padStart(2, '0')}`.slice(-12),
        popularity: seed.popularity,
        contentSource: 'platform_owned',
        licenseStatus: 'licensed',
        genreSlugs: seed.genres,
        streamable: true,
        status: 'published',
        pitch: `Sample ${album.type} in the D7music demo catalog — audio synthesized for this repository.`,
        providerPayload: { seeded: true },
      });
      result.albums += 1;
      if (album.addedDaysAgo) {
        await db.execute(`UPDATE albums SET added_at = now() - make_interval(days => $2::int) WHERE id = $1::uuid`, [albumId, album.addedDaysAgo]);
      }
      if (withAudio) {
        const art = generateArtworkSvg({ seed: `album:${album.title}`, title: album.title, subtitle: seed.name, size: 512 });
        const up = await storage.upload({ key: `artwork/album-${slugify(seed.name)}-${slugify(album.title)}.svg`, body: Buffer.from(art, 'utf8'), contentType: 'image/svg+xml' });
        await db.execute(`UPDATE albums SET image_url = $2, primary_color = $3 WHERE id = $1::uuid`, [albumId, `/media/${up.key}`, '#6d5ef7']);
      }
      await touchSearchDocument(db, 'album', albumId);
      await registerNewRelease(db, {
        entityType: 'album',
        entityId: albumId,
        artistId,
        provider: 'local_library',
        releaseDate: album.release,
      });

      let position = 1;
      for (const track of album.tracks) {
        let storageKey: string | null = null;
        let byteSize: number | null = null;
        let durationMs = track.seconds * 1000;
        let audioFeatures: { peakDbfs: number; loudnessLufs: number } | null = null;
        if (withAudio) {
          const wav = synthesizeTrack({
            seed: `${seed.name}/${album.title}/${track.title}`,
            genre: track.genre,
            seconds: track.seconds,
            sampleRate: 22050,
          });
          const up = await storage.upload({
            key: `audio/${slugify(seed.name)}/${slugify(album.title)}/${String(position).padStart(2, '0')}-${slugify(track.title)}.wav`,
            body: wav,
            contentType: 'audio/wav',
          });
          storageKey = up.key;
          byteSize = up.bytes;
          // Read back the header so the advertised duration is the *real* one.
          durationMs = Math.round(((wav.length - 44) / (22050 * 2)) * 1000);
          audioFeatures = estimateFeatures(wav);
          result.audioObjects += 1;
        }
        const tr = await upsertTrack(
          db,
          {
            provider: 'local_library',
            providerTrackId: `seed-track:${slugify(seed.name)}:${slugify(album.title)}:${position}`,
            providerAlbumId: `seed-album:${slugify(seed.name)}:${slugify(album.title)}`,
            albumId,
            artistId,
            title: track.title,
            trackNumber: position,
            discNumber: 1,
            durationMs,
            explicit: !!track.explicit,
            isrc: track.isrc ?? null,
            genres: seed.genres,
            moods: track.moods ?? [],
            popularity: Math.max(5, seed.popularity - position * 3),
            releaseDate: album.release,
            contentSource: 'platform_owned',
            licenseStatus: 'licensed',
            streamable: true,
            storageKey,
            mimeType: 'audio/wav',
            byteSize,
            previewOnly: false,
            status: 'published',
            features: { energy: 0.3 + ((position * 13) % 60) / 100 },
            providerPayload: { seeded: true },
          },
          undefined,
        );
        if (tr.outcome !== 'rejected' && tr.trackId) {
          result.tracks += 1;
          if (audioFeatures) {
            await db.execute(`UPDATE tracks SET peak_dbfs = $2, loudness_lufs = $3 WHERE id = $1::uuid`, [
              tr.trackId,
              audioFeatures.peakDbfs,
              audioFeatures.loudnessLufs,
            ]);
          }
          allTrackIds.push(tr.trackId);
          for (const g of seed.genres) {
            const list = trackIdsByGenre.get(g) ?? [];
            list.push(tr.trackId);
            trackIdsByGenre.set(g, list);
          }
          for (const m of track.moods ?? []) {
            const list = trackIdsByGenre.get(`mood:${m}`) ?? [];
            list.push(tr.trackId);
            trackIdsByGenre.set(`mood:${m}`, list);
          }
          if (withAudio && position % 2 === 1) {
            const lines = placeholderLyrics(`${seed.name}${track.title}`, 8, durationMs);
            await db.execute(
              `INSERT INTO lyrics (id, track_id, language, provider, is_synced, is_placeholder, content, lines, updated_at)
               VALUES (d7_uuid(), $1::uuid, 'en', 'platform_generated', true, true, $3, $2::jsonb, now())
               ON CONFLICT (track_id, language) DO UPDATE SET lines = EXCLUDED.lines, content = EXCLUDED.content`,
              [tr.trackId, JSON.stringify(lines), lines.map((l) => l.text).join('\n')],
            );
            result.lyrics += 1;
          }
        }
        position += 1;
      }
    }
  }

  /* -------- licensing records (spec §27: provenance per entity) -------- */
  await db.execute(
    `INSERT INTO licenses (id, entity_type, entity_id, holder, agreement_ref, territory, rights, start_date, status, notes, recorded_by)
     SELECT d7_uuid(), 'album', al.id, 'D7music Sample Catalog', 'SELF-OWNED-DEMO', 'worldwide', '{stream,download}', al.release_date, 'licensed',
            'Generated for this repository; audio synthesized locally. No third-party rights involved.', $1::uuid
       FROM albums al
       WHERE NOT EXISTS (SELECT 1 FROM licenses l WHERE l.entity_type = 'album' AND l.entity_id = al.id)`,
    [admin.id],
  );

  /* -------- playlists -------- */
  const editorial: { title: string; desc: string; mood?: string; genre?: string }[] = [
    { title: 'Deep Focus Loop', desc: 'Low-stimulus instrumentals for long work sessions.', mood: 'focus' },
    { title: 'Late-Night Coding', desc: 'Synths and tape hiss for the 2am commit.', mood: 'night' },
    { title: 'Bass Yard', desc: 'Breakbeats and sub-bass. Volume up.', mood: 'energy' },
    { title: 'Still Hours', desc: 'Quiet piano, room tone, nothing else.', mood: 'calm' },
    { title: 'Sunset Drive', desc: 'Windows down, arpeggios up.', mood: 'driving' },
    { title: 'Cartography', desc: 'Brass arrangements for map-reading.', genre: 'jazz' },
  ];
  const playlistIds: string[] = [];
  for (const pl of editorial) {
    const key = pl.mood ? `mood:${pl.mood}` : pl.genre!;
    const ids = (trackIdsByGenre.get(key) ?? []).slice(0, 10);
    const created = await createPlaylist(db, {
      ownerId: admin.id,
      title: pl.title,
      description: pl.desc,
      visibility: 'public',
      isEditorial: true,
      generatedBy: 'editorial_seed',
      imageUrl: withAudio ? `/media/artwork/playlist-${slugify(pl.title)}.svg` : null,
      trackIds: ids.length ? ids : allTrackIds.slice(0, 8),
    });
    playlistIds.push(created.id);
    result.playlists += 1;
    if (withAudio) {
      const art = generateArtworkSvg({ seed: `playlist:${pl.title}`, title: pl.title, subtitle: 'D7music Editorial', size: 512 });
      const up = await storage.upload({ key: `artwork/playlist-${slugify(pl.title)}.svg`, body: Buffer.from(art, 'utf8'), contentType: 'image/svg+xml' });
      await db.execute(`UPDATE playlists SET image_url = $2 WHERE id = $1::uuid`, [created.id, `/media/${up.key}`]);
    }
  }

  await createPlaylist(db, {
    ownerId: demo.id,
    title: 'My First Playlist',
    description: 'Public sample playlist owned by the demo listener.',
    visibility: 'public',
    trackIds: allTrackIds.slice(0, 5),
  });
  result.playlists += 1;

  /* -------- follows + likes -------- */
  for (const [userId, slice] of [
    [demo.id, artistIds.slice(0, 5)],
    [premium.id, [artistIds[0], artistIds[2], artistIds[3]].filter(Boolean) as string[]],
    [listenerB.id, [artistIds[1], artistIds[5]].filter(Boolean) as string[]],
  ] as [string, string[]][]) {
    for (const artistId of slice) {
      await setArtistFollow(db, userId, artistId, true);
    }
  }
  await db.execute(
    `UPDATE artists SET followers_count = (SELECT count(*) FROM followed_artists fa WHERE fa.artist_id = artists.id)::int`,
  );
  for (const [userId, offset] of [
    [demo.id, 0],
    [premium.id, 3],
    [listenerB.id, 6],
  ] as [string, number][]) {
    for (const t of allTrackIds.slice(offset, offset + 14)) await setLikedTrack(db, userId, t, true, 'seed');
  }

  /* -------- listening history through the real pipeline -------- */
  if (opts.withHistory ?? true) {
    for (const [userId, bias, weight] of [
      [demo.id, ['lofi', 'synthwave', 'ambient'], 300],
      [premium.id, ['drum-and-bass', 'techno', 'hip-hop'], 260],
      [listenerB.id, ['jazz', 'indie-folk'], 200],
    ] as [string, string[], number][]) {
      const pool = bias.flatMap((g) => trackIdsByGenre.get(g) ?? []).filter(Boolean);
      const candidates = pool.length >= 6 ? pool : allTrackIds;
      const events: Parameters<typeof ingestPlaybackEvents>[1] = [];
      let h = hashSeed(userId + bias.join());
      for (let i = 0; i < weight; i += 1) {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
        const trackId = candidates[h % candidates.length]!;
        const agoDays = (h >>> 8) % 30;
        const occurredAt = new Date(Date.now() - agoDays * 86_400_000 - (h % 86_400) * 1000).toISOString();
        const complete = (h >>> 12) % 10 > 2;
        events.push({
          type: complete ? 'track_completed' : 'track_skipped',
          trackId,
          context: { type: 'mix', id: 'seed' },
          positionMs: complete ? 0 : 8000 + (h % 4000),
          durationMs: 10_000,
          occurredAt,
          shuffle: (h >>> 20) % 2 === 0,
          repeat: 'off',
          source: 'seed',
        });
      }
      const res = await ingestPlaybackEvents(db, events, { userId });
      result.events += res.accepted;
    }
    // recent activity so "continue listening" + "recently played" are populated
    const recent = allTrackIds.slice(0, 4);
    await ingestPlaybackEvents(
      db,
      recent.map((trackId, i) => ({
        type: 'track_started' as const,
        trackId,
        context: { type: 'playlist' as const, id: playlistIds[i % playlistIds.length] ?? 'unknown' },
        positionMs: 0,
        durationMs: 10_000,
        occurredAt: new Date(Date.now() - i * 3_600_000).toISOString(),
        shuffle: false,
        repeat: 'off' as const,
        source: 'seed',
      })),
      { userId: demo.id },
    );
    await db.execute(
      `UPDATE recently_played SET position_ms = 4200 WHERE user_id = $1::uuid AND track_id = $2::uuid`,
      [demo.id, recent[0]],
    );
  }

  /* -------- popularity from real counts -------- */
  await db.execute(
    `UPDATE tracks t SET popularity = round((t.popularity * 0.65 + least(100, ln(1 + t.play_count) * 22) * 0.35)::numeric, 3)`,
  );
  await db.execute(
    `UPDATE albums al SET popularity = round((al.popularity * 0.7 + coalesce((SELECT avg(t.popularity) FROM tracks t WHERE t.album_id = al.id), 0) * 0.3)::numeric, 3)`,
  );
  await db.execute(
    `UPDATE artists ar SET popularity = round((ar.popularity * 0.8 + coalesce((SELECT avg(t.popularity) FROM tracks t WHERE t.primary_artist_id = ar.id), 0) * 0.2)::numeric, 3)`,
  );

  const idx = await rebuildSearchIndex(db);
  result.searchDocuments = idx.documents;
  return result;
}

export async function createUserSeed(db: Db) {
  return createUser(db, { username: 'tester', email: 'tester@d7music.test', passwordHash: await hashPassword('Tester!23456') });
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function findOrCreateUser(
  db: Db,
  username: string,
  email: string,
  password: string,
  extra: { role?: 'listener' | 'artist' | 'admin'; displayName?: string | null; emailVerified?: boolean },
) {
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM users WHERE username_key = d7_normalize_text($1) OR email_key = d7_normalize_text($2)`,
    [username, email],
  );
  if (existing) return { id: String(existing.id), existing: true as const };
  const created = await createUser(db, {
    username,
    email,
    passwordHash: await hashPassword(password),
    displayName: extra.displayName ?? username,
    role: extra.role ?? 'listener',
    emailVerified: extra.emailVerified ?? true,
  });
  return { id: created.id, existing: false as const };
}

export { CATALOG };
