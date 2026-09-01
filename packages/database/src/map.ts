/** SQL row → API DTO mappers. Single place where the schema is translated. */
import type {
  Album,
  Artist,
  ArtistRef,
  AssistantMessage,
  LyricLine,
  Lyrics,
  Playlist,
  SyncRunSummary,
  Track,
} from '@d7/types';

type Row = Record<string, any>;

const iso = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
};
const dateOnly = (v: unknown): string => (v ? String(v).slice(0, 10) : '');
const num = (v: unknown, def = 0): number => (v === null || v === undefined ? def : Number(v));
const round = (v: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const arr = <T>(v: unknown, fallback: T[] = []): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return fallback;
    if (t.startsWith('{')) {
      // Postgres array literal, e.g. {a,b,c} or {"a-b","c"}
      const inner = t.slice(1, -1);
      if (!inner) return [];
      return inner
        .split(',')
        .map((part) => part.replace(/^"|"$/g, '').replace(/\\/g, '')) as unknown as T[];
    }
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? (parsed as T[]) : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
};
const obj = <T>(v: unknown, fallback: T): T => {
  if (v && typeof v === 'object') return v as T;
  if (typeof v === 'string' && v.trim()) {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
};
const bool = (v: unknown): boolean => v === true || v === 't' || v === 1 || v === '1';

export function mapArtistRef(row: Row): ArtistRef {
  return { id: String(row.id), name: String(row.name), verified: bool(row.verified) };
}

export function mapArtist(row: Row): Artist {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    bio: row.bio ?? null,
    imageUrl: row.image_url ?? null,
    bannerUrl: row.banner_url ?? null,
    verified: bool(row.verified),
    verifiedBadge: row.verified_kind
      ? {
          kind: row.verified_kind,
          issuedAt: iso(row.verified_at),
          issuedBy: row.verified_by ?? null,
          note: null,
        }
      : null,
    monthlyListeners: num(row.monthly_listeners),
    followersCount: num(row.followers_count),
    genres: arr<string>(row.genre_slugs),
    externalLinks: obj<Record<string, string>>(row.external_links, {}),
    sourceProvider: row.source_provider ?? null,
    providerArtistId: row.provider_artist_id ?? null,
  };
}

export function mapAlbum(row: Row): Album {
  return {
    id: String(row.id),
    title: String(row.title),
    slug: String(row.slug),
    artist: obj<ArtistRef>(row.artist_json, { id: '', name: '', verified: false }),
    artistIds: arr<string>(row.artist_ids),
    releaseType: row.album_type,
    releaseDate: dateOnly(row.release_date),
    imageUrl: row.image_url ?? null,
    primaryColor: row.primary_color ?? null,
    label: row.label_name ?? null,
    copyright: row.copyright_note ?? null,
    upc: row.upc ?? null,
    trackCount: num(row.track_count),
    durationMs: num(row.duration_ms),
    genres: arr<string>(row.genre_slugs),
    popularity: round(num(row.popularity)),
    contentSource: row.content_source,
    licenseStatus: row.license_status,
    status: row.status,
    addedAt: iso(row.added_at),
  };
}

export function mapTrack(row: Row): Track {
  return {
    id: String(row.id),
    title: String(row.title),
    albumId: String(row.album_id),
    albumTitle: String(row.album_title ?? ''),
    albumImageUrl: row.album_image_url ?? null,
    artists: obj<ArtistRef[]>(row.artists_json, []),
    primaryArtistId: String(row.primary_artist_id),
    trackNumber: num(row.track_number, 1),
    discNumber: num(row.disc_number, 1),
    durationMs: num(row.duration_ms),
    explicit: bool(row.explicit),
    isrc: row.isrc ?? null,
    genres: arr<string>(row.genre_slugs),
    mood: arr<string>(row.mood_tags),
    energy: round(num(row.energy, 0.5), 3),
    valence: round(num(row.valence, 0.5), 3),
    danceability: round(num(row.danceability, 0.5), 3),
    acousticness: round(num(row.acousticness, 0.2), 3),
    popularity: round(num(row.popularity)),
    playCount: num(row.play_count),
    releaseDate: dateOnly(row.release_date),
    addedAt: iso(row.added_at),
    contentSource: row.content_source,
    licenseStatus: row.license_status,
    providerName: row.provider_name ?? null,
    providerTrackId: row.provider_track_id ?? null,
    hasAudio: bool(row.has_audio),
    streamable: bool(row.streamable),
    liked: bool(row.liked),
    likedCount: num(row.liked_count),
    lyricCount: num(row.lyric_count),
    audio: row.audio_url
      ? {
          url: String(row.audio_url),
          expiresAt: row.audio_expires_at ? iso(row.audio_expires_at) : null,
          mimeType: String(row.audio_mime ?? 'audio/wav'),
          bitrateKbps: row.audio_bitrate ? num(row.audio_bitrate) : null,
          quality: 'normal',
          streamingProtocol: 'progressive',
          drmProtected: false,
        }
      : null,
  };
}

export function mapPlaylist(row: Row, ctx: { viewerId?: string | null; canEdit?: boolean } = {}): Playlist {
  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description ?? null,
    imageUrl: row.image_url ?? null,
    owner: {
      id: String(row.owner_id ?? ''),
      username: String(row.owner_username ?? 'd7'),
      displayName: row.owner_display_name ?? null,
    },
    visibility: row.visibility,
    collaborative: bool(row.collaborative),
    isEditorial: bool(row.is_editorial),
    trackCount: num(row.track_count),
    durationMs: num(row.duration_ms),
    followerCount: num(row.follower_count),
    totalLikes: num(row.like_count),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
    likedByMe: bool(row.liked_by_me ?? row.liked_by_viewer),
    canEdit: bool(ctx.canEdit ?? row.can_edit),
  };
}

export function mapLyrics(row: Row): Lyrics {
  return {
    trackId: String(row.track_id),
    language: String(row.language ?? 'en'),
    synced: bool(row.is_synced),
    provider: row.provider ?? null,
    updatedAt: iso(row.updated_at),
    lines: obj<LyricLine[]>(row.lines, []).map((l, i) => ({
      lineNumber: l.lineNumber ?? i + 1,
      timeMs: l.timeMs ?? null,
      text: String(l.text ?? ''),
    })),
  };
}

export function mapSyncRun(row: Row): SyncRunSummary {
  return {
    id: String(row.id),
    provider: String(row.provider),
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    durationMs: row.duration_ms === null ? null : num(row.duration_ms),
    fetchedArtists: num(row.fetched_artists),
    fetchedAlbums: num(row.fetched_albums),
    fetchedTracks: num(row.fetched_tracks),
    insertedAlbums: num(row.inserted_albums),
    insertedTracks: num(row.inserted_tracks),
    updatedAlbums: num(row.updated_albums),
    updatedTracks: num(row.updated_tracks),
    skippedDuplicates: num(row.skipped_duplicates),
    rejectedInvalid: num(row.rejected_invalid),
    errors: obj<{ stage: string; message: string; attempts?: number }[]>(row.errors, []),
    triggeredBy: row.triggered_by,
    cursorBefore: row.cursor_before ?? null,
    cursorAfter: row.cursor_after ?? null,
  };
}

export function mapAssistantMessage(row: Row): AssistantMessage {
  return {
    id: String(row.id),
    role: row.role,
    content: String(row.content),
    createdAt: iso(row.created_at),
  };
}

export const map = { iso, dateOnly, num, arr, obj, bool };
