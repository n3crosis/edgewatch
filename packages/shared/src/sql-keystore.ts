import type { KeyStore, SqlDatabase } from './storage';

/**
 * KeyStore in the event store's `kv_store` table (migration 0016), for deployments without Workers KV. Same JSON values
 * and `expirationTtl` semantics as KV. `cacheTtl` is honoured with a per-isolate memory cache, like KV's edge cache:
 * a changed or revoked key can be served stale for up to that many seconds.
 */
export class SqlKeyStore implements KeyStore {
  private readonly cache = new Map<string, { value: string | null; until: number }>();

  constructor(private readonly db: SqlDatabase, private readonly now: () => number = Date.now) {}

  async getText(key: string, cacheTtl = 0): Promise<string | null> {
    const t = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > t) return hit.value;
    const row = await this.db.prepare('SELECT value, expires_at FROM kv_store WHERE name = ?').bind(key).first<{ value: string; expires_at: number | null }>();
    const value = row && (row.expires_at === null || row.expires_at > t) ? row.value : null;
    if (cacheTtl > 0) {
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(key, { value, until: t + cacheTtl * 1000 });
    }
    return value;
  }

  async get<T>(key: string, options: { type: 'json'; cacheTtl?: number }): Promise<T | null> {
    const text = await this.getText(key, options.cacheTtl);
    return text === null ? null : (JSON.parse(text) as T);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expires = options?.expirationTtl ? this.now() + options.expirationTtl * 1000 : null;
    await this.db.prepare('INSERT INTO kv_store (name, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
      .bind(key, value, expires).run();
    this.cache.delete(key);
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM kv_store WHERE name = ?').bind(key).run();
    this.cache.delete(key);
  }

  /** Live key names starting with `prefix` (key CLI: list, audit). */
  async list(prefix: string): Promise<string[]> {
    const { results } = await this.db.prepare("SELECT name FROM kv_store WHERE substr(name, 1, ?2) = ?1 AND (expires_at IS NULL OR expires_at > ?3) ORDER BY name")
      .bind(prefix, prefix.length, this.now()).all<{ name: string }>();
    return results.map((r) => r.name);
  }

  /** Removes expired rows (KV does this itself). Returns the number deleted. */
  async purgeExpired(): Promise<number> {
    const r = await this.db.prepare('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(this.now()).run();
    return r.meta.changes ?? 0;
  }
}
