import { percentile } from './format';
import type {
  ExceptionDetail,
  ExceptionGroup,
  Overview,
  Paginated,
  QueryDetail,
  QueryGroup,
  Range,
  Span,
  TraceDetail,
  TraceFilters,
  TraceSummary,
} from './types';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261122);
const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
const between = (min: number, max: number) => min + rand() * (max - min);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');

function uuid7(ms: number): string {
  const t = ms.toString(16).padStart(12, '0');
  return `${t.slice(0, 8)}-${t.slice(8)}-7${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
}

interface QueryTemplate { sql_hash: string; sql: string; connection: string; base: number; file: string; line: number }

const QUERIES: QueryTemplate[] = [
  { sql: 'select * from `users` where `id` = ? limit ?', base: 0.8, file: 'app/Http/Middleware/Authenticate.php', line: 24 },
  { sql: 'select * from `orders` where `user_id` = ? order by `created_at` desc limit ?', base: 4.2, file: 'app/Http/Controllers/OrderController.php', line: 31 },
  { sql: 'select * from `order_items` where `order_items`.`order_id` in (?)', base: 2.6, file: 'app/Http/Controllers/OrderController.php', line: 33 },
  { sql: 'select * from `products` where `slug` = ? and `deleted_at` is null limit ?', base: 1.4, file: 'app/Http/Controllers/ProductController.php', line: 18 },
  { sql: 'select count(*) as aggregate from `products` where `category_id` = ?', base: 9.5, file: 'app/Http/Controllers/CategoryController.php', line: 42 },
  { sql: 'insert into `orders` (`user_id`, `total`, `status`, `created_at`, `updated_at`) values (?, ?, ?, ?, ?)', base: 3.1, file: 'app/Actions/PlaceOrder.php', line: 57 },
  { sql: 'update `inventory` set `quantity` = `quantity` - ? where `product_id` = ?', base: 5.8, file: 'app/Actions/PlaceOrder.php', line: 64 },
  { sql: 'select * from `sessions` where `id` = ? limit ?', base: 0.6, file: 'vendor/laravel/framework/src/Illuminate/Session/DatabaseSessionHandler.php', line: 96 },
  { sql: 'select `products`.*, sum(`order_items`.`quantity`) as sold from `products` inner join `order_items` on `order_items`.`product_id` = `products`.`id` group by `products`.`id` order by sold desc limit ?', base: 85, file: 'app/Console/Commands/RefreshBestsellers.php', line: 29 },
  { sql: 'select * from `jobs` where `queue` = ? and ((`reserved_at` is null and `available_at` <= ?)) order by `id` asc limit ? for update', base: 1.9, file: 'vendor/laravel/framework/src/Illuminate/Queue/DatabaseQueue.php', line: 280 },
].map((q, i) => ({ ...q, connection: i === 9 ? 'queue' : 'mysql', sql_hash: hex(32) }));

interface RouteTemplate { method: string; route: string; name: string; base: number; queries: number[]; errorRate: number; exception?: number }

const ROUTES: RouteTemplate[] = [
  { method: 'GET', route: '/', name: 'home', base: 38, queries: [7, 0], errorRate: 0.002 },
  { method: 'GET', route: '/products/{slug}', name: 'products.show', base: 64, queries: [7, 0, 3], errorRate: 0.01, exception: 2 },
  { method: 'GET', route: '/categories/{category}', name: 'categories.show', base: 140, queries: [7, 0, 4, 4], errorRate: 0.004 },
  { method: 'GET', route: '/account/orders', name: 'orders.index', base: 95, queries: [7, 0, 1, 2], errorRate: 0.006 },
  { method: 'POST', route: '/checkout', name: 'checkout.store', base: 320, queries: [7, 0, 3, 5, 6, 6], errorRate: 0.045, exception: 0 },
  { method: 'POST', route: '/api/cart/items', name: 'api.cart.store', base: 52, queries: [0, 3], errorRate: 0.02, exception: 1 },
  { method: 'GET', route: '/api/search', name: 'api.search', base: 210, queries: [4], errorRate: 0.012, exception: 3 },
];

const EXCEPTIONS = [
  { class: 'App\\Exceptions\\PaymentDeclinedException', message: 'Card was declined by the issuer (code: do_not_honor)', file: 'app/Services/Payments/StripeGateway.php', line: 88, handled: false },
  { class: 'Illuminate\\Validation\\ValidationException', message: 'The quantity field must be at least 1.', file: 'vendor/laravel/framework/src/Illuminate/Foundation/Http/FormRequest.php', line: 130, handled: true },
  { class: 'Illuminate\\Database\\Eloquent\\ModelNotFoundException', message: 'No query results for model [App\\Models\\Product].', file: 'vendor/laravel/framework/src/Illuminate/Database/Eloquent/Builder.php', line: 637, handled: true },
  { class: 'Illuminate\\Http\\Client\\ConnectionException', message: 'cURL error 28: Operation timed out after 3001 milliseconds (search.internal)', file: 'app/Services/SearchClient.php', line: 41, handled: false },
  { class: 'RuntimeException', message: 'Bestseller cache refresh exceeded memory limit', file: 'app/Console/Commands/RefreshBestsellers.php', line: 52, handled: false },
].map((e) => ({ ...e, group: hex(32) }));

const USERS = ['1042', '2231', '88', '5120', '731', null, null, null];
const SERVERS = ['web-1', 'web-2', 'worker-1'];

interface Generated {
  summary: TraceSummary;
  spans: Span[];
  queries: { template: QueryTemplate; duration: number }[];
  exception: (typeof EXCEPTIONS)[number] | null;
}

const NOW = Date.now();
const TRACES: Generated[] = [];

for (let i = 0; i < 1400; i++) {
  const start = NOW - Math.floor(between(0, 24 * 3600 * 1000) * Math.sqrt(rand()));
  const kind = rand();
  let summary: TraceSummary;
  let queryIndexes: number[];
  let exception: Generated['exception'] = null;
  let duration: number;

  if (kind < 0.86) {
    const route = pick(ROUTES);
    duration = route.base * between(0.6, 1.4) * (rand() < 0.05 ? between(3, 8) : 1);
    const failed = rand() < route.errorRate;
    if (failed && route.exception !== undefined) exception = EXCEPTIONS[route.exception];
    const status = failed ? (exception?.handled ? (route.exception === 2 ? 404 : 422) : 500) : route.method === 'POST' ? 201 : rand() < 0.03 ? 302 : 200;
    const id = route.route.includes('{') ? String(Math.floor(between(1, 900))) : '';
    summary = {
      trace_id: uuid7(start), timestamp: new Date(start).toISOString(), execution_source: 'request',
      name: `${route.method} ${route.route}`, method: route.method, url: `https://shop.example.com${route.route.replace(/\{\w+\}/, id || 'x')}`,
      route: route.name, status_code: status, duration_ms: duration, query_count: 0, exception_count: exception ? 1 : 0,
      server: pick(SERVERS.slice(0, 2)), user: pick(USERS),
    };
    queryIndexes = route.queries;
  } else if (kind < 0.97) {
    duration = between(20, 400);
    summary = {
      trace_id: uuid7(start), timestamp: new Date(start).toISOString(), execution_source: 'job', name: pick(['App\\Jobs\\SendOrderConfirmation', 'App\\Jobs\\SyncInventory', 'App\\Jobs\\GenerateInvoicePdf']),
      method: null, url: null, route: null, status_code: null, duration_ms: duration, query_count: 0, exception_count: 0, server: 'worker-1', user: null,
    };
    queryIndexes = [9, 0, 6];
  } else {
    duration = between(800, 4200);
    exception = rand() < 0.15 ? EXCEPTIONS[4] : null;
    summary = {
      trace_id: uuid7(start), timestamp: new Date(start).toISOString(), execution_source: 'command', name: 'php artisan shop:refresh-bestsellers',
      method: null, url: null, route: null, status_code: exception ? 1 : 0, duration_ms: duration, query_count: 0, exception_count: exception ? 1 : 0, server: 'worker-1', user: null,
    };
    queryIndexes = [8, 8, 4];
  }

  const queries = queryIndexes.map((index) => {
    const template = QUERIES[index];
    return { template, duration: template.base * between(0.5, 1.8) * (rand() < 0.03 ? between(4, 12) : 1) };
  });
  const spans: Span[] = [];
  const total = Math.max(duration, queries.reduce((s, q) => s + q.duration, 0) + 6);
  summary.duration_ms = total;
  summary.query_count = queries.length;

  const root = summary.execution_source === 'request' ? 'request' : summary.execution_source === 'job' ? 'job' : 'controller';
  spans.push({ id: 's0', type: root, label: summary.name, start_ms: 0, duration_ms: total });
  let cursor = 0;
  if (summary.execution_source === 'request') {
    const mw = Math.min(total * 0.08, 4 + rand() * 4);
    spans.push({ id: 's1', type: 'middleware', label: 'Middleware: web, auth', start_ms: 0.4, duration_ms: mw });
    cursor = mw + 0.6;
    spans.push({ id: 's2', type: 'controller', label: `Controller: ${summary.route}`, start_ms: cursor, duration_ms: total - cursor - 1.5 });
  }
  queries.forEach((q, n) => {
    const gap = (total - cursor - queries.reduce((s, x) => s + x.duration, 0)) / (queries.length + 2);
    cursor += Math.max(0.2, gap * between(0.4, 1));
    spans.push({ id: `q${n}`, type: 'query', label: q.template.sql, start_ms: cursor, duration_ms: q.duration, meta: { connection: q.template.connection, file: `${q.template.file}:${q.template.line}`, sql_hash: q.template.sql_hash } });
    cursor += q.duration;
  });
  if (summary.name === 'POST /checkout') {
    spans.push({ id: 'o0', type: 'outgoing-request', label: 'POST https://api.stripe.com/v1/payment_intents', start_ms: cursor * 0.6, duration_ms: total * 0.35, meta: { status: exception ? 402 : 200 } });
    if (!exception) spans.push({ id: 'm0', type: 'mail', label: 'App\\Mail\\OrderConfirmation', start_ms: total * 0.9, duration_ms: total * 0.04 });
  }
  if (summary.execution_source === 'request' && rand() < 0.5) {
    spans.push({ id: 'c0', type: 'cache', label: `cache hit: product:${Math.floor(between(1, 900))}`, start_ms: (spans[2]?.start_ms ?? 0) + 0.3, duration_ms: 0.3 });
  }
  if (exception) {
    spans.push({ id: 'e0', type: 'exception', label: `${exception.class}: ${exception.message}`, start_ms: total * 0.92, duration_ms: 0 });
  }
  spans.sort((a, b) => a.start_ms - b.start_ms);

  TRACES.push({ summary, spans, queries, exception });
}
TRACES.sort((a, b) => b.summary.timestamp.localeCompare(a.summary.timestamp));

