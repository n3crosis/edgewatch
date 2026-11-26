import { describe, expect, it } from 'vitest';
import { BrowserBody, BrowserEvent, browserEventToRecord, INGEST_TOKEN_PREFIX, normalizeSql, scrubPii, signIngestToken, validateRecords, verifyIngestToken } from './index';

/** Deterministic PRNG (mulberry32) so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  const str = (max = 40) => Array.from({ length: int(max) }, () => String.fromCharCode(pick([int(128), int(0xd800), 0xd800 + int(0x800), 0x1f600 & 0xffff]))).join('');
  const value = (depth = 0): unknown => {
    switch (int(depth > 3 ? 6 : 9)) {
      case 0: return null;
      case 1: return next() < 0.5;
      case 2: return pick([0, -1, 1.5, Number.MAX_SAFE_INTEGER, 1e308, -0]);
      case 3: return str();
      case 4: return pick(['', 'request', 'query', 'exception', 'job-attempt', 'web-vital', '__proto__', 'constructor']);
      case 5: return int(1e10) / 1000;
      case 6: return Array.from({ length: int(5) }, () => value(depth + 1));
      default: return Object.fromEntries(Array.from({ length: int(6) }, () => [pick(['v', 't', 'trace_id', 'timestamp', 'sql', 'class', 'message', '__proto__', 'constructor', str(8)]), value(depth + 1)]));
    }
  };
  return { next, int, pick, str, value };
}

const RECORD_TYPES = ['request', 'query', 'exception', 'job-attempt', 'queued-job', 'command', 'cache-event', 'outgoing-request', 'mail', 'notification', 'scheduled-task', 'log', 'user', 'web-vital', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty'];

describe('fuzz: validateRecords', () => {
  it('never throws and partitions every input into accepted (int v, string t) or rejected', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const input = Array.from({ length: 1 + r.int(20) }, () => {
        const base = r.value();
        // Bias towards near-valid records so the per-type schemas, not just the envelope check, are exercised.
        return r.next() < 0.6 && base && typeof base === 'object' && !Array.isArray(base) ? { ...base, v: r.pick([1, 1, 2, '1', 1.5]), t: r.pick(RECORD_TYPES) } : base;
      });
      const { records, rejected } = validateRecords(input);
      expect(records.length + rejected.length, `seed ${seed}`).toBe(input.length);
      for (const rec of records) {
        expect(Number.isInteger(rec.v), `seed ${seed}`).toBe(true);
        expect(typeof rec.t).toBe('string');
      }
      expect(Object.prototype).not.toHaveProperty('polluted');
    }
  });
});

describe('fuzz: browser events', () => {
  it('parses or rejects any event without throwing, and accepted events always convert to a bounded record', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const raw = { ...(r.value() as object), type: r.pick(['error', 'vitals', 'manual', 'x', undefined]), timestamp: r.pick([1_700_000_000, 'x', undefined]), message: r.pick(['boom', r.str(3000), undefined]), url: r.pick(['https://a.test/p?q=1', 'not a url', '', undefined]), breadcrumbs: r.pick([undefined, [], [{ timestamp: 1, category: 'c', message: r.str(600) }], Array(31).fill({ timestamp: 1, category: 'c', message: 'm' })]), vitals: r.pick([undefined, { lcp: 1 }, { lcp: -1 }, { cls: 'x' }]) };
      const parsed = BrowserEvent.safeParse(raw);
      if (!parsed.success) continue;
      const rec = await browserEventToRecord(parsed.data);
      expect(JSON.stringify(rec).length, `seed ${seed}`).toBeLessThan(64_000);
      expect(['exception', 'web-vital']).toContain(rec.t);
    }
    expect(BrowserBody.safeParse({ events: Array(51).fill({}) }).success).toBe(false);
  });
});

describe('fuzz: SQL normalization and PII scrubbing', () => {
  it('never throws, never grows unboundedly, and is idempotent on its own output', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const sql = [r.pick(['select', 'insert into', "update t set a = 'x'", 'delete from']), r.str(80), r.pick(["'unterminated", '"q"', '-- c', '/* c */', 'in (1, 2, 3)', '$1', ':name', '0x1f'])].join(' ');
      const once = normalizeSql(sql);
      expect(once.length, `seed ${seed}`).toBeLessThanOrEqual(sql.length + 16);
      expect(normalizeSql(once), `seed ${seed}`).toBe(once);
      const text = `${r.str(60)} jane.doe+${r.int(99)}@example.com ${r.str(20)}`;
      expect(scrubPii(text), `seed ${seed}`).not.toMatch(/jane\.doe\+\d+@example\.com/);
    }
  });
});

describe('fuzz: ingest tokens', () => {
  const secret = 'fuzz-secret';
  it('rejects every mutation of a valid token and never throws', async () => {
    const token = await signIngestToken({ p: 'proj', exp: Date.now() / 1000 + 3600 }, secret);
    expect(await verifyIngestToken(token, secret)).toMatchObject({ p: 'proj' });
    const body = token.slice(INGEST_TOKEN_PREFIX.length);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ %';
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      let mutated: string;
      switch (r.int(6)) {
        case 0: { const i = r.int(body.length); mutated = INGEST_TOKEN_PREFIX + body.slice(0, i) + r.pick([...alphabet].filter((c) => c !== body[i])) + body.slice(i + 1); break; }
        case 1: mutated = INGEST_TOKEN_PREFIX + body.slice(0, r.int(body.length)); break;
        case 2: mutated = `${INGEST_TOKEN_PREFIX}${body}.${r.str(10)}x`; break;
        case 3: mutated = r.str(200); break;
        case 4: { const [b] = body.split('.'); mutated = `${INGEST_TOKEN_PREFIX}${b}.${Array.from({ length: 43 }, () => r.pick([...alphabet.slice(0, 64)])).join('')}`; break; }
        default: mutated = `${INGEST_TOKEN_PREFIX}${Buffer.from(JSON.stringify({ p: 'other', exp: 9e9 })).toString('base64url')}.${body.split('.')[1]}`;
      }
      if (mutated === token) continue;
      expect(await verifyIngestToken(mutated, secret), `seed ${seed}: ${mutated}`).toBeNull();
    }
  });

  it('rejects expired tokens, wrong secrets and claims of the wrong shape', async () => {
    const valid = await signIngestToken({ p: 'proj', exp: 9e9 }, secret);
    expect(await verifyIngestToken(`${valid}.extra`, secret)).toBeNull();
    // The last of 43 base64url characters carries 2 unused bits; flipping them must not give a second valid spelling.
    const sig = valid.slice(valid.lastIndexOf('.') + 1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.at(-1) ?? '');
    for (const bits of [1, 2, 3]) expect(await verifyIngestToken(valid.slice(0, -1) + alphabet[last ^ bits], secret)).toBeNull();
    expect(await verifyIngestToken(await signIngestToken({ p: 'proj', exp: 1 }, secret), secret)).toBeNull();
    expect(await verifyIngestToken(await signIngestToken({ p: 'proj', exp: 9e9 }, 'other'), secret)).toBeNull();
    expect(await verifyIngestToken(await signIngestToken({ p: 7, exp: 9e9 } as never, secret), secret)).toBeNull();
    expect(await verifyIngestToken(await signIngestToken({ p: 'proj', exp: '9e9' } as never, secret), secret)).toBeNull();
  });
});
