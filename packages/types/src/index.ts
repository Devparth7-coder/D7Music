/**
 * @d7/types — shared, runtime-free domain contract for the whole platform.
 *
 * Everything here is `type`/`interface`/`const`-free of side effects so that the
 * web app (browser) and the api (node) can import the exact same vocabulary.
 */

export type ID = string;

/* ------------------------------------------------------------------ *
 * Enums (backed by Postgres CHECK constraints / text columns)
 * ------------------------------------------------------------------ */

export type UserRole = 'listener' | 'artist' | 'admin';

export type SubscriptionTier = 'free' | 'premium';

/** Where the audio for a track came from. Drives legal posture. */
export type ContentSource = 'platform_owned' | 'licensed_provider' | 'partner_feed';

/** Lifecycle of the rights we hold on a piece of content. */
export type LicenseStatus = 'unlicensed' | 'pending_review' | 'licensed' | 'rejected' | 'expired';

/** Release lifecycle used by the creator dashboard workflow. */
export type ReleaseStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'scheduled' | 'published';

export type AlbumType = 'album' | 'single' | 'ep' | 'compilation';

export type ArtistVisibility = 'public' | 'unlisted';

export type PlaylistVisibility = 'private' | 'public' | 'collaborative';

export type NotificationKind =
  | 'artist_new_release'
  | 'playlist_update'
  | 'collab_change'
  | 'recommendation'
  | 'system'
  | 'new_follower'
  | 'claim_approved'
  | 'claim_denied';

/** Normalized playback telemetry — the raw material for recommendations. */
export type PlaybackEventType =
  | 'track_started'
  | 'track_completed'
  | 'track_skipped'
  | 'track_liked'
  | 'track_unliked'
  | 'track_added_to_playlist'
  | 'track_replayed'
  | 'progress_heartbeat';

export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';

export type SyncStatus = 'idle' | 'running' | 'succeeded' | 'partial' | 'failed';

/* ------------------------------------------------------------------ *
 * Core catalog entities
 * ------------------------------------------------------------------ */

export interface PublicUser {
  id: ID;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  role: UserRole;
  tier: SubscriptionTier;
  followersCount: number;
  followingCount: number;
  publicPlaylistCount: number;
  createdAt: string;
}

/** Resolved view of the acting user (never returned to other users). */
export interface CurrentUser extends PublicUser {
  email: string;
  emailVerified: boolean;
  preferences: UserPreferences;
  subscription: SubscriptionView | null;
}

export interface UserPreferences {
  theme: 'dark' | 'system';
  /** Parental mode: true = hide explicit tracks from personalized surfaces. */
  explicitFilter: boolean;
  autoplay: boolean;
  audioQuality: 'low' | 'normal' | 'high';
  showListeningHistory: boolean;
  notifyFollowedArtists: boolean;
  locale: string;
}

export interface Artist {
  id: ID;
  name: string;
  slug: string;
  bio: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  verified: boolean;
  verifiedBadge?: VerifiedBadge | null;
  monthlyListeners: number;
  followersCount: number;
  genres: string[];
  externalLinks: Record<string, string>;
  sourceProvider?: string | null;
  providerArtistId?: string | null;
}

export interface VerifiedBadge {
  kind: 'platform' | 'label' | 'distributor' | 'creator_claim';
  issuedAt: string;
  issuedBy: ID | null;
  note?: string | null;
}

export interface Album {
  id: ID;
  title: string;
  slug: string;
  artist: ArtistRef;
  artistIds: ID[];
  releaseType: AlbumType;
  releaseDate: string;
  imageUrl: string | null;
  primaryColor: string | null;
  label: string | null;
  copyright: string | null;
  upc: string | null;
  trackCount: number;
  durationMs: number;
  genres: string[];
  popularity: number;
  contentSource: ContentSource;
  licenseStatus: LicenseStatus;
  status: ReleaseStatus;
  addedAt: string;
}

export interface Track {
  id: ID;
  title: string;
  albumId: ID;
  albumTitle: string;
  albumImageUrl: string | null;
  artists: ArtistRef[];
  primaryArtistId: ID;
  trackNumber: number;
  discNumber: number;
  durationMs: number;
  explicit: boolean;
  isrc: string | null;
  genres: string[];
  mood: string[];
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  popularity: number;
  playCount: number;
  releaseDate: string;
  addedAt: string;
  contentSource: ContentSource;
  licenseStatus: LicenseStatus;
  providerName: string | null;
  providerTrackId: string | null;
  hasAudio: boolean;
  /** False while a licence is pending or the row is a draft — the player disables itself. */
  streamable: boolean;
  liked: boolean;
  likedCount: number;
  lyricCount: number;
  audio?: PlaybackSource | null;
}

export interface ArtistRef {
  id: ID;
  name: string;
  verified: boolean;
}

export interface Genre {
  id: ID;
  slug: string;
  name: string;
  description: string | null;
  trackCount: number;
  accentColor: string | null;
}