const RANGE_MS: Record<Range, number> = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };
const inRange = (range: Range) => TRACES.filter((t) => NOW - new Date(t.summary.timestamp).getTime() <= RANGE_MS[range]);

function trend(items: Generated[], range: Range, value: (t: Generated) => number, buckets = 24): number[] {
  const width = RANGE_MS[range] / buckets;
  const out = Array<number>(buckets).fill(0);
  for (const t of items) {
    const idx = Math.min(buckets - 1, Math.floor((RANGE_MS[range] - (NOW - new Date(t.summary.timestamp).getTime())) / width));
    if (idx >= 0) out[idx] += value(t);
  }
  return out;
}

const isError = (t: TraceSummary) => (t.execution_source === 'request' ? (t.status_code ?? 0) >= 500 : t.exception_count > 0);

export function overview(range: Range): Overview {
  const items = inRange(range);
  const requests = items.filter((t) => t.summary.execution_source === 'request');
  const buckets = 24;
  const width = RANGE_MS[range] / buckets;
  const series = Array.from({ length: buckets }, (_, i) => {
    const from = NOW - RANGE_MS[range] + i * width;
    const slice = requests.filter((t) => {
      const ts = new Date(t.summary.timestamp).getTime();
      return ts >= from && ts < from + width;
    });
    return {
      ts: new Date(from).toISOString(),
      requests: slice.length,
      errors: slice.filter((t) => isError(t.summary)).length,
      p95_ms: percentile(slice.map((t) => t.summary.duration_ms), 95),
    };
  });
  const byRoute = new Map<string, Generated[]>();
  requests.forEach((t) => byRoute.set(t.summary.name, [...(byRoute.get(t.summary.name) ?? []), t]));

  return {
    range,
    requests: requests.length,
    error_rate: requests.length ? requests.filter((t) => isError(t.summary)).length / requests.length : 0,
    p95_ms: percentile(requests.map((t) => t.summary.duration_ms), 95),
    exceptions: items.filter((t) => t.exception).length,
    slow_queries: items.flatMap((t) => t.queries).filter((q) => q.duration > 100).length,
    series,
    top_routes: [...byRoute.entries()]
      .map(([route, list]) => ({
        route,
        requests: list.length,
        p95_ms: percentile(list.map((t) => t.summary.duration_ms), 95),
        error_rate: list.filter((t) => isError(t.summary)).length / list.length,
      }))
      .sort((a, b) => b.requests - a.requests),
  };
}

