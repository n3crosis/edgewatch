import { errorFields, log } from '@edgewatch/shared';
import type { Env } from './process';

/** usage_daily rows are kept this long (about 13 months), independent of RETENTION_DAYS. */
export const USAGE_KEEP_DAYS = 400;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number) => Math.floor(ms / 86_400_000 + 1) * 86_400;

/**
 * Adds processed records to usage_daily and, when a project reaches its daily record quota, writes the over-quota
 * block (`project:<id>` in KV, read by ingest) until the next UTC midnight. Each project is blocked at most once a day,
 * so KV sees one write per project per day. A longer block already in KV (set by hand) is kept.
 */
export async function recordUsage(env: Env, records: Map<string, number>, now = Date.now(), receipt?: string): Promise<{ blocked: string[] }> {
  const entries = [...records].filter(([, n]) => n > 0);
  if (!entries.length) return { blocked: [] };
  const day = utcDay(now);
  const fallback = Number(env.DAILY_RECORD_QUOTA) || null;
  // Upsert then read back (no RETURNING, which MySQL lacks); a batch runs in order, so each SELECT sees its upsert.
  const rows = await env.DB.batch<{ project_id: string; records: number; quota: number | null; blocked_at: number | null }>(
    entries.flatMap(([project, n]) => [
      env.DB.prepare(
        `INSERT INTO usage_daily (project_id, day, records, quota)
         VALUES (?1, ?2,
           CASE WHEN ?5 IS NULL OR NOT EXISTS (SELECT 1 FROM usage_receipts WHERE project_id = ?1 AND receipt = ?5) THEN ?3 ELSE 0 END,
           coalesce((SELECT daily_record_quota FROM projects WHERE id = ?1), ?4))
         ON CONFLICT (project_id, day) DO UPDATE SET records = usage_daily.records + excluded.records, quota = excluded.quota`,
      ).bind(project, day, n, fallback, receipt ?? null),
      ...(receipt ? [env.DB.prepare('INSERT OR IGNORE INTO usage_receipts (project_id, receipt, day) VALUES (?, ?, ?)').bind(project, receipt, day)] : []),
      env.DB.prepare('SELECT project_id, records, quota, blocked_at FROM usage_daily WHERE project_id = ? AND day = ?').bind(project, day),
    ]),
  );
  const over = rows.filter((_, i) => i % (receipt ? 3 : 2) === (receipt ? 2 : 1)).flatMap((r) => r.results).filter((r) => r.quota && r.records >= r.quota && r.blocked_at === null);
  const blocked: string[] = [];
  const until = nextUtcMidnight(now);
  for (const row of over) {
    try {
      if (!env.API_KEYS) throw new Error('API_KEYS binding is missing');
      const key = `project:${row.project_id}`;
      const current = await env.API_KEYS.get<{ over_quota_until?: number }>(key, { type: 'json' });
      if (!current?.over_quota_until || current.over_quota_until < until) {
        await env.API_KEYS.put(key, JSON.stringify({ over_quota_until: until, message: `Daily record quota of ${row.quota} reached.`, reason: 'daily_quota' }));
      }
      await env.DB.prepare('UPDATE usage_daily SET blocked_at = ? WHERE project_id = ? AND day = ?').bind(now, row.project_id, day).run();
      blocked.push(row.project_id);
      log('consumer', 'warn', 'daily_quota_reached', { project_id: row.project_id, records: row.records, quota: row.quota, until });
    } catch (e) {
      log('consumer', 'error', 'quota_block_failed', { project_id: row.project_id, ...errorFields(e) });
    }
  }
  return { blocked };
}
