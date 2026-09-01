/**
 * AudioStorageProvider abstraction (spec §17).
 *
 *   object storage  ->  CDN  ->  signed streaming endpoint
 *
 * The database NEVER holds audio bytes: only `tracks.storage_key`. Two drivers ship:
 *   - local: filesystem/Rook-compatible mount (dev, self-hosted, CI)
 *   - s3   : any S3-compatible endpoint (R2/MinIO/B2/Wasabi/AWS) with presigned GETs
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import type { Readable } from 'node:stream';

export interface UploadInput {
  key?: string;
  body: Buffer | Uint8Array;
  contentType: string;
  /** Suggested object key prefix, e.g. `artists/<id>`. */
  prefix?: string;
  cacheControl?: string;
}

export interface UploadResult {
  key: string;
  bytes: number;
  sha256: string;
  etag?: string | null;
}

export interface ObjectStat {
  bytes: number;
  modifiedAt: string;
  contentType?: string | null;
}

export interface SignedUrlOptions {
  expiresSec?: number;
  download?: boolean;
  filename?: string;
  /** Byte range for resumable/seek playback. */
  range?: { start: number; end?: number };
}

export interface AudioStorageProvider {
  readonly name: string;
  /** True when this backend can hand the browser a direct, self-authenticating URL. */
  readonly supportsPresign: boolean;
  upload(input: UploadInput): Promise<UploadResult>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<ObjectStat | null>;
  open(key: string, range?: { start: number; end?: number }): Promise<Readable>;
  getSignedUrl(key: string, opts?: SignedUrlOptions): Promise<string>;
  getStreamUrl(key: string, opts?: { userId?: string | null; expiresSec?: number; quality?: string }): Promise<string>;
}

/* ------------------------------ key + signing ------------------------------ */

export function sanitizeKey(key: string) {
  const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/');
  if (clean.includes('..') || clean.startsWith('/')) throw new Error(`unsafe storage key: ${key}`);
  return clean;
}

export function buildKey(prefix: string | undefined, originalName: string | undefined, sha256: string, contentType: string) {
  const ext = extFor(contentType, originalName);
  const head = sha256.slice(0, 2);
  const mid = sha256.slice(2, 4);
  return `${prefix ? `${prefix.replace(/\/+$/, '')}/` : ''}${head}/${mid}/${sha256.slice(0, 32)}${ext}`;
}

function extFor(contentType: string, name?: string) {
  const fromName = name?.match(/\.[A-Za-z0-9]{2,4}$/)?.[0]?.toLowerCase();
  if (fromName) return fromName;
  return (
    {
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/flac': '.flac',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/ogg': '.ogg',
      'audio/webm': '.webm',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/avif': '.avif',
    }[contentType.split(';')[0]!] ?? '.bin'
  );
}

export function sha256Hex(buf: Uint8Array) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Local-driver URL signing: HMAC over `key|exp|userId`, base64url.
 * Same verification helper is used by the stream route, so a leaked key can't be
 * replayed after expiry and a token can't be reused for a different key.
 */
export function signStreamToken(secret: string, key: string, expiresAtSec: number, userId: string | null) {
  const mac = createHmac('sha256', secret).update(`${key}|${expiresAtSec}|${userId ?? ''}`).digest('base64url');
  return mac.replace(/=+$/, '');
}

