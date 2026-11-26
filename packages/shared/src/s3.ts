import { AwsClient } from 'aws4fetch';
import type { BlobObject, BlobPutOptions, BlobStore } from './storage';

export interface S3Config {
  /** e.g. https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://localhost:9000 (MinIO). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Signing region. Default `auto` (R2); use the bucket's region for AWS. */
  region?: string;
  /** Parallel DELETE requests when deleting many keys. Default 8. */
  deleteConcurrency?: number;
  fetch?: typeof fetch;
}

/** S3 request failure. The message has the operation and status only: never the response body or credentials. */
export class S3Error extends Error {
  constructor(readonly operation: string, readonly status: number) {
    super(`S3 ${operation} failed with HTTP ${status}`);
    this.name = 'S3Error';
  }
}

/**
 * BlobStore on any S3-compatible API (AWS S3, R2's S3 endpoint, MinIO, Backblaze B2, ...), signed with SigV4 through
 * aws4fetch so it runs on Workers, Node and Bun. Objects are addressed path-style: `<endpoint>/<bucket>/<key>`.
 */
export function s3BlobStore(config: S3Config): BlobStore {
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: config.region ?? 'auto' });
  const base = `${config.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}/`;
  const url = (key: string) => base + key.split('/').map(encodeURIComponent).join('/');
  const doFetch = config.fetch ?? fetch;
  const send = async (operation: string, key: string, init: RequestInit, ok: (status: number) => boolean) => {
    const res = await doFetch(await client.sign(url(key), init));
    if (!ok(res.status)) {
      await res.body?.cancel();
      throw new S3Error(operation, res.status);
    }
    return res;
  };
  const concurrency = Math.max(1, config.deleteConcurrency ?? 8);

  return {
    async get(key) {
      const res = await send('GetObject', key, { method: 'GET' }, (s) => s === 200 || s === 404);
      if (res.status === 404 || !res.body) {
        await res.body?.cancel();
        return null;
      }
      const size = Number(res.headers.get('content-length') ?? 0);
      let used = false;
      const take = () => {
        if (used) throw new TypeError('S3 object body already read');
        used = true;
        return res;
      };
      const object: BlobObject = {
        get body() { return take().body as ReadableStream; },
        size,
        text: () => take().text(),
        json: async <T>() => JSON.parse(await take().text()) as T,
      };
      return object;
    },

    async put(key, value, options?: BlobPutOptions) {
      const headers: Record<string, string> = { 'content-type': options?.httpMetadata?.contentType ?? 'application/octet-stream' };
      for (const [k, v] of Object.entries(options?.customMetadata ?? {})) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      const res = await send('PutObject', key, { method: 'PUT', headers, body: value }, (s) => s >= 200 && s < 300);
      await res.body?.cancel();
      return { key };
    },

    async delete(keys) {
      const queue = typeof keys === 'string' ? [keys] : [...keys];
      const worker = async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          const res = await send('DeleteObject', key, { method: 'DELETE' }, (s) => (s >= 200 && s < 300) || s === 404);
          await res.body?.cancel();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    },
  };
}
