import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BlobObject, BlobStore } from '@edgewatch/shared';

/** BlobStore on a local directory: one file per key, written atomically (temp file + rename). */
export class FsBlobStore implements BlobStore {
  constructor(readonly dir: string) {}

  private path(key: string): string {
    if (!key || key.includes('\\') || key.includes('\0') || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new TypeError('Invalid blob key');
    }
    return join(this.dir, key);
  }

  async get(key: string): Promise<BlobObject | null> {
    let data: Buffer;
    try {
      data = await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const text = data.toString('utf8');
    return {
      size: data.byteLength,
      get body() {
        return new Response(text).body as ReadableStream;
      },
      text: () => Promise.resolve(text),
      json: <T>() => Promise.resolve(JSON.parse(text) as T),
    };
  }

  async put(key: string, value: string): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, value);
    await rename(tmp, file);
  }

  async delete(keys: string | string[]): Promise<void> {
    await Promise.all((Array.isArray(keys) ? keys : [keys]).map((k) => rm(this.path(k), { force: true })));
  }
}