export function traces(filters: TraceFilters = {}, cursor: string | null = null, limit = 50): Paginated<TraceSummary> {
  const q = filters.q?.toLowerCase().trim();
  const since = filters.range ? NOW - RANGE_MS[filters.range] : -Infinity;
  const list = TRACES.map((t) => t.summary).filter((t) => {
    if (Date.parse(t.timestamp) < since) return false;
    if (filters.source && filters.source !== 'all' && t.execution_source !== filters.source) return false;
    if (filters.status && filters.status !== 'all') {
      if (t.status_code === null || t.execution_source !== 'request') return false;
      if (Math.floor(t.status_code / 100) !== Number(filters.status[0])) return false;
    }
    if (q && !`${t.name} ${t.trace_id} ${t.user ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const offset = cursor ? Number(cursor) : 0;
  return { data: list.slice(offset, offset + limit), next_cursor: offset + limit < list.length ? String(offset + limit) : null };
}

export function trace(traceId: string): TraceDetail | null {
  const found = TRACES.find((t) => t.summary.trace_id === traceId);
  if (!found) return null;
  const { summary } = found;
  const base = { timestamp: Date.parse(summary.timestamp) / 1000, deploy: 'v2026.11.21-3', server: summary.server, trace_id: summary.trace_id, execution_source: summary.execution_source, execution_id: summary.trace_id, user: summary.user ?? '' };
  const records: Record<string, unknown>[] = [
    ...found.queries.map((q) => ({ v: 1, t: 'query', ...base, _group: q.template.sql_hash, sql: q.template.sql, file: q.template.file, line: q.template.line, duration: Math.round(q.duration * 1000), connection: q.template.connection })),
    ...(found.exception ? [{ v: 3, t: 'exception', ...base, _group: found.exception.group, class: found.exception.class, message: found.exception.message, file: found.exception.file, line: found.exception.line, handled: found.exception.handled }] : []),
  ];
  if (summary.execution_source === 'request') {
    records.unshift({ v: 1, t: 'request', ...base, _group: hex(32), method: summary.method, url: summary.url, route_name: summary.route, route_path: summary.name.split(' ')[1], status_code: summary.status_code, duration: Math.round(summary.duration_ms * 1000), queries: summary.query_count, exceptions: summary.exception_count });
  }
  return { trace: summary, spans: found.spans, records };
}

export function exceptions(range: Range = '24h'): ExceptionGroup[] {
  const items = inRange(range).filter((t) => t.exception);
  return EXCEPTIONS.map((e) => {
    const hits = items.filter((t) => t.exception?.group === e.group);
    if (hits.length === 0) return null;
    return {
      ...e,
      count: hits.length,
      users: new Set(hits.map((t) => t.summary.user).filter(Boolean)).size,
      first_seen: hits[hits.length - 1].summary.timestamp,
      last_seen: hits[0].summary.timestamp,
      last_trace_id: hits[0].summary.trace_id,
      trend: trend(hits, range, () => 1),
    };
  })
    .filter((e): e is ExceptionGroup => e !== null)
    .sort((a, b) => b.count - a.count);
}

export function exception(group: string): ExceptionDetail | null {
  const summary = exceptions('24h').find((e) => e.group === group);
  if (!summary) return null;
  const hits = TRACES.filter((t) => t.exception?.group === group);
  return {
    ...summary,
    stack: [
      { file: `${summary.file}:${summary.line}`, source: summary.class.includes('Payment') ? 'App\\Services\\Payments\\StripeGateway->charge()' : 'throw' },
      { file: 'app/Actions/PlaceOrder.php:71', source: 'App\\Actions\\PlaceOrder->handle()' },
      { file: 'app/Http/Controllers/CheckoutController.php:29', source: 'App\\Http\\Controllers\\CheckoutController->store()' },
      { file: 'vendor/laravel/framework/src/Illuminate/Routing/Controller.php:54', source: 'Illuminate\\Routing\\Controller->callAction()' },
      { file: 'vendor/laravel/framework/src/Illuminate/Pipeline/Pipeline.php:208', source: 'Illuminate\\Pipeline\\Pipeline->{closure}()' },
      { file: 'public/index.php:17', source: 'Illuminate\\Foundation\\Application->handleRequest()' },
    ],
    occurrences: hits.slice(0, 25).map((t) => ({ trace_id: t.summary.trace_id, timestamp: t.summary.timestamp, name: t.summary.name, user: t.summary.user })),
  };
}

export function queries(range: Range = '24h'): QueryGroup[] {
  const items = inRange(range);
  return QUERIES.map((template) => {
    const hits = items.flatMap((t) => t.queries.filter((q) => q.template === template).map((q) => ({ t, q })));
    if (hits.length === 0) return null;
    const durations = hits.map((h) => h.q.duration);
    const total = durations.reduce((a, b) => a + b, 0);
    return {
      sql_hash: template.sql_hash,
      sql: template.sql,
      connection: template.connection,
      calls: hits.length,
      total_ms: total,
      avg_ms: total / hits.length,
      p95_ms: percentile(durations, 95),
      max_ms: Math.max(...durations),
      last_seen: hits[0].t.summary.timestamp,
      trend: trend(hits.map((h) => h.t), range, (t) => t.queries.filter((q) => q.template === template).length),
    };
  })
    .filter((q): q is QueryGroup => q !== null)
    .sort((a, b) => b.total_ms - a.total_ms);
}

export function query(sqlHash: string): QueryDetail | null {
  const summary = queries('24h').find((q) => q.sql_hash === sqlHash);
  if (!summary) return null;
  const samples = TRACES.flatMap((t) => t.queries.filter((q) => q.template.sql_hash === sqlHash).map((q) => ({ trace_id: t.summary.trace_id, timestamp: t.summary.timestamp, duration_ms: q.duration, name: t.summary.name, file: q.template.file, line: q.template.line })))
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 20);
  return { ...summary, samples };
}
