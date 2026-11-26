import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { auditLog, createKey, KeyError, type KeyStore, listKeys, main, parseDuration, revokeKey, rotateKey } from './keys';

function memoryStore(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async put(k, v) { data.set(k, v); },
    async list(prefix) { return [...data.keys()].filter((k) => k.startsWith(prefix)).sort(); },
  };
}
const NOW = 1_800_000_000;
const record = (store: ReturnType<typeof memoryStore>, raw: string) => JSON.parse(store.data.get(`apikey:${createHash('sha256').update(raw).digest('hex')}`) ?? 'null');

describe('keys', () => {
  test('parses durations', () => {
    expect([parseDuration('90d'), parseDuration('12h'), parseDuration('30m'), parseDuration('45s'), parseDuration('10')]).toEqual([7_776_000, 43_200, 1800, 45, 10]);
    expect(() => parseDuration('soon')).toThrow(KeyError);
  });

  test('creates hashed keys with prefixes, expiry and an audit entry; never stores the raw key', async () => {
    const store = memoryStore();
    const { key, id, record: r } = await createKey(store, { project: 'shop', scopes: ['ingest'], name: 'server', expiresIn: 86_400 }, NOW);
    expect(key).toStartWith('ew_live_');
    expect(id).toHaveLength(12);
    expect(record(store, key)).toEqual({ project_id: 'shop', name: 'server', scopes: ['ingest'], created_at: NOW, expires_at: NOW + 86_400 });
    expect([...store.data.values()].some((v) => v.includes(key))).toBe(false);
    expect(r.expires_at).toBe(NOW + 86_400);
    expect((await createKey(store, { project: 'shop', scopes: ['read'] }, NOW)).key).toStartWith('ew_read_');
    expect((await createKey(store, { project: 'shop', scopes: ['admin'] }, NOW)).record.scopes).toEqual(['admin']);
    expect(await auditLog(store)).toHaveLength(3);
    await expect(createKey(store, { project: 'shop', scopes: ['invalid'] })).rejects.toThrow('Invalid scope invalid');
    await expect(createKey(store, { project: 'bad project', scopes: ['read'] })).rejects.toThrow('Invalid project');
  });

  test('lists keys with status, revokes and audits', async () => {
    const store = memoryStore();
    const a = await createKey(store, { project: 'shop', scopes: ['ingest'], name: 'a' }, NOW);
    const b = await createKey(store, { project: 'shop', scopes: ['read'], name: 'b', expiresIn: 10 }, NOW);
    await revokeKey(store, a.id, NOW + 5);
    expect(record(store, a.key)).toMatchObject({ disabled: true, revoked_at: NOW + 5 });
    const listed = await listKeys(store, NOW + 20);
    expect(Object.fromEntries(listed.map((k) => [k.name, k.status]))).toEqual({ a: 'revoked', b: 'expired' });
    expect((await auditLog(store)).map((e) => e.action)).toEqual(['revoke', 'create', 'create']);
    expect(b.id).not.toBe(a.id);
    await expect(revokeKey(store, 'zz')).rejects.toThrow('Invalid key id');
    await expect(revokeKey(store, 'abcdef')).rejects.toThrow('No key with id abcdef');
  });

  test('rotates: same project, scopes, name and lifetime; old key expires after the grace period or is revoked at once', async () => {
    const store = memoryStore();
    const old = await createKey(store, { project: 'shop', scopes: ['ingest'], name: 'server', expiresIn: 90 * 86_400 }, NOW);
    const r = await rotateKey(store, old.id, 7 * 86_400, NOW + 100);
    expect(record(store, r.key)).toMatchObject({ project_id: 'shop', scopes: ['ingest'], name: 'server', expires_at: NOW + 100 + 90 * 86_400 });
    expect(record(store, old.key)).toMatchObject({ expires_at: NOW + 100 + 7 * 86_400 });
    expect((await auditLog(store))[0]).toMatchObject({ action: 'rotate', key_id: old.id, replaced_by: r.id });
    const now = await rotateKey(store, r.id, 0, NOW + 200);
    expect(record(store, r.key)).toMatchObject({ disabled: true });
    await expect(rotateKey(store, r.id, 0, NOW + 300)).rejects.toThrow('is revoked');
    expect(record(store, now.key).disabled).toBeUndefined();
  });

  test('CLI prints keys once and reports usage errors with exit code 1', async () => {
    const store = memoryStore();
    const lines: string[] = [];
    expect(await main(['create', 'shop', 'ingest,read', 'ci', '--expires', '30d', '--local'], store, (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toMatch(/^Key [0-9a-f]{12} \(ingest,read\) for shop, expires /);
    const id = lines[0].slice(4, 16);
    expect(await main(['list'], store, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toContain(`${id}  active`);
    expect(await main(['rotate', id, '--grace', '1h'], store, (l) => lines.push(l))).toBe(0);
    expect(await main(['revoke', id], store, (l) => lines.push(l))).toBe(0);
    expect(await main(['audit', '--limit', '2'], store, (l) => lines.push(l))).toBe(0);
    expect(lines.slice(-2).map((l) => l.split(/\s+/)[1])).toEqual(['revoke', 'rotate']);
    expect(await main(['create'], store, (l) => lines.push(l))).toBe(1);
    expect(await main(['nope'], store, (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toStartWith('Error: Usage: keys');
  });
});
