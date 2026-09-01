/**
 * Home shelves (spec §4). The page is a list of typed shelves, each with a provenance
 * string, so the UI can explain *why* something is recommended instead of hiding it.
 */
import type { FastifyInstance } from 'fastify';
import { MOODS } from '@d7/config';
import {
  getContinueListening,
  getFreshTracks,
  getMoodTracks,
  getPopularArtists,
  getRecentlyLikedTracks,
  getRecentlyPlayedTracks,
  getTopTracksForUser,
  getTrending,
  listLatestAlbums,
  listUserPlaylists,
  type Db,
} from '@d7/database';
import type { Album, Artist, Playlist, Shelf, ShelfItem, Track } from '@d7/types';
import { hydrateTracks } from './media.js';
import type { SessionUser } from '../plugins/session.js';
import { listTracksByIds } from '@d7/database';

export function trackItem(track: Track): ShelfItem {
  return {
    type: 'track',
    id: track.id,
    title: track.title,
    subtitle: track.artists.map((a) => a.name).join(', ') || track.albumTitle,
    imageUrl: track.albumImageUrl,
    meta: { durationMs: track.durationMs, explicit: track.explicit, playable: Boolean(track.audio) },
    track,
  };
}

export function albumItem(album: Album & { trackIds?: string[] }): ShelfItem {
  return {
    type: 'album',
    id: album.id,
    title: album.title,
    subtitle: album.artist?.name ?? 'Various artists',
    imageUrl: album.imageUrl,
    meta: { releaseDate: album.releaseDate, trackCount: album.trackCount, releaseType: album.releaseType, licenseStatus: album.licenseStatus },
    album,
  };
}

export function artistItem(artist: Artist): ShelfItem {
  return {
    type: 'artist',
    id: artist.id,
    title: artist.name,
    subtitle: artist.genres?.length ? artist.genres.join(' · ') : artist.bio ? 'Artist' : 'Artist',
    imageUrl: artist.imageUrl,
    meta: { verified: artist.verified, monthlyListeners: artist.monthlyListeners },
    artist,
  };
}

export function playlistItem(playlist: Playlist): ShelfItem {
  return {
    type: 'playlist',
    id: playlist.id,
    title: playlist.title,
    subtitle: playlist.owner.displayName ?? playlist.owner.username,
    imageUrl: playlist.imageUrl,
    meta: { trackCount: playlist.trackCount, visibility: playlist.visibility, collaborative: playlist.collaborative },
    playlist,
  };
}

export interface HomeBundle {
  greeting: string;
  personalized: boolean;
  shelves: Shelf[];
}