export interface Playlist {
  id: ID;
  title: string;
  description: string | null;
  imageUrl: string | null;
  owner: { id: ID; username: string; displayName: string | null };
  visibility: PlaylistVisibility;
  collaborative: boolean;
  isEditorial: boolean;
  trackCount: number;
  durationMs: number;
  followerCount: number;
  totalLikes: number;
  updatedAt: string;
  createdAt: string;
  likedByMe: boolean;
  canEdit: boolean;
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
}

export interface LyricLine {
  lineNumber: number;
  timeMs: number | null;
  text: string;
}

export interface Lyrics {
  trackId: ID;
  language: string;
  synced: boolean;
  provider: string | null;
  updatedAt: string;
  lines: LyricLine[];
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

/** How the player obtains bytes. Never a raw storage path. */
export interface PlaybackSource {
  url: string;
  expiresAt: string | null;
  mimeType: string;
  bitrateKbps: number | null;
  quality: 'low' | 'normal' | 'high';
  streamingProtocol: 'progressive' | 'hls' | 'dash';
  drmProtected: boolean;
}

export interface PlaybackEvent {
  type: PlaybackEventType;
  trackId: ID;
  context: PlaybackContext;
  positionMs: number;
  durationMs: number;
  occurredAt: string;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  source?: string;
}

export type PlaybackContext =
  | { type: 'album'; id: ID }
  | { type: 'playlist'; id: ID }
  | { type: 'artist'; id: ID }
  | { type: 'liked' }
  | { type: 'search'; query: string }
  | { type: 'radio'; seedTrackId: ID }
  | { type: 'assistant'; conversationId: string }
  | { type: 'mix'; id: string }
  | { type: 'unknown' };

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export type SearchEntityType = 'track' | 'artist' | 'album' | 'playlist' | 'genre';

export interface SearchFilters {
  types?: SearchEntityType[];
  genres?: string[];
  explicit?: boolean;
  releasedAfter?: string;
  releasedBefore?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  hasAudio?: boolean;
  licenseStatus?: LicenseStatus[];
}

export interface SearchResponse {
  query: string;
  tookMs: number;
  total: number;
  offset: number;
  limit: number;
  topHit?: { type: SearchEntityType; track?: Track; artist?: Artist; album?: Album } | null;
  tracks: Track[];
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  genres: Genre[];
}

export interface SearchSuggestion {
  text: string;
  type: SearchEntityType | 'recent';
  entityId?: ID;
  imageUrl?: string | null;
  subtitle?: string | null;
  score?: number;
}

/* ------------------------------------------------------------------ *
 * Home / discovery / recommendations
 * ------------------------------------------------------------------ */

export type ShelfItemType = 'track' | 'album' | 'playlist' | 'artist' | 'genre';

export interface ShelfItem {
  type: ShelfItemType;
  id: ID;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  meta?: Record<string, string | number | boolean | null>;
  track?: Track;
  album?: Album;
  artist?: Artist;
  playlist?: Playlist;
}

export type ShelfVariant = 'grid' | 'carousel' | 'cards' | 'compact_rows' | 'hero';

export type ShelfKind =
  | 'greeting'
  | 'recently_played'
  | 'made_for_you'
  | 'recommended_for_you'
  | 'new_releases'
  | 'trending'
  | 'popular_artists'
  | 'based_on_listening'
  | 'mood_playlists'
  | 'continue_listening'
  | 'recently_added'
  | 'your_playlists'
  | 'top_tracks';

export interface Shelf {
  id: string;
  kind: ShelfKind;
  title: string;
  subtitle: string | null;
  variant: ShelfVariant;
  items: ShelfItem[];
  seeAllHref: string | null;
  /** Why this shelf exists — surfaces the recommendation provenance in the UI. */
  debugReason?: string | null;
}

export interface HomeResponse {
  generatedAt: string;
  personalized: boolean;
  greeting: string;
  shelves: Shelf[];
  signals: RecommendationSignals | null;
}

export interface RecommendationSignals {
  topGenres: { genre: string; weight: number }[];
  topArtists: { artistId: ID; name: string; weight: number }[];
  topTracks: { trackId: ID; title: string; weight: number }[];
  eventsConsidered: number;
  windowDays: number;
}

export interface ScoredTrack {
  track: Track;
  score: number;
  reasons: { code: string; label: string; contribution: number }[];
}

export interface RecommendationResponse {
  mode: 'personalized' | 'cold_start_popularity' | 'similar_tracks';
  seedTrackId?: ID | null;
  items: ScoredTrack[];
  generatedAt: string;
  stale: boolean;
}

/* ------------------------------------------------------------------ *
 * New releases
 * ------------------------------------------------------------------ */

export type ReleaseWindow = 'today' | 'week' | 'month' | 'all';

export interface NewReleasesQuery {
  window: ReleaseWindow;
  genre?: string;
  artistId?: ID;
  scope: 'all' | 'following' | 'for_you';
  limit: number;
  offset: number;
}

export interface ReleaseSummary {
  album: Album;
  tracks: Track[];
  totalPlays: number;
  isTrending: boolean;
  followedArtist: boolean;
}

export interface NewReleasesResponse {
  query: NewReleasesQuery;
  counts: Record<ReleaseWindow, number>;
  releases: ReleaseSummary[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ *
 * AI music assistant
 * ------------------------------------------------------------------ */

/** The structured, validated shape the assistant is allowed to produce. */
export interface AssistantQuery {
  intent: 'play' | 'create_playlist' | 'describe' | 'similar' | 'browse';
  mood: string[];
  energy: 'low' | 'medium' | 'high' | null;
  tempo: 'slow' | 'medium' | 'fast' | null;
  genres: string[];
  avoidGenres: string[];
  artists: string[];
  era: { from?: number; to?: number } | null;
  durationMinutes: number | null;
  explicit: boolean | null;
  language: string | null;
  activity: string | null;
  limit: number;
}

export interface AssistantTrackRef {
  providerTrackId: string | null;
  title: string;
  artist: string;
}

export interface AssistantResponse {
  conversationId: string;
  message: string;
  parsed: AssistantQuery;
  /** 'rule_based' when no LLM is configured — always truthful in the UI. */
  engine: 'rule_based' | 'llm' | 'hybrid';
  model: string | null;
  tracks: Track[];
  playlist: Playlist | null;
  /** Track names the model suggested that do not exist in our catalog. */
  rejected: AssistantTrackRef[];
  appliedFilters: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface AssistantMessage {
  id: ID;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Provider sync + admin
 * ------------------------------------------------------------------ */

export interface ProviderDescriptor {
  name: string;
  kind: 'audio' | 'metadata';
  enabled: boolean;
  configured: boolean;
  supportsNewReleases: boolean;
  reasons: string[];
  health?: ProviderHealth;
}

export interface ProviderHealth {
  state: 'healthy' | 'degraded' | 'down' | 'disabled';
  latencyMs: number | null;
  successRate: number;
  consecutiveFailures: number;
  lastCheckAt: string | null;
  lastError: string | null;
}

export interface SyncRunSummary {
  id: ID;
  provider: string;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  fetchedArtists: number;
  fetchedAlbums: number;
  fetchedTracks: number;
  insertedAlbums: number;
  insertedTracks: number;
  updatedAlbums: number;
  updatedTracks: number;
  skippedDuplicates: number;
  rejectedInvalid: number;
  errors: { stage: string; message: string; attempts?: number }[];
  triggeredBy: 'schedule' | 'manual' | 'cli';
  cursorBefore: string | null;
  cursorAfter: string | null;
}

export interface AdminStats {
  users: { total: number; activeLast7d: number; premium: number; newLast7d: number };
  catalog: {
    tracks: number;
    artists: number;
    albums: number;
    playlists: number;
    lyrics: number;
    streamsReady: number;
    awaitingReview: number;
  };
  releases: { last24h: number; last7d: number; last30d: number; followingCapable: boolean };
  listening: {
    eventsToday: number;
    minutesStreamedToday: number;
    completionsToday: number;
    skipRate: number;
    topGenres: { genre: string; plays: number }[];
    topTracks: { trackId: ID; title: string; plays: number }[];
  };
  providers: ProviderDescriptor[];
  sync: {
    lastRun: SyncRunSummary | null;
    nextRunAt: string | null;
    everyMs: number;
    failedRuns: SyncRunSummary[];
  };
  reports: { open: number; total: number };
}

export interface ReportedContent {
  id: ID;
  entityType: 'track' | 'album' | 'artist' | 'playlist';
  entityId: ID;
  entityTitle: string;
  reason: string;
  details: string | null;
  status: ReportStatus;
  reporter: { id: ID; username: string } | null;
  createdAt: string;
  resolvedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * Creator dashboard
 * ------------------------------------------------------------------ */

export interface CreatorStats {
  artist: Artist;
  totals: { tracks: number; albums: number; streams: number; listeners: number; saves: number };
  trend: { date: string; streams: number }[];
  topTracks: { trackId: ID; title: string; streams: number; saves: number }[];
  geography: { country: string; listeners: number; share: number }[];
  retention: { label: string; value: number }[];
  privacyNote: string;
  pendingReview: { trackId: ID; title: string; status: ReleaseStatus }[];
}

export interface UploadResult {
  trackId: ID;
  storageKey: string;
  bytes: number;
  durationMs: number;
  status: ReleaseStatus;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

export interface PlanDefinition {
  tier: SubscriptionTier;
  name: string;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  features: string[];
  limits: {
    ads: boolean;
    maxBitrateKbps: number;
    offlineDownloads: number;
    assistantRequestsPerDay: number;
    lossless: boolean;
  };
}

export interface SubscriptionView {
  tier: SubscriptionTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
  provider: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/* ------------------------------------------------------------------ *
 * API envelopes
 * ------------------------------------------------------------------ */

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AuthSessionResponse {
  user: CurrentUser;
  issuedAt: string;
  expiresAt: string;
}
