/**
 * Provider registry: the ONLY place that decides which concrete providers exist.
 * Selection is driven entirely by env vars — no third-party service is hard-coded,
 * and an unusable configuration produces a loud, specific error instead of fake data.
 */
import { env } from '@d7/config';
import type { ProviderDescriptor } from '@d7/types';
import { ConfigurableHttpProvider, type JsonMap } from './audio/configurableHttpProvider.js';
import { LocalLibraryProvider, type LocalCatalogSource } from './audio/localLibrary.js';
import { NotConfiguredProvider } from './audio/notConfigured.js';
import { MusicBrainzProvider } from './metadata/musicbrainz.js';
import type { MetadataProvider, MusicProvider } from './types.js';

export interface BuildProvidersOptions {
  localCatalog?: LocalCatalogSource;
  fetchImpl?: typeof fetch;
  musicProvider?: string;
  metadataProviders?: string[];
}

export interface BuiltProviders {
  audio: MusicProvider;
  metadata: MetadataProvider[];
  descriptors: ProviderDescriptor[];
  /** Human-readable startup summary — logged once, also surfaced in /api/admin/providers. */
  summary: string[];
}

function safeJson<T>(raw: string, label: string, errors: string[]): T | undefined {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    errors.push(`${label} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

export function buildProviders(opts: BuildProvidersOptions = {}): BuiltProviders {
  const reasons: string[] = [];
  const name = (opts.musicProvider ?? env.MUSIC_PROVIDER).trim() || 'none';
  let audio: MusicProvider;

  if (name === 'none' || name === 'off') {
    audio = new NotConfiguredProvider(name, 'MUSIC_PROVIDER=none, so only platform-owned uploads are streamable');
    reasons.push('external audio disabled by configuration');
  } else if (name === 'local_library') {
    audio = opts.localCatalog
      ? new LocalLibraryProvider(opts.localCatalog)
      : new NotConfiguredProvider(name, 'no LocalCatalogSource injected (database not wired up)');
  } else if (name === 'json_http') {
    if (!env.MUSIC_PROVIDER_BASE_URL) {
      audio = new NotConfiguredProvider(name, 'MUSIC_PROVIDER_BASE_URL is empty');
    } else if (!env.MUSIC_PROVIDER_API_KEY) {
      audio = new NotConfiguredProvider(name, 'MUSIC_PROVIDER_API_KEY is empty');
    } else {
      const map = safeJson<JsonMap>(env.MUSIC_PROVIDER_MAP_JSON, 'MUSIC_PROVIDER_MAP_JSON', reasons) ?? {};
      const endpoints =
        safeJson<Record<string, string>>(env.MUSIC_PROVIDER_ENDPOINTS_JSON, 'MUSIC_PROVIDER_ENDPOINTS_JSON', reasons) ?? {};
      audio = new ConfigurableHttpProvider({
        name: 'licensed_http',
        baseUrl: env.MUSIC_PROVIDER_BASE_URL,
        apiKey: env.MUSIC_PROVIDER_API_KEY,
        timeoutMs: env.MUSIC_PROVIDER_TIMEOUT_MS,
        rps: env.MUSIC_PROVIDER_RPS,
        maxRetries: env.MUSIC_PROVIDER_MAX_RETRIES,
        map,
        endpoints,
        fetchImpl: opts.fetchImpl,
      });
    }
  } else {
    audio = new NotConfiguredProvider(
      name,
      `no adapter registered for "${name}". Add one under packages/music-providers/src/audio/ and wire it here.`,
    );
  }

  const metadata: MetadataProvider[] = [];
  const wanted = opts.metadataProviders ?? env.METADATA_PROVIDERS;
  for (const m of wanted) {
    if (m === 'musicbrainz') {
      if (!/contact|mailto|@/.test(env.MUSICBRAINZ_USER_AGENT)) {
        reasons.push(
          'MUSICBRAINZ_USER_AGENT should contain a contact address per API policy; metadata lookups may be throttled.',
        );
      }
      metadata.push(
        new MusicBrainzProvider({
          baseUrl: env.MUSICBRAINZ_BASE_URL,
          userAgent: env.MUSICBRAINZ_USER_AGENT,
          timeoutMs: env.MUSIC_PROVIDER_TIMEOUT_MS,
          maxRetries: env.MUSIC_PROVIDER_MAX_RETRIES,
          rps: 1,
          fetchImpl: opts.fetchImpl,
        }),
      );
    } else {
      reasons.push(`metadata provider "${m}" requested but no adapter is registered`);
    }
  }

  const configured = !(audio instanceof NotConfiguredProvider);
  const audioReasons = configured
    ? []
    : [
        audio instanceof NotConfiguredProvider ? audio.reason : 'provider unavailable',
        ...reasons.filter((r) => r.includes(name)),
      ];
  const descriptors: ProviderDescriptor[] = [
    {
      name: audio.name,
      kind: 'audio',
      enabled: configured,
      configured,
      supportsNewReleases: audio.capabilities.newReleases,
      reasons: audioReasons,
    },
    ...metadata.map((m) => ({
      name: m.name,
      kind: 'metadata' as const,
      enabled: true,
      configured: true,
      supportsNewReleases: true,
      reasons: ['discovery/metadata only — cannot stream audio'],
    })),
  ];

  const summary = [
    `audio provider: ${audio.name}${configured ? '' : ` (inactive — ${audioReasons.join('; ')})`}`,
    `metadata providers: ${metadata.length ? metadata.map((m) => m.name).join(', ') : 'none'}`,
    ...(reasons.length ? [`config notes: ${reasons.join(' | ')}`] : []),
  ];

  return { audio, metadata, descriptors, summary };
}

