/**
 * Deterministic cover-art generator (pure string math — no image deps).
 *
 * Why this exists: a music platform demo cannot ship other people's cover art, and
 * it also must not show empty grey boxes. So artwork for platform-owned catalog is
 * generated from the track's own identity hash: same album ⇒ same image, forever.
 */

export interface ArtworkSpec {
  seed: string;
  title?: string;
  subtitle?: string;
  size?: number;
  kind?: 'album' | 'artist' | 'playlist' | 'avatar';
}

const PALETTES: [string, string, string][] = [
  ['#0b1020', '#1b2a5e', '#6d5ef7'],
  ['#12081f', '#3b1d5e', '#ff6bd0'],
  ['#04160f', '#0d4a36', '#42e3a8'],
  ['#1a0a06', '#5e2212', '#ff9d4d'],
  ['#0a0f14', '#134b5e', '#4dd8ff'],
  ['#160820', '#4a1f5e', '#c77dff'],
  ['#0f1200', '#4a4a12', '#e8e06b'],
  ['#100617', '#3d0f4a', '#ff5c8a'],
];

function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand(seed: number, i: number) {
  const x = Math.sin(seed * 0.0001 + i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Returns an SVG string. Escape-hatches are intentional: this lands in <img src=data:...>. */
export function generateArtworkSvg(spec: ArtworkSpec): string {
  const size = spec.size ?? 512;
  const h = hash32(spec.seed);
  const [bg, mid, accent] = PALETTES[h % PALETTES.length]!;
  const shapes: string[] = [];
  const rings = 3 + (h % 4);
  for (let i = 0; i < rings; i += 1) {
    const cx = Math.round(rand(h, i + 1) * size);
    const cy = Math.round(rand(h, i + 9) * size);
    const r = Math.round((0.12 + rand(h, i + 17) * 0.4) * size);
    const op = (0.1 + rand(h, i + 25) * 0.28).toFixed(3);
    if (i % 3 === 0) {
      shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-opacity="${op}" stroke-width="${2 + (i % 5) * 3}"/>`);
    } else if (i % 3 === 1) {
      shapes.push(`<rect x="${Math.round(cx - r / 2)}" y="${Math.round(cy - r / 2)}" width="${r}" height="${r}" rx="${Math.round(r / 6)}" fill="${mid}" fill-opacity="${op}" transform="rotate(${Math.round(rand(h, i) * 60 - 30)} ${cx} ${cy})"/>`);
    } else {
      const pts = Array.from({ length: 3 }, (_, k) => `${Math.round(cx + rand(h, i * 3 + k) * r - r / 2)},${Math.round(cy + rand(h, i * 5 + k) * r - r / 2)}`).join(' ');
      shapes.push(`<polygon points="${pts}" fill="${accent}" fill-opacity="${op}"/>`);
    }
  }
  const bars = Array.from({ length: 24 }, (_, i) => {
    const bh = Math.round(6 + rand(h, i + 40) * (size * 0.16));
    return `<rect x="${Math.round((i / 24) * size + 4)}" y="${Math.round(size - bh - 6)}" width="${Math.round(size / 24 - 8)}" height="${bh}" rx="3" fill="${accent}" fill-opacity="0.22"/>`;
  }).join('');
  const title = escapeXml((spec.title ?? '').slice(0, 40));
  const subtitle = escapeXml((spec.subtitle ?? '').slice(0, 32));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${bg}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${bg}"/>
</linearGradient>
<radialGradient id="v" cx="0.5" cy="0.35" r="0.85">
<stop offset="0" stop-color="#ffffff" stop-opacity="0.12"/><stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
</radialGradient>
</defs>
<rect width="${size}" height="${size}" fill="url(#g)"/>
${shapes.join('\n')}
${bars}
<rect width="${size}" height="${size}" fill="url(#v)"/>
${title ? `<text x="32" y="${size - 54}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${Math.round(size / 18)}" font-weight="700" fill="#ffffff" fill-opacity="0.92">${title}</text>` : ''}
${subtitle ? `<text x="32" y="${size - 26}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${Math.round(size / 34)}" fill="#ffffff" fill-opacity="0.6">${subtitle}</text>` : ''}
</svg>`;
}

export function artworkDataUri(spec: ArtworkSpec) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(generateArtworkSvg(spec))}`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function paletteFor(seed: string) {
  const [bg, mid, accent] = PALETTES[hash32(seed) % PALETTES.length]!;
  return { bg, mid, accent };
}

export function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
