import { activeEnvironment } from './environment-scope';
import { timeWindow } from '@edgewatch/shared/time-window';
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
  EventList,
  EventRow,
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

export interface MockProject { id: string; name: string; host: string; kind: 'shop' | 'api'; seed: number; volume: number; servers: string[] }

/** Two demo Laravel apps so the project switcher has something to switch between in seed-data mode. */
export const MOCK_PROJECTS: MockProject[] = [
  { id: 'demo', name: 'Shop', host: 'shop.example.com', kind: 'shop', seed: 20261122, volume: 1400, servers: ['web-1', 'web-2', 'worker-1'] },
  { id: 'billing-api', name: 'Billing API', host: 'billing.example.com', kind: 'api', seed: 7_331, volume: 650, servers: ['api-1', 'api-2', 'queue-1'] },
];

function createDataset(profile: MockProject) {
  const rand = mulberry32(profile.seed);
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

  const SHOP_ROUTES: RouteTemplate[] = [
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
  const API_ROUTES: RouteTemplate[] = [
    { method: 'GET', route: '/v1/invoices', name: 'invoices.index', base: 48, queries: [7, 0, 1], errorRate: 0.004 },
    { method: 'GET', route: '/v1/invoices/{invoice}', name: 'invoices.show', base: 30, queries: [7, 0, 2], errorRate: 0.01, exception: 2 },
    { method: 'POST', route: '/v1/invoices', name: 'invoices.store', base: 180, queries: [7, 0, 5, 6], errorRate: 0.03, exception: 1 },
    { method: 'POST', route: '/v1/webhooks/stripe', name: 'webhooks.stripe', base: 95, queries: [0, 6], errorRate: 0.02, exception: 3 },
  ];
  const ROUTES = profile.kind === 'api' ? API_ROUTES : SHOP_ROUTES;
  const SERVERS = profile.servers;

  interface Generated {
    summary: TraceSummary;
    spans: Span[];
    queries: { template: QueryTemplate; duration: number }[];
    exception: (typeof EXCEPTIONS)[number] | null;
  }

  const NOW = Date.now();
  const TRACES: Generated[] = [];

  for (let i = 0; i < profile.volume; i++) {
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
        name: `${route.method} ${route.route}`, method: route.method, url: `https://${profile.host}${route.route.replace(/\{\w+\}/, id || 'x')}`,
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
    summary.environment = i % 5 === 0 ? 'staging' : 'production';
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

  const inRange = (range: Range) => {
    const { since, now } = timeWindow(range, NOW)!;
    return TRACES.filter((t) => { const ts = Date.parse(t.summary.timestamp); return ts >= since && ts <= now && (activeEnvironment() === undefined || t.summary.environment === activeEnvironment()); });
  };

  function trend(items: Generated[], range: Range, value: (t: Generated) => number, buckets = 24): number[] {
    const { since, width } = timeWindow(range, NOW)!;
    const out = Array<number>(buckets).fill(0);
    for (const t of items) {
      const idx = Math.min(buckets - 1, Math.floor((Date.parse(t.summary.timestamp) - since) / width));
      if (idx >= 0) out[idx] += value(t);
    }
    return out;
  }

  const isError = (t: TraceSummary) => (t.execution_source === 'request' ? (t.status_code ?? 0) >= 500 : t.exception_count > 0);

  function overview(range: Range): Overview {
    const items = inRange(range);
    const requests = items.filter((t) => t.summary.execution_source === 'request');
    const buckets = 24;
    const { since, width } = timeWindow(range, NOW)!;
    const series = Array.from({ length: buckets }, (_, i) => {
      const from = since + i * width;
      const slice = requests.filter((t) => {
        const ts = new Date(t.summary.timestamp).getTime();
        return ts >= from && (ts < from + width || (i === buckets - 1 && ts === from + width));
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

  function traces(filters: TraceFilters = {}, cursor: string | null = null, limit = 50): Paginated<TraceSummary> {
    const q = filters.q?.toLowerCase().trim();
    const environment = filters.environment ?? activeEnvironment();
    const { since, now } = filters.range ? timeWindow(filters.range, NOW)! : { since: -Infinity, now: Infinity };
    const list = TRACES.map((t) => t.summary).filter((t) => {
      if (Date.parse(t.timestamp) < since || Date.parse(t.timestamp) > now) return false;
      if (filters.min_duration_ms && t.duration_ms < Number(filters.min_duration_ms)) return false;
      const routeKind = t.route ? 'name' : t.route_path ? 'path' : 'unknown';
      const route = filters.route_kind ? t.route || t.route_path || '[unnamed]' : t.route ?? '[unnamed]';
      if (filters.route !== undefined && route !== filters.route) return false;
      if (filters.route_kind && routeKind !== filters.route_kind) return false;
      if (filters.user !== undefined && t.user !== filters.user) return false;
      if (environment !== undefined && t.environment !== environment) return false;
      if (filters.server !== undefined && t.server !== filters.server) return false;
      if (filters.method && (t.method ?? 'UNKNOWN') !== filters.method) return false;
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

  // Like laravel/nightwatch: each queued job attempt is linked to the request that dispatched it (the closest earlier request).
  const origins = new Map<string, TraceSummary>();
  TRACES.forEach((t, i) => {
    if (t.summary.execution_source !== 'job') return;
    const origin = TRACES.slice(i + 1).find((o) => o.summary.execution_source === 'request');
    if (origin) origins.set(t.summary.trace_id, origin.summary);
  });
  const related = (s: TraceSummary) => ({
    trace_id: s.trace_id, timestamp: s.timestamp, execution_source: s.execution_source, name: s.name,
    status: s.execution_source === 'job' ? 'processed' : null, duration_ms: s.duration_ms, origin_trace_id: origins.get(s.trace_id)?.trace_id ?? null,
  });

  function trace(traceId: string): TraceDetail | null {
    const found = TRACES.find((t) => t.summary.trace_id === traceId);
    if (!found || (activeEnvironment() !== undefined && found.summary.environment !== activeEnvironment())) return null;
    const { summary } = found;
    const base = { timestamp: Date.parse(summary.timestamp) / 1000, deploy: 'v2026.11.21-3', server: summary.server, environment: summary.environment, trace_id: summary.trace_id, execution_source: summary.execution_source, execution_id: summary.trace_id, user: summary.user ?? '' };
    const records: Record<string, unknown>[] = [
      ...found.queries.map((q) => ({ v: 1, t: 'query', ...base, _group: q.template.sql_hash, sql: q.template.sql, file: q.template.file, line: q.template.line, duration: Math.round(q.duration * 1000), connection: q.template.connection })),
      ...(found.exception ? [{ v: 3, t: 'exception', ...base, _group: found.exception.group, class: found.exception.class, message: found.exception.message, file: found.exception.file, line: found.exception.line, handled: found.exception.handled }] : []),
    ];
    if (summary.execution_source === 'request') {
      records.unshift({ v: 1, t: 'request', ...base, _group: hex(32), method: summary.method, url: summary.url, route_name: summary.route, route_path: summary.name.split(' ')[1], status_code: summary.status_code, duration: Math.round(summary.duration_ms * 1000), queries: summary.query_count, exceptions: summary.exception_count });
    }
    const counts = new Map<string, { sql_hash: string; sql: string; count: number; total_ms: number }>();
    for (const q of found.queries) {
      const g = counts.get(q.template.sql_hash) ?? { sql_hash: q.template.sql_hash, sql: q.template.sql, count: 0, total_ms: 0 };
      g.count++;
      g.total_ms += q.duration;
      counts.set(q.template.sql_hash, g);
    }
    const memory = Math.round((18 + (summary.duration_ms % 40)) * 1024 * 1024);
    return {
      trace: { ...summary, origin_trace_id: origins.get(summary.trace_id)?.trace_id ?? null, peak_memory_usage: memory, route_action: summary.execution_source === 'request' ? `App\\Http\\Controllers\\${(summary.route ?? 'home').split('.')[0].replace(/^./, (c) => c.toUpperCase())}Controller@handle` : null },
      spans: found.spans,
      capture: { records_available: true, dropped_records: 0 },
      records,
      repeated_queries: [...counts.values()].filter((g) => g.count >= 5),
      user: summary.user ? { id: summary.user, name: `User ${summary.user}`, username: null } : null,
      related: origins.has(summary.trace_id)
        ? (activeEnvironment() === undefined || origins.get(summary.trace_id)?.environment === activeEnvironment() ? [related(origins.get(summary.trace_id) as TraceSummary)] : [])
        : TRACES.filter((t) => origins.get(t.summary.trace_id)?.trace_id === summary.trace_id && (activeEnvironment() === undefined || t.summary.environment === activeEnvironment())).map((t) => related(t.summary)),
    };
  }

  function exceptions(range: Range = '24h', user?: string): ExceptionGroup[] {
    const items = inRange(range).filter((t) => t.exception && (user === undefined || t.summary.user === user));
    return EXCEPTIONS.map((e): ExceptionGroup | null => {
      const hits = items.filter((t) => t.exception?.group === e.group);
      if (hits.length === 0) return null;
      return {
        ...e,
        count: hits.length,
        handled_count: e.handled ? hits.length : 0,
        unhandled_count: e.handled ? 0 : hits.length,
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

  function exception(group: string, range: Range = '24h', user?: string): ExceptionDetail | null {
    const summary = exceptions(range, user).find((e) => e.group === group);
    if (!summary) return null;
    const hits = inRange(range).filter((t) => t.exception?.group === group && (user === undefined || t.summary.user === user));
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

  function queries(range: Range = '24h'): QueryGroup[] {
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

  function query(sqlHash: string, range: Range = '24h'): QueryDetail | null {
    const summary = queries(range).find((q) => q.sql_hash === sqlHash);
    if (!summary) return null;
    const samples = inRange(range).flatMap((t) => t.queries.filter((q) => q.template.sql_hash === sqlHash).map((q) => ({ trace_id: t.summary.trace_id, timestamp: t.summary.timestamp, duration_ms: q.duration, name: t.summary.name, file: q.template.file, line: q.template.line })))
      .sort((a, b) => b.duration_ms - a.duration_ms)
      .slice(0, 20);
    return { ...summary, samples };
  }
  // Event tables (jobs, commands, ...) derived from the generated traces so the numbers agree with the Traces page.
  type MockEvent = EventRow & { key: string };
  type Cells = Record<string, string | number | null>;
  interface MockSpec {
    build: () => MockEvent[];
    group: (list: MockEvent[]) => Cells;
    summary?: (list: MockEvent[]) => Record<string, number>;
    filters?: Record<string, (e: MockEvent) => unknown>;
    search: string[];
  }
  const count = (list: MockEvent[], f: (e: MockEvent) => boolean) => list.filter(f).length;
  const durations = (list: MockEvent[]) => list.map((e) => Number(e.duration_ms ?? 0));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  const fromTraces = (source: string, rows: (t: TraceSummary) => (Cells & { key: string })[]): MockEvent[] =>
    TRACES.filter((t) => t.summary.execution_source === source).flatMap(({ summary: t }) =>
      rows(t).map((r) => ({ trace_id: t.trace_id, trace_name: t.name, timestamp: t.timestamp, server: t.server, environment: t.environment, user: t.user, ...r })),
    );
  const JOB_QUEUES: Record<string, string> = {};
  const MOCK_SPECS: Record<string, MockSpec> = {
    '/jobs': {
      build: () =>
        fromTraces('job', (t) => {
          const queue = (JOB_QUEUES[t.name] ??= pick(['default', 'mail', 'images']));
          const common = { key: t.name, name: t.name, queue, connection: 'redis' };
          return [
            { ...common, kind: 'attempt', attempt: 1, status: t.exception_count ? 'failed' : 'processed', duration_ms: t.duration_ms },
            { ...common, kind: 'queued', attempt: null, status: null, duration_ms: 0.4 },
          ];
        }),
      group: (l) => {
        const attempts = l.filter((e) => e.kind === 'attempt');
        return { queue: l[0].queue ?? null, connection: 'redis', queued: count(l, (e) => e.kind === 'queued'), attempts: attempts.length, processed: count(l, (e) => e.status === 'processed'), released: count(l, (e) => e.status === 'released'), failed: count(l, (e) => e.status === 'failed'), avg_ms: avg(durations(attempts)), max_ms: max(durations(attempts)) };
      },
      summary: (l) => ({ queued: count(l, (e) => e.kind === 'queued'), attempts: count(l, (e) => e.kind === 'attempt'), failed: count(l, (e) => e.status === 'failed'), released: count(l, (e) => e.status === 'released') }),
      filters: { queue: (e) => e.queue, status: (e) => e.status },
      search: ['name', 'queue'],
    },
    '/commands': {
      build: () => fromTraces('command', (t) => [{ key: t.name.replace(/^php artisan /, ''), name: t.name.replace(/^php artisan /, ''), command: t.name, exit_code: t.status_code ?? 0, duration_ms: t.duration_ms }]),
      group: (l) => ({ failed: count(l, (e) => Number(e.exit_code) !== 0), avg_ms: avg(durations(l)), max_ms: max(durations(l)) }),
      summary: (l) => ({ runs: l.length, failed: count(l, (e) => Number(e.exit_code) !== 0), avg_ms: avg(durations(l)) ?? 0 }),
      filters: { status: (e) => (Number(e.exit_code) === 0 ? 'success' : 'failed') },
      search: ['name', 'command'],
    },
  };
  const CACHE_KEYS: Record<string, string> = { home: 'homepage:bestsellers', 'products.show': 'product:{slug}', 'categories.show': 'category-tree', 'orders.index': 'user:{id}:orders', 'checkout.store': 'cart:{id}' };
  const cacheCounts = (l: MockEvent[]) => {
    const hits = count(l, (e) => e.type === 'hit');
    const misses = count(l, (e) => e.type === 'miss');
    return { hits, misses, writes: count(l, (e) => e.type === 'write'), deletes: count(l, (e) => e.type === 'delete'), failures: count(l, (e) => String(e.type).endsWith('failure')), hit_ratio: hits + misses ? Math.round((hits / (hits + misses)) * 1e4) / 1e4 : null };
  };
  MOCK_SPECS['/cache'] = {
    // Deterministic per trace: the last hex digit of the trace id decides hit (0-b) or miss + write (c-f).
    build: () =>
      fromTraces('request', (t) => {
        const route = ROUTES.find((r) => t.name === `${r.method} ${r.route}`);
        const key = route ? CACHE_KEYS[route.name] : undefined;
        if (!key) return [];
        const hit = Number.parseInt(t.trace_id.slice(-1), 16) < 12;
        const common = { key, store: 'redis', duration_ms: 0.3 };
        if (route?.name === 'checkout.store') return [{ ...common, type: 'delete', ttl: null }];
        return hit ? [{ ...common, type: 'hit', ttl: null }] : [{ ...common, type: 'miss', ttl: null }, { ...common, type: 'write', ttl: 3600, duration_ms: 0.6 }];
      }),
    group: (l) => ({ store: 'redis', ...cacheCounts(l), avg_ms: avg(durations(l)) }),
    summary: (l) => {
      const { hit_ratio, ...counts } = cacheCounts(l);
      return { ...counts, ...(hit_ratio === null ? {} : { hit_ratio }) };
    },
    filters: { store: (e) => e.store, type: (e) => e.type },
    search: ['key', 'store'],
  };
  const statusClass = (code: unknown) => (code === null || code === undefined ? 'error' : `${String(code)[0]}xx`);
  const failedCalls = (l: MockEvent[]) => count(l, (e) => e.status_code === null || Number(e.status_code) >= 400);
  MOCK_SPECS['/outgoing-requests'] = {
    // Mirrors the Stripe span the checkout trace detail shows.
    build: () =>
      fromTraces('request', (t) =>
        t.name === 'POST /checkout'
          ? [{ key: 'api.stripe.com', host: 'api.stripe.com', method: 'POST', url: 'https://api.stripe.com/v1/payment_intents', status_code: t.exception_count ? 402 : 200, duration_ms: t.duration_ms * 0.35 }]
          : [],
      ),
    group: (l) => ({ methods: [...new Set(l.map((e) => e.method))].join(','), failed: failedCalls(l), server_errors: count(l, (e) => Number(e.status_code) >= 500), avg_ms: avg(durations(l)), max_ms: max(durations(l)) }),
    summary: (l) => ({ requests: l.length, failed: failedCalls(l), avg_ms: avg(durations(l)) ?? 0 }),
    filters: { method: (e) => e.method, status: (e) => statusClass(e.status_code) },
    search: ['host', 'url'],
  };
  // Every successful checkout sends an order confirmation email and a Slack notification.
  const okCheckouts = (row: (t: TraceSummary) => Cells & { key: string }) =>
    fromTraces('request', (t) => (t.name === 'POST /checkout' && !t.exception_count ? [row(t)] : []));
  const sentStatus = (e: MockEvent) => (e.failed ? 'failed' : 'sent');
  MOCK_SPECS['/mail'] = {
    build: () =>
      okCheckouts((t) => ({ key: 'App\\Mail\\OrderConfirmation', mailer: 'ses', subject: 'Your order is confirmed', to_count: 1, cc_count: 0, bcc_count: 1, attachments: 1, duration_ms: t.duration_ms * 0.2, failed: 0 })),
    group: (l) => ({ mailers: 'ses', failed: count(l, (e) => Boolean(e.failed)), recipients: l.reduce((a, e) => a + Number(e.to_count) + Number(e.cc_count) + Number(e.bcc_count), 0), avg_ms: avg(durations(l)), max_ms: max(durations(l)) }),
    summary: (l) => ({ sent: l.length, failed: count(l, (e) => Boolean(e.failed)), avg_ms: avg(durations(l)) ?? 0 }),
    filters: { mailer: (e) => e.mailer, status: sentStatus },
    search: ['key', 'subject'],
  };
  MOCK_SPECS['/notifications'] = {
    build: () => okCheckouts((t) => ({ key: 'App\\Notifications\\NewOrder', channel: 'slack', duration_ms: t.duration_ms * 0.1, failed: 0 })),
    group: (l) => ({ channels: 'slack', failed: count(l, (e) => Boolean(e.failed)), avg_ms: avg(durations(l)), max_ms: max(durations(l)) }),
    summary: (l) => ({ sent: l.length, failed: count(l, (e) => Boolean(e.failed)), avg_ms: avg(durations(l)) ?? 0 }),
    filters: { channel: (e) => e.channel, status: sentStatus },
    search: ['key', 'channel'],
  };
  // The seed's artisan command traces are scheduler runs: `shop:refresh-bestsellers` hourly.
  MOCK_SPECS['/scheduled-tasks'] = {
    build: () =>
      fromTraces('command', (t) => [{ key: t.name, name: t.name, cron: '0 * * * *', timezone: 'UTC', status: t.exception_count ? 'failed' : 'processed', duration_ms: t.duration_ms }]),
    group: (l) => ({ cron: '0 * * * *', timezone: 'UTC', processed: count(l, (e) => e.status === 'processed'), failed: count(l, (e) => e.status === 'failed'), skipped: count(l, (e) => e.status === 'skipped'), avg_ms: avg(durations(l)), max_ms: max(durations(l)) }),
    summary: (l) => ({ runs: l.length, failed: count(l, (e) => e.status === 'failed'), skipped: count(l, (e) => e.status === 'skipped'), avg_ms: avg(durations(l)) ?? 0 }),
    filters: { status: (e) => e.status },
    search: ['name', 'cron'],
  };
  // Failed requests log an error; successful checkouts log an info line.
  const LOG_ERRORS = ['emergency', 'alert', 'critical', 'error'];
  MOCK_SPECS['/logs'] = {
    build: () =>
      fromTraces('request', (t) =>
        t.exception_count
          ? [{ key: 'error', level: 'error', message: `Unhandled exception in ${t.name}`, context: `{"status":${t.status_code ?? 500}}` }]
          : t.name === 'POST /checkout'
            ? [{ key: 'info', level: 'info', message: 'Order placed', context: '{"items":3}' }]
            : [],
      ),
    group: (l) => ({ traces: new Set(l.map((e) => e.trace_id)).size }),
    summary: (l) => ({ logs: l.length, errors: count(l, (e) => LOG_ERRORS.includes(String(e.level))), warnings: count(l, (e) => e.level === 'warning') }),
    filters: { level: (e) => e.level },
    search: ['message', 'context'],
  };
  MOCK_SPECS['/users'] = {
    build: () =>
      fromTraces('request', (t) =>
        t.user ? [{ key: t.user, name: `User ${t.user}`, execution_source: 'request', status_code: t.status_code, exception_count: t.exception_count, duration_ms: t.duration_ms }] : [],
      ),
    group: (l) => ({
      name: l[0]?.name ?? null,
      requests: l.length,
      server_errors: count(l, (e) => Number(e.status_code) >= 500),
      exceptions: l.reduce((a, e) => a + Number(e.exception_count ?? 0), 0),
      avg_ms: avg(durations(l)),
    }),
    summary: (l) => ({ users: new Set(l.map((e) => e.key)).size, traces: l.length, exceptions: l.reduce((a, e) => a + Number(e.exception_count ?? 0), 0) }),
    filters: { source: (e) => e.execution_source },
    search: ['key', 'trace_name'],
  };
  // Every request trace doubles as a page view; checkout is the slow page.
  const goodShare = (l: MockEvent[], col: string, max: number) => (l.length ? count(l, (e) => Number(e[col]) <= max) / l.length : null);
  const avgOf = (l: MockEvent[], col: string) => avg(l.map((e) => Number(e[col])));
  const vitalsTotals = (l: MockEvent[]) => ({
    lcp_ms: avgOf(l, 'lcp_ms'), inp_ms: avgOf(l, 'inp_ms'), cls: avgOf(l, 'cls'), fcp_ms: avgOf(l, 'fcp_ms'), ttfb_ms: avgOf(l, 'ttfb_ms'),
    lcp_good: goodShare(l, 'lcp_ms', 2500), inp_good: goodShare(l, 'inp_ms', 200), cls_good: goodShare(l, 'cls', 0.1),
  });
  MOCK_SPECS['/web-vitals'] = {
    build: () =>
      fromTraces('request', (t) => {
        if (t.method !== 'GET') return [];
        const slow = t.name.includes('checkout') ? 2 : 1;
        return [{ key: t.route ?? t.name, lcp_ms: 900 * slow + t.duration_ms, inp_ms: 60 * slow, cls: 0.02 * slow, fcp_ms: 400 + t.duration_ms / 2, ttfb_ms: t.duration_ms }];
      }),
    group: vitalsTotals,
    summary: (l) => Object.fromEntries(Object.entries({ views: l.length, ...vitalsTotals(l) }).map(([k, v]) => [k, v ?? 0])),
    search: ['key'],
  };
  const built = new Map<string, MockEvent[]>();
  const allEvents = (path: string) => {
    let events = built.get(path);
    if (!events) {
      events = MOCK_SPECS[path].build().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).map((event, index) => ({ ...event, id: `${profile.id}:${index + 1}` }));
      built.set(path, events);
    }
    return activeEnvironment() === undefined ? events : events.filter((row) => row.environment === activeEnvironment());
  };

  function events(path: string, range: Range = '24h', params: Record<string, string | undefined> = {}): EventList {
    const spec = MOCK_SPECS[path];
    if (!spec) return { data: [] };
    const { since, now } = timeWindow(range, NOW)!;
    const needle = params.q?.toLowerCase();
    const list = allEvents(path).filter(
      (e) =>
        Date.parse(e.timestamp) >= since && Date.parse(e.timestamp) <= now && (params.user === undefined || e.user === params.user) &&
        Object.entries(spec.filters ?? {}).every(([param, value]) => !params[param] || params[param] === 'all' || String(value(e)) === params[param]) &&
        (!needle || spec.search.some((col) => String(e[col] ?? '').toLowerCase().includes(needle))),
    );
    const groups = new Map<string, MockEvent[]>();
    for (const e of list) groups.set(e.key, [...(groups.get(e.key) ?? []), e]);
    const data = [...groups.entries()].map(([key, l]) => ({ key, count: l.length, last_seen: l[0].timestamp, ...spec.group(l) })).sort((a, b) => b.count - a.count);
    return { data, ...(spec.summary ? { summary: spec.summary(list) } : {}) };
  }

  function eventRows(path: string, key: string, range: Range = '24h', user?: string): EventRow[] | null {
    if (!MOCK_SPECS[path]) return null;
    const { since, now } = timeWindow(range, NOW)!;
    const rows = allEvents(path).filter((e) => e.key === key && (user === undefined || e.user === user) && Date.parse(e.timestamp) >= since && Date.parse(e.timestamp) <= now).slice(0, 50);
    return rows.length ? rows.map(({ key: _k, ...r }) => r) : null;
  }

  function logEntries(range: Range, level: string, q: string, cursor: string | null, user?: string): Paginated<EventRow> {
    const { since, now } = timeWindow(range, NOW)!;
    const rows = allEvents('/logs').filter((row) => (user === undefined || row.user === user) && Date.parse(row.timestamp) >= since && Date.parse(row.timestamp) <= now
      && (level === 'all' || row.level === level) && String(row.message).toLowerCase().includes(q.toLowerCase()));
    const offset = Number(cursor) || 0;
    return { data: rows.slice(offset, offset + 50), next_cursor: rows.length > offset + 50 ? String(offset + 50) : null };
  }

  function logEntry(id: string, range: Range, user?: string): EventRow | null {
    const { since, now } = timeWindow(range, NOW)!;
    const row = allEvents('/logs').find((row) => String(row.id) === id && (user === undefined || row.user === user) && Date.parse(row.timestamp) >= since && Date.parse(row.timestamp) <= now);
    return row ? { ...row, project_id: profile.id, execution_available: 1 } : null;
  }

  function environments() {
    const counts = new Map<string, number>();
    for (const { summary } of TRACES) if (summary.environment) counts.set(summary.environment, (counts.get(summary.environment) ?? 0) + 1);
    return [...counts].map(([name, traces]) => ({ name, traces })).sort((a, b) => a.name.localeCompare(b.name));
  }
  return { overview, traces, trace, exceptions, exception, queries, query, events, eventRows, environments, logEntries, logEntry };
}

type Dataset = ReturnType<typeof createDataset>;
const datasets = new Map<string, Dataset>();
let activeProject = MOCK_PROJECTS[0].id;

export function setMockProject(id: string) {
  activeProject = id;
}

function ds(): Dataset {
  const profile = MOCK_PROJECTS.find((p) => p.id === activeProject) ?? MOCK_PROJECTS[0];
  let dataset = datasets.get(profile.id);
  if (!dataset) {
    dataset = createDataset(profile);
    datasets.set(profile.id, dataset);
  }
  return dataset;
}

export const environments: Dataset['environments'] = () => ds().environments();
export const overview: Dataset['overview'] = (...a) => ds().overview(...a);
export const traces: Dataset['traces'] = (...a) => ds().traces(...a);
export const trace: Dataset['trace'] = (...a) => ds().trace(...a);
export const exceptions: Dataset['exceptions'] = (...a) => ds().exceptions(...a);
export const exception: Dataset['exception'] = (...a) => ds().exception(...a);
export const queries: Dataset['queries'] = (...a) => ds().queries(...a);
export const query: Dataset['query'] = (...a) => ds().query(...a);
export const events: Dataset['events'] = (...a) => ds().events(...a);
export const logEntries: Dataset['logEntries'] = (...a) => ds().logEntries(...a);
export const logEntry: Dataset['logEntry'] = (...a) => ds().logEntry(...a);
export const eventRows: Dataset['eventRows'] = (...a) => ds().eventRows(...a);

/** Demo pipeline: healthy consumer, no dead letters. */
export function pipeline(now = Date.now()): import('./types').PipelineHealth {
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const minute = now - (now % 60_000) - (59 - i) * 60_000;
    return { minute: new Date(minute).toISOString(), batches: 3, messages: 40 + ((i * 7) % 25), retried: 0, max_lag_ms: 800 + ((i * 131) % 1500) };
  });
  return {
    dead_letters: { count: 0, oldest_failed_at: null, replay_pending: 0 },
    consumer: {
      last_batch_at: minutes[59].minute,
      messages_1h: minutes.reduce((n, m) => n + m.messages, 0),
      retried_1h: 0,
      max_lag_ms_5m: Math.max(...minutes.slice(-5).map((m) => m.max_lag_ms)),
      max_lag_ms_1h: Math.max(...minutes.map((m) => m.max_lag_ms)),
    },
    minutes,
  };
}

/** Demo usage: a week of records per project, no quota. */
export function usage(now = Date.now()): import('./types').UsageDay[] {
  return Array.from({ length: 7 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10)).flatMap((day, i) => [
    { project_id: 'shop-api', day, records: 48_000 - i * 1_900, quota: null, blocked_at: null },
    { project_id: 'admin', day, records: 6_200 + ((i * 731) % 900), quota: null, blocked_at: null },
  ]);
}
