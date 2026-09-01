/** Small hardened JSON HTTP client shared by all provider adapters. */
import { ProviderError, type ProviderError as PE } from '../types.js';

export interface HttpOptions {
  baseUrl: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Used to distinguish 401 vs "not configured" in admin UI. */
  provider: string;
  fetchImpl?: typeof fetch;
}

export interface JsonRequest {
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

export function buildUrl(baseUrl: string, path: string, query?: JsonRequest['query']) {
  const url = new URL(path.startsWith('http') ? path : `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

export async function requestJson<T = unknown>(opts: HttpOptions, req: JsonRequest): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
  const url = buildUrl(opts.baseUrl, req.path, req.query);
  try {
    const res = await doFetch(url, {
      method: req.method ?? 'GET',
      signal,
      headers: {
        accept: 'application/json',
        ...(opts.headers ?? {}),
        ...(req.body ? { 'content-type': 'application/json' } : {}),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new ProviderError(
        `${opts.provider} HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 180)}` : ''}`,
        opts.provider,
        isRetryable(res.status),
        res.status,
      ) as PE & { retryAfterMs?: number };
      if (retryAfterMs) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    const ct = res.headers.get('content-type') ?? '';
    const payload = ct.includes('json') ? await res.json() : await res.text();
    if (typeof payload === 'string') {
      // MusicBrainz answers JSON only with the right content-type; treat str as error shape.
      try {
        return JSON.parse(payload) as T;
      } catch {
        throw new ProviderError(`${opts.provider} returned non-JSON payload`, opts.provider, false, res.status);
      }
    }
    return payload as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const msg = (err as Error)?.message ?? String(err);
    if (/abort/i.test(msg)) throw new ProviderError(`${opts.provider} request timed out after ${opts.timeoutMs}ms`, opts.provider, true);
    throw new ProviderError(`${opts.provider} network error: ${msg}`, opts.provider, true);
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
