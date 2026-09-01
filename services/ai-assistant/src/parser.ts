/**
 * Deterministic natural-language → structured music query.
 *
 * This is the default assistant engine: no network, no keys, fully unit-testable, and
 * it runs whether or not an LLM is configured (the LLM path is additive: its output is
 * validated against the same schema and then *merged* with what we parsed locally).
 */
import type { AssistantQuery } from '@d7/types';
import { ACTIVITY_GENRES, MOODS } from '@d7/config';

export const EMPTY_QUERY: AssistantQuery = {
  intent: 'browse',
  mood: [],
  energy: null,
  tempo: null,
  genres: [],
  avoidGenres: [],
  artists: [],
  era: null,
  durationMinutes: null,
  explicit: null,
  language: null,
  activity: null,
  limit: 20,
};

const MOOD_LEXICON: Record<string, string[]> = {
  calm: ['calm', 'relax', 'relaxing', 'peaceful', 'quiet', 'soothing', 'chill', 'mellow', 'gentle', 'soft', 'unwind', 'serene', 'meditat'],
  focus: ['focus', 'concentrat', 'study', 'studying', 'work', 'working', 'deep work', 'productiv'],
  sleep: ['sleep', 'bed', 'insomnia', 'dream', 'night time', 'fall asleep'],
  energy: ['energetic', 'energy', 'hype', 'pump', 'pumped', 'motivat', 'adrenaline', 'power', 'intense'],
  workout: ['workout', 'gym', 'training', 'lift', 'cardio', 'run', 'running', 'jog', 'sport', 'basketball', 'soccer', 'football'],
  happy: ['happy', 'feel good', 'feel-good', 'upbeat', 'sunny', 'cheerful', 'good mood', 'bright'],
  sad: ['sad', 'melanchol', 'blue', 'rainy', 'rain', 'lonely', 'heartbreak', 'somber', 'grief'],
  romantic: ['romantic', 'romance', 'date', 'dinner', 'love', 'intimate', 'slow dance'],
  night: ['night', 'late night', 'midnight', 'nocturnal', 'after hours', '2am', '3am', 'coding'],
  party: ['party', 'dance', 'club', 'celebrat', 'birthday', 'house party'],
  driving: ['drive', 'driving', 'road trip', 'highway', 'cruise'],
  dark: ['dark', 'moody', 'gritty', 'industrial', 'haunted', 'tense'],
  reflective: ['reflective', 'nostalg', 'thinking', 'thoughtful', 'journal'],
};

const GENRE_LEXICON: Record<string, string[]> = {
  lofi: ['lofi', 'lo-fi', 'lo fi', 'chillhop', 'beat tape'],
  ambient: ['ambient', 'drone', 'sound scape', 'soundscape'],
  techno: ['techno', 'minimal', 'warehouse'],
  house: ['house', 'deep house', 'acid house'],
  synthwave: ['synthwave', 'synth pop', 'synth-pop', 'retrowave', 'outrun', '80s synth'],
  jazz: ['jazz', 'swing', 'bebop', 'cool jazz'],
  soul: ['soul', 'motown', 'r&b', 'neo soul'],
  funk: ['funk', 'disco'],
  'hip-hop': ['hip hop', 'hip-hop', 'rap', 'boom bap', 'trap'],
  'neo-classical': ['neo-classical', 'neoclassical', 'piano', 'classical', 'orchestral', 'string quartet'],
  'indie-folk': ['folk', 'indie folk', 'acoustic', 'singer-songwriter'],
  'indie-pop': ['indie pop', 'shoegaze', 'dream pop'],
  'indie-rock': ['indie rock', 'rock', 'alternative', 'post punk'],
  metal: ['metal', 'metalcore', 'hardcore', 'heavy'],
  'drum-and-bass': ['drum and bass', 'dnb', 'drum n bass', 'jungle', 'breakbeat'],
  electronic: ['electronic', 'edm', 'electronica', 'synth'],
  'big-band': ['big band', 'brass', 'orchestra'],
};

const NEGATION = ['no', 'not', 'without', 'avoid', 'anything but', 'except', 'dont like', "don't like", 'hate', 'rather than'];

const INTENT_HINTS: { intent: AssistantQuery['intent']; patterns: RegExp[] }[] = [
  { intent: 'create_playlist', patterns: [/\b(make|build|create|put together|generate|compose)\b.*\bplaylist\b/i, /\bplaylist\b.*\bfor\b/i] },
  { intent: 'play', patterns: [/\bplay\b/i, /\bqueue\b/i, /\bput on\b/i, /\bsome\b.*\bmusic\b/i, /\bstart\b/i] },
  { intent: 'similar', patterns: [/\bsimilar to\b/i, /\blike (the artist|this song|that song|this)\b/i, /\bfans of\b/i, /\breminds me of\b/i, /\bsame vibe as\b/i] },
  { intent: 'describe', patterns: [/\bwho is\b/i, /\bwhat is\b/i, /\btell me about\b/i, /\bexplain\b/i] },
];