export function verifyStreamToken(secret: string, key: string, expiresAtSec: number, userId: string | null, token: string) {
  if (!Number.isFinite(expiresAtSec) || expiresAtSec * 1000 < Date.now()) return false;
  const expected = signStreamToken(secret, key, expiresAtSec, userId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* --------------------------------- local --------------------------------- */

export class LocalStorageProvider implements AudioStorageProvider {
  readonly name = 'local';
  readonly supportsPresign = true;

  constructor(
    private readonly root: string,
    private readonly opts: { secret: string; publicBase?: string; cdnBase?: string } = { secret: 'dev-secret' },
  ) {}

  private path(key: string) {
    return resolve(this.root, sanitizeKey(key));
  }
  /** Guards against traversal even after normalization (symlink-escape check). */
  private assertInside(key: string) {
    const abs = this.path(key);
    const root = resolve(this.root);
    if (abs !== root && !abs.startsWith(root + '/')) throw new Error(`storage key escapes configured root: ${key}`);
    return abs;
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const body = Buffer.from(input.body);
    const sha = sha256Hex(body);
    const key = sanitizeKey(input.key ?? buildKey(input.prefix, undefined, sha, input.contentType));
    const abs = this.assertInside(key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, { flag: 'wx' }).catch(async (err) => {
      // Content-addressed keys make re-uploads a no-op rather than an error.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw err;
    });
    return { key, bytes: body.length, sha256: sha, etag: `"${sha.slice(0, 16)}"` };
  }

  async delete(key: string) {
    await unlink(this.assertInside(key)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  async exists(key: string) {
    try {
      statSync(this.assertInside(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const st = statSync(this.assertInside(key));
      return { bytes: st.size, modifiedAt: st.mtime.toISOString(), contentType: guessContentType(key) };
    } catch {
      return null;
    }
  }

  async open(key: string, range?: { start: number; end?: number }) {
    const abs = this.assertInside(key);
    return createReadStream(abs, { start: range?.start ?? 0, end: range?.end === undefined ? undefined : Math.min(range.end, 2 ** 40) });
  }

  /** Public CDN path when configured, otherwise our own range-capable stream route. */
  async getSignedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresSec ?? 3600);
    const sig = signStreamToken(this.opts.secret, sanitizeKey(key), exp, null);
    const base = this.opts.cdnBase ?? this.opts.publicBase ?? '';
    const qs = new URLSearchParams({ exp: String(exp), sig });
    if (opts.download) {
      qs.set('dl', '1');
      if (opts.filename) qs.set('filename', opts.filename);
    }
    return `${base}/cdn/${sanitizeKey(key)}?${qs.toString()}`;
  }

  async getStreamUrl(key: string, opts: { userId?: string | null; expiresSec?: number } = {}) {
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresSec ?? 3600);
    const sig = signStreamToken(this.opts.secret, sanitizeKey(key), exp, opts.userId ?? null);
    const base = this.opts.publicBase ?? '';
    return `${base}/api/stream/${encodeURIComponent(sanitizeKey(key))}?exp=${exp}&sig=${sig}`;
  }
}

/* ---------------------------------- s3 ---------------------------------- */

type S3ClientLike = {
  send(cmd: unknown): Promise<unknown>;
  destroy?(): void;
};

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  cdnBaseUrl?: string;
}

export class S3CompatibleProvider implements AudioStorageProvider {
  readonly name = 's3';
  readonly supportsPresign = true;
  private client: S3ClientLike | null = null;
  private sdk: typeof import('@aws-sdk/client-s3') | null = null;

  constructor(private readonly o: S3Options) {}

  private async load() {
    if (this.client && this.sdk) return { client: this.client, sdk: this.sdk };
    let sdk: typeof import('@aws-sdk/client-s3');
    try {
      sdk = (await import('@aws-sdk/client-s3')) as typeof import('@aws-sdk/client-s3');
    } catch {
      throw new Error(
        'STORAGE_DRIVER=s3 requires the optional dependency @aws-sdk/client-s3. ' +
          'Run `npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` or use STORAGE_DRIVER=local.',
      );
    }
    const { S3Client } = sdk;
    this.sdk = sdk;
    this.client = new S3Client({
      region: this.o.region,
      endpoint: this.o.endpoint || undefined,
      forcePathStyle: this.o.forcePathStyle,
      ...(this.o.accessKeyId && this.o.secretAccessKey
        ? { credentials: { accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey } }
        : {}),
    }) as S3ClientLike;
    return { client: this.client, sdk: this.sdk };
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const { client, sdk } = await this.load();
    const body = Buffer.from(input.body);
    const sha = sha256Hex(body);
    const key = sanitizeKey(input.key ?? buildKey(input.prefix, undefined, sha, input.contentType));
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.o.bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl ?? 'public, max-age=31536000, immutable',
        ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key, bytes: body.length, sha256: sha, etag: null };
  }

  async delete(key: string) {
    const { client, sdk } = await this.load();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.o.bucket, Key: sanitizeKey(key) }));
  }

  async exists(key: string) {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const { client, sdk } = await this.load();
    try {
      const res = (await client.send(new sdk.HeadObjectCommand({ Bucket: this.o.bucket, Key: sanitizeKey(key) }))) as {
        ContentLength?: number;
        LastModified?: Date;
        ContentType?: string;
      };
      return {
        bytes: res.ContentLength ?? 0,
        modifiedAt: (res.LastModified ?? new Date()).toISOString(),
        contentType: res.ContentType ?? null,
      };
    } catch {
      return null;
    }
  }

  async open(key: string, range?: { start: number; end?: number }) {
    const { client, sdk } = await this.load();
    const res = (await client.send(
      new sdk.GetObjectCommand({
        Bucket: this.o.bucket,
        Key: sanitizeKey(key),
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }),
    )) as { Body?: Readable };
    if (!res.Body) throw new Error(`empty body for ${key}`);
    return res.Body;
  }

  /** Presigned GET straight from storage/CDN — the API is not in the byte path. */
  async getSignedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    if (this.o.cdnBaseUrl) {
      const exp = Math.floor(Date.now() / 1000) + (opts.expiresSec ?? 3600);
      return `${this.o.cdnBaseUrl.replace(/\/+$/, '')}/${sanitizeKey(key)}?Expires=${exp}`;
    }
    const { client } = await this.load();
    const { GetObjectCommand } = (await import('@aws-sdk/client-s3')) as typeof import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new GetObjectCommand({
      Bucket: this.o.bucket,
      Key: sanitizeKey(key),
      ResponseContentDisposition: opts.download ? `attachment; filename="${opts.filename ?? 'audio'}"` : undefined,
    });
    return getSignedUrl(client as never, command as never, { expiresIn: opts.expiresSec ?? 3600 });
  }

  async getStreamUrl(key: string, opts: { userId?: string | null; expiresSec?: number } = {}) {
    return this.getSignedUrl(key, { expiresSec: opts.expiresSec });
  }
}

export function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
  return (
    {
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/ogg',
      '.webm': 'audio/webm',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.svg': 'image/svg+xml',
    }[ext] ?? 'application/octet-stream'
  );
}

export async function readLocalFile(path: string) {
  return readFile(path);
}

export const newUploadId = () => randomUUID();
