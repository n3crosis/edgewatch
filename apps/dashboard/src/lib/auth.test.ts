import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReadKey, fetchApi, onReadKeyChange, readKey, saveReadKey, UnauthorizedError, verifyReadKey } from './auth';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

const respond = (status: number) => vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;

describe('read key storage', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('localStorage', new MemoryStorage());
  });
  afterEach(() => {
    clearReadKey();
    vi.unstubAllGlobals();
  });

  it('keeps the key for the session by default, in localStorage when remembered, and clears both', () => {
    const changes = vi.fn();
    const off = onReadKeyChange(changes);
    saveReadKey('ew_read_session', false);
    expect(sessionStorage.getItem('edgewatch.read_key')).toBe('ew_read_session');
    expect(localStorage.getItem('edgewatch.read_key')).toBeNull();
    saveReadKey('ew_read_remembered', true);
    expect(readKey()).toBe('ew_read_remembered');
    expect(sessionStorage.getItem('edgewatch.read_key')).toBeNull();
    clearReadKey();
    expect(readKey()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
    off();
    saveReadKey('ew_read_x', false);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('falls back to memory when browser storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('localStorage', undefined);
    saveReadKey('ew_read_memory', true);
    expect(readKey()).toBe('ew_read_memory');
  });

  it('sends the stored key and signs out on 401', async () => {
    saveReadKey('ew_read_ok', false);
    const ok = respond(200);
    await fetchApi('https://api.test/v1/projects', { method: 'POST', body: '{}' }, ok);
    expect(ok).toHaveBeenCalledWith('https://api.test/v1/projects', { method: 'POST', body: '{}', credentials: 'include', headers: { authorization: 'Bearer ew_read_ok', 'content-type': 'application/json' } });
    await expect(fetchApi('https://api.test/v1/projects', {}, respond(401))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(readKey()).toBeNull();
    const anon = respond(200);
    await fetchApi('https://api.test/v1/projects', {}, anon);
    expect(anon).toHaveBeenCalledWith('https://api.test/v1/projects', { credentials: 'include', headers: {} });
  });

  it('verifies a key before it is stored', async () => {
    expect(await verifyReadKey('https://api.test', '  ')).toBe('Enter a read key.');
    expect(await verifyReadKey('https://api.test', 'ew_read_ok', respond(200))).toBeNull();
    expect(await verifyReadKey('https://api.test', 'ew_read_bad', respond(401))).toMatch(/not accepted/);
    expect(await verifyReadKey('https://api.test', 'ew_read_ok', respond(503))).toMatch(/HTTP 503/);
    const down = vi.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    expect(await verifyReadKey('https://api.test', 'ew_read_ok', down)).toBe('Could not reach the EdgeWatch API at https://api.test.');
  });
});

describe('bundle', () => {
  it('never reads a key from build-time env (VITE_API_KEY would be shipped to every visitor)', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const offenders = files(join(__dirname, '..')).filter((f) => !f.endsWith('.test.ts') && /VITE_API_KEY|VITE_[A-Z_]*(KEY|TOKEN|SECRET)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
