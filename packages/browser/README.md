# @edgewatch/browser

Dependency-free reporter for uncaught browser errors and unhandled promise rejections (~2 KB minified).

> **Not part of the Nightwatch wire format.** `laravel/nightwatch` v1.30.6 has no browser record type, so this posts to
> EdgeWatch's own `POST /api/browser` endpoint with a public `browser`-scope key. The ingest Worker converts each event
> into a Nightwatch-shaped `exception` (v3) record with `execution_source: "browser"`, so browser errors show up in the
> same exceptions views.

```ts
import { init } from '@edgewatch/browser';

const edgewatch = init({
  endpoint: 'https://edgewatch-ingest.<you>.workers.dev',
  key: import.meta.env.VITE_EDGEWATCH_BROWSER_KEY, // created with: pnpm --filter @edgewatch/ingest create-key <project> browser web --remote
  release: import.meta.env.VITE_RELEASE,
});

edgewatch.captureException(new Error('handled failure')); // manual, handled: true
```

Options: `traceId` (defaults to `<meta name="edgewatch-trace-id">`, which links the error to the server trace),
`user`, `sampleRate`, `maxEventsPerMinute` (30), `ignoreErrors`, `beforeSend`, `flushInterval` (1000 ms).
Delivery uses `navigator.sendBeacon` (falls back to `fetch` with `keepalive`); events are batched and flushed on `pagehide`.

Restrict a key to your sites by adding `"allowed_origins": ["https://shop.example.com"]` to its KV record.

Not implemented: source-map upload/symbolication, breadcrumbs, web-vitals/performance, session replay.
