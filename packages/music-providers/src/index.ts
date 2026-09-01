/** @d7/music-providers — public surface. */
export { buildProviders, type BuiltProviders, type BuildProvidersOptions } from './registry.js';
export { ConfigurableHttpProvider, normalizeDate, parseDuration, type JsonMap, type ConfigurableProviderOptions } from './audio/configurableHttpProvider.js';
export { LocalLibraryProvider, type LocalCatalogSource } from './audio/localLibrary.js';
export { NotConfiguredProvider } from './audio/notConfigured.js';
export { MusicBrainzProvider, type MusicBrainzOptions } from './metadata/musicbrainz.js';
export { TokenBucketLimiter, withRetry, backoffDelay, isRetryableStatus, type RetryOptions, type RateLimiterOptions } from './http/rateLimiter.js';
export { requestJson, buildUrl, parseRetryAfter, type HttpOptions, type JsonRequest } from './http/client.js';
export * from './types.js';