export async function buildHome(app: FastifyInstance, db: Db, user: SessionUser | null, limit = 12): Promise<HomeBundle> {
  const hour = new Date().getHours();
  const greeting = user
    ? `${hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${user.displayName ?? user.username}`
    : 'Fresh cuts and station picks';

  const [
    continueRows,
    recent,
    likedRecent,
    trending,
    fresh,
    artists,
    topTracks,
    latestAlbums,
    playlists,
    forYou,
  ] = await Promise.all([
    getContinueListening(db, user?.id ?? null, 6),
    getRecentlyPlayedTracks(db, user?.id ?? null, limit),
    getRecentlyLikedTracks(db, user?.id ?? null, limit),
    getTrending(db, { limit, viewerId: user?.id ?? null }),
    getFreshTracks(db, { days: 14, limit }),
    getPopularArtists(db, 10),
    getTopTracksForUser(db, user?.id ?? null, limit),
    listLatestAlbums(db, { days: 21, limit: 12 }),
    user ? listUserPlaylists(db, user.id, { viewerId: user.id, includePrivate: true, limit: 10 }) : Promise.resolve([]),
    forYouShelf(app, db, user, limit),
  ]);

  const shelves: Shelf[] = [];

  if (continueRows.length) {
    const tracks = await hydrateTracks(
      app,
      continueRows.map((r: { track: Track }) => r.track),
      user,
    );
    shelves.push({
      id: 'continue',
      kind: 'continue_listening',
      title: 'Pick up where you left off',
      subtitle: 'Resume positions come from your playback history',
      variant: 'compact_rows',
      items: tracks.map(trackItem),
      seeAllHref: '/your-library?tab=history',
      debugReason: 'recently_played rows with a saved position',
    });
  }

  if (user && recent.length) {
    const tracks = await hydrateTracks(app, recent, user);
    shelves.push({
      id: 'recently-played',
      kind: 'recently_played',
      title: 'Recently played',
      subtitle: null,
      variant: 'carousel',
      items: tracks.map(trackItem),
      seeAllHref: '/your-library?tab=history',
      debugReason: 'last distinct tracks you played',
    });
  }

  shelves.push({
    id: 'made-for-you',
    kind: 'made_for_you',
    title: user ? 'Made for you' : 'Popular right now',
    subtitle: forYou.subtitle,
    variant: 'grid',
    items: forYou.items,
    seeAllHref: user ? '/your-library?tab=radio' : '/genres',
    debugReason: forYou.reason,
  });

  const trend = await hydrateTracks(app, trending, user);
  shelves.push({
    id: 'trending',
    kind: 'trending',
    title: 'Trending this week',
    subtitle: 'Weighted by plays, saves and likes in the last 7 days',
    variant: 'grid',
    items: trend.map(trackItem),
    seeAllHref: '/trending',
    debugReason: 'listening_stats_daily aggregate, decayed',
  });

  // Each release card carries a playable preview track, hydrated like everything else.
  const previews = await Promise.all(
    latestAlbums.map((a) => (a.trackIds.length ? listTracksByIds(db, a.trackIds.slice(0, 1), { viewerId: user?.id ?? null }) : Promise.resolve([]))),
  );
  const previewTracks = await hydrateTracks(app, previews.flat(), user);
  const previewById = new Map(previewTracks.map((t) => [t.id, t]));
  const addedAlbums = latestAlbums.map((a, i) => ({ album: a, preview: previews[i]?.[0] ? previewById.get(previews[i]![0].id) ?? null : null }));
  shelves.push({
    id: 'new-releases',
    kind: 'new_releases',
    title: 'New releases',
    subtitle: 'What the release sync added in the last three weeks',
    variant: 'cards',
    items: addedAlbums.map(({ album, preview }) => {
      const item = albumItem(album);
      return { ...item, meta: { ...item.meta, previewTrackId: preview?.id ?? null, playable: Boolean(preview?.audio) } };
    }),
    seeAllHref: '/new-releases',
    debugReason: 'albums.added_at DESC',
  });

  if (topTracks.length) {
    const tracks = await hydrateTracks(app, topTracks, user);
    shelves.push({
      id: 'top-tracks',
      kind: 'top_tracks',
      title: 'Your most played',
      subtitle: null,
      variant: 'compact_rows',
      items: tracks.map(trackItem),
      seeAllHref: '/your-library?tab=history',
      debugReason: 'listening_history counts for your account',
    });
  }

  if (likedRecent.length) {
    const tracks = await hydrateTracks(app, likedRecent, user);
    shelves.push({
      id: 'recently-liked',
      kind: 'based_on_listening',
      title: 'Because you liked',
      subtitle: 'Recently liked, still in your library',
      variant: 'carousel',
      items: tracks.map(trackItem),
      seeAllHref: '/your-library?tab=liked',
      debugReason: 'liked_tracks order',
    });
  }

  const mood = Object.keys(MOODS)[hour < 6 || hour >= 22 ? 8 : hour < 11 ? 1 : hour < 17 ? 3 : 5] ?? 'focus';
  const moodTracks = await hydrateTracks(app, await getMoodTracks(db, mood, 8, user?.id ?? null), user);
  shelves.push({
    id: `mood-${mood}`,
    kind: 'mood_playlists',
    title: `Mood: ${mood}`,
    subtitle: `Chosen for ${hour < 11 ? 'the morning' : hour < 17 ? 'the workday' : hour < 22 ? 'the evening' : 'late hours'}`,
    variant: 'grid',
    items: moodTracks.map(trackItem),
    seeAllHref: `/moods/${mood}`,
    debugReason: 'energy/valence envelope from MOODS table',
  });

  const freshTracks = await hydrateTracks(app, fresh, user);
  shelves.push({
    id: 'recently-added',
    kind: 'recently_added',
    title: 'Recently added',
    subtitle: 'New to the catalog, not necessarily new to the world',
    variant: 'carousel',
    items: freshTracks.map(trackItem),
    seeAllHref: '/new-releases?sort=added',
    debugReason: 'tracks.added_at DESC',
  });

  shelves.push({
    id: 'artists',
    kind: 'popular_artists',
    title: 'Artists to know',
    subtitle: null,
    variant: 'carousel',
    items: artists.map(artistItem),
    seeAllHref: '/artists',
    debugReason: 'artist popularity',
  });

  if (user && playlists?.length) {
    shelves.push({
      id: 'your-playlists',
      kind: 'your_playlists',
      title: 'Your playlists',
      subtitle: null,
      variant: 'carousel',
      items: playlists.map(playlistItem),
      seeAllHref: '/your-library?tab=playlists',
      debugReason: 'owned or collaborated playlists',
    });
  }

  return { greeting, personalized: Boolean(user), shelves };
}

async function forYouShelf(
  app: FastifyInstance,
  db: Db,
  user: SessionUser | null,
  limit: number,
): Promise<{ items: ShelfItem[]; reason: string | null; subtitle: string | null }> {
  try {
    const { items, mode, signals } = await app.d7.recommendations.forUser(db, user?.id ?? null, { limit });
    const tracks = await hydrateTracks(
      app,
      items.map((i) => i.track),
      user,
    );
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const shelfItems = items.map((i) => {
      const item = trackItem(byId.get(i.track.id) ?? i.track);
      return { ...item, meta: { ...item.meta, score: Math.round(i.score * 100) / 100, why: i.reasons.map((r) => r.label).slice(0, 3).join(' · ') } };
    });
    const reason =
      mode === 'personalized'
        ? `personalised: ${signals?.eventsConsidered ?? 0} events over ${signals?.windowDays ?? 30} days, top genre ${signals?.topGenres?.[0]?.genre ?? 'n/a'}`
        : 'cold start: popularity + recency, no history needed';
    return { items: shelfItems, reason, subtitle: mode === 'personalized' ? 'From your listening, likes and follows' : 'Nothing to learn from yet — here is what the catalog is known for' };
  } catch (err) {
    app.d7.log.warn('home recommendation shelf failed', { message: (err as Error).message });
    const tracks = await hydrateTracks(app, await getTrending(db, { limit, viewerId: user?.id ?? null }), user);
    return { items: tracks.map(trackItem), reason: 'fallback: trending after a recommendation error', subtitle: 'Recommendations are temporarily unavailable' };
  }
}

export async function moodShelf(db: Db, mood: string, limit = 12) {
  const tracks = await getMoodTracks(db, mood, limit);
  return { mood, config: MOODS[mood] ?? null, tracks };
}
