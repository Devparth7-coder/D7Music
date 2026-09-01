import { env, resolveDataPath } from '@d7/config';
import { LocalStorageProvider, S3CompatibleProvider, type AudioStorageProvider } from './providers.js';

export * from './providers.js';
export * from './wav.js';
export * from './synth.js';

let cached: AudioStorageProvider | null = null;

/**
 * Factory: chooses the storage backend from env. Fails loudly (never silently
 * writes audio into Postgres) when a driver is selected without configuration.
 */
export function createAudioStorage(): AudioStorageProvider {
  if (cached) return cached;
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
    cached = new S3CompatibleProvider({
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      cdnBaseUrl: env.STORAGE_PUBLIC_BASE_URL || undefined,
    });
    return cached;
  }
  cached = new LocalStorageProvider(resolveDataPath(env.STORAGE_LOCAL_DIR), {
    secret: env.APP_SECRET,
    publicBase: env.API_PUBLIC_URL,
    cdnBase: env.STORAGE_PUBLIC_BASE_URL || undefined,
  });
  return cached;
}

export function setAudioStorage(p: AudioStorageProvider) {
  cached = p;
}
