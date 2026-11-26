# @edgewatch/browser

Dependency-free reporter for uncaught browser errors and unhandled promise rejections, with breadcrumbs, plus Core Web Vitals.

> **Not part of the Nightwatch wire format.** `laravel/nightwatch` v1.30.6 has no browser record type, so this posts to
> EdgeWatch's own `POST /api/browser` endpoint with a public `browser`-scope key. The ingest Worker converts each event
> into a Nightwatch-shaped `exception` (v3) record with `execution_source: "browser"`, so browser errors show up in the
> same exceptions views.

```ts
import { init } from '@edgewatch/browser';

const edgewatch = init({
  endpoint: 'https://edgewatch-ingest.<you>.workers.dev',
  key: import.meta.env.VITE_EDGEWATCH_BROWSER_KEY, // created with: bun run --filter @edgewatch/ingest create-key <project> browser web --remote
  release: import.meta.env.VITE_RELEASE,
});

edgewatch.captureException(new Error('handled failure')); // manual, handled: true
```

Options: `traceId` (defaults to `<meta name="edgewatch-trace-id">`, which links the error to the server trace),
`user`, `sampleRate`, `maxEventsPerMinute` (30), `ignoreErrors`, `beforeSend`, `flushInterval` (1000 ms).
Delivery uses `navigator.sendBeacon` (falls back to `fetch` with `keepalive`); events are batched and flushed on `pagehide`.

Restrict a key to your sites by adding `"allowed_origins": ["https://shop.example.com"]` to its KV record.

**Breadcrumbs:** the last 20 clicks (element tag/id/class/text, never input values), navigations (`pushState`,
`replaceState`, `popstate`), `console.warn`/`console.error` calls and `fetch` calls (method, URL without query, status)
are attached to each error, and are shown on the trace page. Add your own with `edgewatch.addBreadcrumb({ category, message })`.
Configure with `breadcrumbs: { clicks, navigation, console, fetch, max }` or turn them off with `breadcrumbs: false`.
The ingest Worker PII-scrubs breadcrumb text.

**Web vitals:** LCP, INP (slowest interaction), CLS (session windows), FCP and TTFB are measured with `PerformanceObserver`
and sent once per page view when the page is hidden. They appear on the dashboard's Web vitals page (averages and the
share within Google's "good" thresholds; no p75). Options: `webVitals: false`, `vitalsSampleRate` (0..1). Each page view
with vitals becomes a browser trace (linked to the server trace when `edgewatch-trace-id` is set).

Not implemented: source-map upload/symbolication, session replay.
