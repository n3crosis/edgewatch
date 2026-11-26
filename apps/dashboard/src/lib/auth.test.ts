import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReadKey, fetchApi, onReadKeyChange, readKey, sanitizeReadKey, saveReadKey, signOut, UnauthorizedError, verifyReadKey } from './auth';

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

  it('keeps the key in sessionStorage only, never localStorage, and clears it', () => {
    const changes = vi.fn();
    const off = onReadKeyChange(changes);
    expect(saveReadKey('ew_read_session')).toBe(true);
    expect(sessionStorage.getItem('edgewatch.read_key')).toBe('ew_read_session');
    expect(localStorage.getItem('edgewatch.read_key')).toBeNull();
    expect(readKey()).toBe('ew_read_session');
    clearReadKey();
    expect(readKey()).toBeNull();
    expect(sessionStorage.getItem('edgewatch.read_key')).toBeNull();
    expect(changes).toHaveBeenCalledTimes(2);
    off();
    saveReadKey('ew_read_x');
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('removes a key left in localStorage by an older version instead of using it', () => {
    localStorage.setItem('edgewatch.read_key', 'ew_read_legacy');
    expect(readKey()).toBeNull();
    expect(localStorage.getItem('edgewatch.read_key')).toBeNull();
  });

  it('falls back to memory when browser storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('localStorage', undefined);
    saveReadKey('ew_read_memory');
    expect(readKey()).toBe('ew_read_memory');
  });

  it('sanitizes the token format before storing or sending it', () => {
    expect(sanitizeReadKey('  ew_read_abc-DEF_123\n')).toBe('ew_read_abc-DEF_123');
    expect(sanitizeReadKey('Bearer ew_read_abc')).toBe('ew_read_abc');
    for (const bad of ['', 'ew_read_', 'ew_read_a b', 'ew_read_abc\r\nX-Injected: 1', 'read_abc', 'ew_read_abc?key=1', 'ew_read_é', null]) {
      expect(sanitizeReadKey(bad)).toBeNull();
    }
    expect(saveReadKey('ew_read_bad key')).toBe(false);
    expect(readKey()).toBeNull();
    sessionStorage.setItem('edgewatch.read_key', 'tampered value');
    expect(readKey()).toBeNull();
    expect(sessionStorage.getItem('edgewatch.read_key')).toBeNull();
  });

  it('never puts the key in the URL or a log line', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    saveReadKey('ew_read_secret123');
    const calls: string[] = [];
    const record = vi.fn(async (url: string | URL) => { calls.push(String(url)); return new Response('{}', { status: 401 }); }) as unknown as typeof fetch;
    await fetchApi('https://api.test/v1/projects', {}, record).catch(() => {});
    await verifyReadKey('https://api.test', 'ew_read_secret123', record);
    expect(calls.length).toBe(2);
    expect(calls.join(' ')).not.toContain('secret123');
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret123');
    logs.forEach((spy) => spy.mockRestore());
  });

  it('clears the key on sign-out even when the logout request fails', async () => {
    saveReadKey('ew_read_ok');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(signOut()).rejects.toThrow();
    expect(readKey()).toBeNull();
    saveReadKey('ew_read_ok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await signOut();
    expect(readKey()).toBeNull();
  });

  it('sends the stored key and signs out on 401', async () => {
    saveReadKey('ew_read_ok');
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
    const unused = respond(200);
    expect(await verifyReadKey('https://api.test', 'not a key', unused)).toMatch(/not an EdgeWatch key/);
    expect(unused).not.toHaveBeenCalled();
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
