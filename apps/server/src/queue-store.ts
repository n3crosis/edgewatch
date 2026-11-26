import { Database } from 'bun:sqlite';
import type { Pending, QueueStore } from './queue';

/** One process owns this journal. Commits complete before ingest acknowledges acceptance. */
export class SqliteQueueStore<T> implements QueueStore<T> {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS queue_messages (
        queue TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (queue, id)
      )`);
  }

  load(queue: string): Pending<T>[] {
    const rows = this.db.query('SELECT payload FROM queue_messages WHERE queue = ? ORDER BY rowid').all(queue) as { payload: string }[];
    return rows.map(({ payload }) => {
      const p = JSON.parse(payload) as Pending<T>;
      return { ...p, timestamp: new Date(p.timestamp) };
    });
  }

  commit(queue: string, remove: string[], put: Pending<T>[]): void {
    this.db.transaction(() => {
      const del = this.db.query('DELETE FROM queue_messages WHERE queue = ? AND id = ?');
      const insert = this.db.query('INSERT OR REPLACE INTO queue_messages (queue, id, payload) VALUES (?, ?, ?)');
      for (const id of remove) del.run(queue, id);
      for (const p of put) insert.run(queue, p.id, JSON.stringify(p));
    })();
  }

  close(): void {
    this.db.close();
  }
}
