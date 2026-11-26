import { randomUUID } from 'node:crypto';
import { errorFields, log, type IngestQueue } from '@edgewatch/shared';

export interface Pending<T> {
  id: string;
  body: T;
  timestamp: Date;
  attempts: number;
  notBefore: number;
}

export interface QueueStore<T> {
  load(queue: string): Pending<T>[];
  commit(queue: string, remove: string[], put: Pending<T>[]): void;
}

export interface LocalQueueOptions<T> {
  store?: QueueStore<T>;
  /** Messages per consumer call (consumer max_batch_size). */
  maxBatchSize?: number;
  /** How long a partial batch waits before it is delivered (consumer max_batch_timeout). */
  batchTimeoutMs?: number;
  /** Deliveries after the first before a message goes to the dead-letter queue (consumer max_retries). */
  maxRetries?: number;
  /** Messages held in memory before sendBatch refuses more (the ingest Worker then answers 503). */
  maxPending?: number;
  deadLetter?: LocalQueue<T>;
  now?: () => number;
}

export class QueueFullError extends Error {
  constructor(readonly queue: string) {
    super(`Queue ${queue} is full`);
    this.name = 'QueueFullError';
  }
}

/**
 * In-process stand-in for a Cloudflare Queue with the same delivery contract the consumer relies on: batches of up to
 * maxBatchSize, per-message ack/retry with delay, retries counted in `attempts`, then the dead-letter queue.
 * With a store, accepted messages and delayed retries survive restarts. Delivery is at least once.
 */
export class LocalQueue<T> implements IngestQueue<T> {
  private pending: Pending<T>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private readonly o: Required<Omit<LocalQueueOptions<T>, 'deadLetter' | 'store'>> & Pick<LocalQueueOptions<T>, 'deadLetter' | 'store'>;

  constructor(
    readonly name: string,
    private readonly handler: (batch: MessageBatch<T>) => Promise<void>,
    options: LocalQueueOptions<T> = {},
  ) {
    this.o = { maxBatchSize: 50, batchTimeoutMs: 1000, maxRetries: 20, maxPending: 10_000, now: Date.now, ...options };
    this.pending = this.o.store?.load(name) ?? [];
    this.schedule();
  }

  get size(): number {
    return this.pending.length;
  }

  /** maxPending: sendBatch refuses messages beyond this many. */
  get capacity(): number {
    return this.o.maxPending;
  }

  async sendBatch(messages: Iterable<{ body: T }>): Promise<void> {
    const list = [...messages];
    if (this.closed || this.pending.length + list.length > this.o.maxPending) throw new QueueFullError(this.name);
    const now = this.o.now();
    const added = list.map((m) => ({ id: randomUUID(), body: m.body, timestamp: new Date(now), attempts: 1, notBefore: now }));
    this.o.store?.commit(this.name, [], added);
    this.pending.push(...added);
    this.schedule();
  }

  /** Delivers every due message now (all of them, ignoring retry delays, with `force`). */
  drain(force = false): Promise<void> {
    if (this.running) return this.running.then(() => this.drain(force));
    this.running = this.drainDue(force).finally(() => {
      this.running = undefined;
      this.schedule();
    });
    return this.running;
  }

  private async drainDue(force: boolean): Promise<void> {
    // Force only delays already queued on entry; newly scheduled retries still back off.
    if (force) this.pending = this.pending.map((p) => ({ ...p, notBefore: this.o.now() }));
    for (;;) {
      const batch = this.take(false);
      if (!batch.length) return;
      try {
        await this.deliver(batch);
      } catch (e) {
        // A failed durable commit must never discard ownership in memory either.
        const ids = new Set(batch.map((p) => p.id));
        this.pending = this.pending.filter((p) => !ids.has(p.id));
        this.pending.push(...batch.map((p) => ({ ...p, notBefore: this.o.now() + 1000 })));
        throw e;
      }
    }
  }

  /** Stops accepting messages and delivers what is due. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.running || !this.pending.length) return;
    const now = this.o.now();
    const due = this.pending.filter((p) => p.notBefore <= now).length;
    const next = Math.min(...this.pending.map((p) => p.notBefore));
    const wait = due >= this.o.maxBatchSize ? 0 : Math.max(next - now, 0) + (due ? this.o.batchTimeoutMs : 0);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch((e: unknown) => {
        log('server', 'error', 'queue_delivery_failed', { queue: this.name, ...errorFields(e) });
      });
    }, wait);
  }

  private take(force: boolean): Pending<T>[] {
    const now = this.o.now();
    const batch: Pending<T>[] = [];
    this.pending = this.pending.filter((p) => {
      if (batch.length >= this.o.maxBatchSize || (!force && p.notBefore > now)) return true;
      batch.push(p);
      return false;
    });
    return batch;
  }

  private commitDelivery(batch: Pending<T>[]): void {
    const ids = new Set(batch.map((p) => p.id));
    this.o.store?.commit(this.name, [...ids], this.pending.filter((p) => ids.has(p.id)));
  }

  private async deliver(batch: Pending<T>[]): Promise<void> {
    const outcome = new Map<string, number | 'ack'>();
    const messages = batch.map((p) => ({
      id: p.id,
      timestamp: p.timestamp,
      body: p.body,
      attempts: p.attempts,
      ack: () => void outcome.set(p.id, 'ack'),
      retry: (o?: { delaySeconds?: number }) => void outcome.set(p.id, o?.delaySeconds ?? 0),
    }));
    const batchApi = {
      queue: this.name,
      messages,
      ackAll: () => messages.forEach((m) => m.ack()),
      retryAll: (o?: { delaySeconds?: number }) => messages.forEach((m) => m.retry(o)),
    } as unknown as MessageBatch<T>;
    try {
      await this.handler(batchApi);
    } catch (e) {
      log('server', 'error', 'queue_handler_failed', { queue: this.name, messages: batch.length, ...errorFields(e) });
      for (const p of batch) if (outcome.get(p.id) !== 'ack') outcome.set(p.id, 0);
    }
    const now = this.o.now();
    const dead: Pending<T>[] = [];
    for (const p of batch) {
      const r = outcome.get(p.id);
      if (r === undefined || r === 'ack') continue;
      if (p.attempts > this.o.maxRetries) dead.push(p);
      else this.pending.push({ ...p, attempts: p.attempts + 1, notBefore: now + r * 1000 });
    }
    if (!dead.length) {
      this.commitDelivery(batch);
      return;
    }
    if (this.o.deadLetter) {
      try {
        await this.o.deadLetter.sendBatch(dead);
      } catch (e) {
        // Transfer is atomic: keep ownership until the destination accepts the batch.
        this.pending.push(...dead.map((p) => ({ ...p, notBefore: now + 1000 })));
        throw e;
      }
    }
    else {
      // The terminal queue is the last durable owner: storage outages must not discard dead letters.
      this.pending.push(...dead.map((p) => ({ ...p, notBefore: now + 60_000 })));
      log('server', 'error', 'queue_messages_retained', { queue: this.name, messages: dead.length });
    }
    this.commitDelivery(batch);
  }
}
