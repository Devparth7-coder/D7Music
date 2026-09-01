import { ProviderNotConfiguredError, type MusicProvider } from '../types.js';

/**
 * Placeholder used when `MUSIC_PROVIDER` names something we cannot construct
 * (missing key/base URL). It fails loudly and truthfully instead of silently
 * returning fake catalog rows.
 */
export class NotConfiguredProvider implements MusicProvider {
  readonly kind = 'audio' as const;
  readonly capabilities = { search: false, newReleases: false, artistDiscography: false, fullAudio: false, lyrics: false };
  constructor(readonly name: string, readonly reason: string) {}

  private fail(): never {
    throw new ProviderNotConfiguredError(this.name, this.reason);
  }
  async healthCheck() {
    return { ok: false, latencyMs: 0, message: `not configured: ${this.reason}` };
  }
  searchTracks = this.fail;
  getTrack = this.fail;
  getAlbum = this.fail;
  getArtist = this.fail;
  getNewReleases = this.fail;
  getTrendingTracks = this.fail;
  getArtistReleases = this.fail;
  getPlaybackSource = this.fail;
}