const DURATION_PATTERNS: { re: RegExp; mul: number }[] = [
  { re: /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, mul: 60 },
  { re: /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, mul: 1 },
  { re: /\ban?\s+hour\b/i, mul: 60 },
  { re: /\ban?\s+half[- ]hour\b/i, mul: 30 },
];

const LANGUAGE_MAP: Record<string, string> = {
  spanish: 'es',
  spanishlang: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portugese: 'pt',
  'portuguese-br': 'pt',
  japanese: 'ja',
  korean: 'ko',
  hindi: 'hi',
  punjabi: 'pa',
  instrumental: 'instr',
};

export interface ParseResult {
  query: AssistantQuery;
  /** Raw matched vocabulary — surfaced in the UI so the user can see what we heard. */
  matched: { moods: string[]; genres: string[]; activities: string[]; artists: string[]; avoided: string[] };
  confidence: number;
}

const KNOWN_CONNECTORS = ['for', 'some', 'songs', 'music', 'track', 'tracks', 'playlist', 'mix', 'make', 'me', 'play', 'the', 'and', 'with'];

export function parseAssistantQuery(input: string, knownArtists: string[] = []): ParseResult {
  const raw = (input ?? '').toLowerCase().replace(/[.!?]+$/g, '').trim();
  const query: AssistantQuery = { ...EMPTY_QUERY, mood: [], genres: [], avoidGenres: [], artists: [] };
  const matched = { moods: [] as string[], genres: [] as string[], activities: [] as string[], artists: [] as string[], avoided: [] as string[] };

  if (!raw) return { query, matched, confidence: 0 };

  /* intent */
  for (const hint of INTENT_HINTS) {
    if (hint.patterns.some((re) => re.test(raw))) {
      query.intent = hint.intent;
      break;
    }
  }

  /* negated genres first ("nothing with vocals", "no rap") */
  for (const [slug, words] of Object.entries(GENRE_LEXICON)) {
    for (const w of words) {
      const negRe = new RegExp(`(?:${NEGATION.join('|')})\\b[^,.;]{0,24}\\b${escapeRe(w)}`, 'i');
      if (negRe.test(raw)) {
        if (!query.avoidGenres.includes(slug)) {
          query.avoidGenres.push(slug);
          matched.avoided.push(w);
        }
      }
    }
  }

  for (const [slug, words] of Object.entries(GENRE_LEXICON)) {
    if (query.avoidGenres.includes(slug)) continue;
    if (words.some((w) => hasWord(raw, w))) {
      query.genres.push(slug);
      matched.genres.push(slug);
    }
  }

  /* moods */
  for (const [mood, words] of Object.entries(MOOD_LEXICON)) {
    if (words.some((w) => raw.includes(w))) {
      if (!query.mood.includes(mood)) query.mood.push(mood);
      matched.moods.push(mood);
    }
  }

  /* activities (also imply genres) */
  for (const [activity, genres] of Object.entries(ACTIVITY_GENRES)) {
    if (raw.includes(activity) || new RegExp(`\\b${activity.split(' ')[0]}\\b`).test(raw)) {
      query.activity = activity;
      matched.activities.push(activity);
      for (const g of genres) if (!query.genres.includes(g)) query.genres.push(g);
      break;
    }
  }

  /* energy / tempo */
  if (/(energetic|high energy|hype|pump|intense|fast|upbeat|aggressive|hard)/i.test(raw)) query.energy = 'high';
  else if (/(calm|relax|chill|slow|soft|quiet|peaceful|sleep|ambient|gentle|low key)/i.test(raw)) query.energy = 'low';
  else if (query.mood.length) query.energy = query.mood.some((m) => ['energy', 'workout', 'party'].includes(m)) ? 'high' : query.mood.some((m) => ['calm', 'sleep', 'sad'].includes(m)) ? 'low' : 'medium';

  if (/\b(fast|upbeat|driving|dnb|drum and bass|techno|hardstyle)\b/i.test(raw)) query.tempo = 'fast';
  else if (/\b(slow|ballad|downtempo|lofi|ambient)\b/i.test(raw)) query.tempo = 'slow';
  else if (query.energy === 'high') query.tempo = 'fast';
  else if (query.energy === 'low') query.tempo = 'slow';

  /* duration */
  for (const { re, mul } of DURATION_PATTERNS) {
    const m = re.exec(raw);
    if (m) {
      const value = m[1] ? Number.parseFloat(m[1]) : 1;
      query.durationMinutes = Math.round(Math.min(600, Math.max(5, value * mul)));
      query.limit = Math.max(10, Math.min(80, Math.round(query.durationMinutes / 0.5)));
      break;
    }
  }

  /* explicit filter */
  if (/\b(no explicit|clean|family[- ]friendly|sensitive|non explicit|radio edit)\b/i.test(raw)) query.explicit = false;
  else if (/\b(explicit|nsfw|uncensored|dirty)\b/i.test(raw)) query.explicit = true;

  /* language */
  for (const [label, code] of Object.entries(LANGUAGE_MAP)) {
    if (raw.includes(label)) {
      query.language = code;
      break;
    }
  }

  /* era */
  const decade = /(?:the\s+)?(\d{2})\s?'?s|\b(19|20)(\d{2})s\b/.exec(raw);
  const yearMatch = /\b((?:19|20)\d{2})\b/.exec(raw);
  if (decade) {
    const d = Number(decade[1] ?? decade[3]);
    const full = d < 30 ? 2000 + d : d < 100 ? 1900 + d : d;
    query.era = { from: full, to: full + 9 };
  } else if (yearMatch) {
    const y = Number(yearMatch[1]);
    if (y >= 1900 && y <= new Date().getFullYear() + 1) query.era = { from: y - 2, to: y + 2 };
  }
  const newer = /\b(new|recent|latest|fresh|this year|2026|2025)\b/i.test(raw);
  if (newer && !query.era) query.era = { from: new Date().getFullYear() - 1 };

  /* artist names: only known catalog artists count (never invented) */
  for (const artist of knownArtists) {
    if (!artist) continue;
    if (raw.includes(artist.toLowerCase())) {
      query.artists.push(artist);
      matched.artists.push(artist);
      if (query.intent === 'browse') query.intent = 'similar';
    }
  }
  const quoted = /["“”']([^"“”']{2,60})["“”']/.exec(input ?? '');
  if (quoted && !query.artists.length) {
    const candidate = quoted[1]!.trim();
    const known = knownArtists.find((a) => a.toLowerCase() === candidate.toLowerCase());
    if (known) query.artists.push(known);
  }

  /* "something like <Artist>" */
  const likeMatch = /\b(?:like|similar to|fans of|same as)\s+([a-z0-9 .&'-]{2,40})$/i.exec(raw);
  if (likeMatch) {
    const name = (likeMatch[1] ?? '').trim();
    const known = knownArtists.find((a) => a.toLowerCase().includes(name) && name.length > 2);
    if (known && !query.artists.includes(known)) {
      query.artists.push(known);
      query.intent = 'similar';
    }
  }

  if (query.mood.some((m) => MOODS[m]?.genres.length) && !query.genres.length) {
    for (const m of query.mood) for (const g of MOODS[m]?.genres ?? []) if (!query.genres.includes(g)) query.genres.push(g);
  }

  const confidence = Math.min(
    1,
    0.15 +
      (query.genres.length ? 0.25 : 0) +
      (query.mood.length ? 0.25 : 0) +
      (query.energy ? 0.1 : 0) +
      (query.artists.length ? 0.3 : 0) +
      (query.activity ? 0.15 : 0) +
      (query.durationMinutes ? 0.05 : 0),
  );

  return { query, matched, confidence };
}

function hasWord(text: string, word: string) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`, 'i').test(text);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Human sentence describing the parsed intent — used in the assistant's reply. */
/** Language codes come from LANGUAGE_MAP; the reply echoes a word, not a code. */
const LANGUAGE_LABELS: Record<string, string> = {
  instr: 'instrumental',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  pa: 'Punjabi',
};

/**
 * Human-readable summary of what we heard. It deliberately repeats the user's own framing
 * (activity, era, language) back to them: that is how they notice a mis-parse immediately
 * instead of silently getting a wrong playlist.
 */
export function describeQuery(q: AssistantQuery): string {
  const bits: string[] = [];
  if (q.genres.length) bits.push(q.genres.join(' + '));
  if (q.mood.length) bits.push(q.mood.join('/'));
  if (q.energy) bits.push(`${q.energy} energy`);
  if (q.tempo) bits.push(`${q.tempo} tempo`);
  if (q.language) bits.push(LANGUAGE_LABELS[q.language] ?? q.language);
  if (q.explicit === false) bits.push('clean only');
  if (q.durationMinutes) bits.push(`~${q.durationMinutes} min`);
  if (q.activity) bits.push(`for ${q.activity}`);
  if (q.avoidGenres.length) bits.push(`no ${q.avoidGenres.join('/')}`);
  if (q.era) {
    const from = q.era.from ?? 0;
    const to = q.era.to ?? 0;
    bits.push(q.era.to && to !== from + 9 ? `${from}–${to}` : `since ${from || '…'}`);
  }
  return bits.length ? bits.join(', ') : 'anything in the catalog';
}
