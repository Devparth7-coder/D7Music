/** Internal: track projection used by home shelves (same shape as catalog.ts). */
import { trackColumns } from './catalog.js';
export { listNewTracks, listTrendingTracks, listPopularArtists, listAlbumTracks } from './catalog.js';

export function trackColumnsForHome(viewerToken = 'NULL::uuid') {
  return trackColumns(viewerToken);
}
