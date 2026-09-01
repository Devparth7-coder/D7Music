/**
 * Home + mood surfaces (spec §4). Anonymous visitors get the popularity-driven version of
 * the same shelf list, so the page never renders a spinner-then-empty-state for signed-out users.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MOODS } from '@d7/config';
import { getMoodTracks } from '@d7/database';
import type { Shelf } from '@d7/types';
import { buildHome } from '../lib/shelves.js';
import { ApiError, boolField, cachedJson, intField } from '../lib/http.js';
import { allowExplicitFor, applyExplicitFilter, hydrateTracks } from '../lib/media.js';

export default async function homeRoutes(app: FastifyInstance) {
  app.get('/api/home', async (request, reply) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 12, 4, 24);
    const allowExplicit = allowExplicitFor(user, boolField((request.query as { explicit?: string }).explicit));
    const payload = await cachedJson(app, 'home', [user?.id ?? 'anon', limit], 45, () => buildHome(app, app.d7.db, user, limit));
    const shelves = applyShelfFilter(payload.shelves, allowExplicit);
    reply.header('cache-control', user ? 'private, max-age=20' : 'public, max-age=60, stale-while-revalidate=300');
    return {
      generatedAt: new Date().toISOString(),
      personalized: payload.personalized,
      greeting: payload.greeting,
      shelves,
      signals: user ? await app.d7.recommendations.signals(app.d7.db, user.id).catch(() => null) : null,
    };
  });

  app.get('/api/moods', async () => {
    return {
      moods: Object.entries(MOODS).map(([slug, cfg]) => ({
        slug,
        label: slug.charAt(0).toUpperCase() + slug.slice(1),
        genres: cfg.genres,
        energy: cfg.energy,
        valence: cfg.valence,
      })),
    };
  });

  app.get('/api/moods/:slug', async (request) => {
    const params = request.params as { slug: string };
    const slug = params.slug.toLowerCase();
    const cfg = MOODS[slug];
    if (!cfg) throw ApiError.notFound(`Mood "${slug}"`);
    const query = request.query as { limit?: string };
    const user = await request.optionalUser();
    const limit = intField(query.limit, 18, 4, 40);
    const tracks = await hydrateTracks(app, await getMoodTracks(app.d7.db, slug, limit, user?.id ?? null), user);
    return {
      mood: slug,
      config: cfg,
      tracks: applyExplicitFilter(tracks, allowExplicitFor(user, boolField((request.query as { explicit?: string }).explicit))),
    };
  });
}

/**
 * The explicit-content preference is enforced here rather than in SQL: the same shelf objects
 * are reused by search and playlists, and hiding a card is preferable to a query per surface.
 */
export function applyShelfFilter(shelves: Shelf[], allowExplicit: boolean): Shelf[] {
  if (allowExplicit) return shelves;
  return shelves
    .map((shelf) => ({ ...shelf, items: shelf.items.filter((item) => !(item.type === 'track' && item.track?.explicit)) }))
    .filter((shelf) => shelf.items.length > 0);
}

export const homeQuerySchema = z.object({ limit: z.coerce.number().int().min(4).max(24).optional() });
