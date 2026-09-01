/**
 * @d7/ui — primitives shared by the web app. Kept intentionally small: the app owns
 * its layout, this package owns class merging + artwork generation + a11y helpers.
 */
export { cn } from './cn.js';
export { generateArtworkSvg, artworkDataUri, initials, paletteFor, escapeXml, type ArtworkSpec } from './artwork.js';
