#!/usr/bin/env bash
# Local load test on Miniflare (no Cloudflare account): fresh state, ingest+consumer in one wrangler dev, api in another,
# then scripts/load-test.ts. The per-project rate limiter is raised (LOAD_RATE_LIMIT, default 1000000 per 60 s) so the
# numbers show pipeline throughput; set LOAD_RATE_LIMIT=600 to see the default limit's 429s instead.
#   DURATION=20 CONCURRENCY=8 TRACES_PER_REQUEST=10 QUERIES_PER_TRACE=10 scripts/load-test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.wrangler/load-state"
LOGS="$ROOT/.wrangler/load-logs"
INGEST_PORT="${INGEST_PORT:-8797}"
API_PORT="${API_PORT:-8798}"
WRANGLER="$ROOT/workers/ingest/node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="bunx wrangler"
CONFIG="$ROOT/workers/ingest/wrangler.load.jsonc"

pids=()
cleanup() {
  killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null || true; }
  for p in "${pids[@]:-}"; do [ -n "$p" ] && killtree "$p"; done
  rm -f "$CONFIG"
  wait 2>/dev/null || true
}
trap cleanup EXIT
wait_for() { for _ in $(seq 1 60); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done; echo "Timed out waiting for $1 (logs in $LOGS)"; exit 1; }
sha256() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

rm -rf "$STATE" "$LOGS"; mkdir -p "$STATE" "$LOGS"
sed "s/\"limit\": 600/\"limit\": ${LOAD_RATE_LIMIT:-1000000}/" "$ROOT/workers/ingest/wrangler.jsonc" > "$CONFIG"
(cd "$ROOT/workers/consumer" && $WRANGLER d1 migrations apply edgewatch --local --persist-to "$STATE" >"$LOGS/migrate.log" 2>&1)
INGEST_KEY="ew_live_load_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
READ_KEY="ew_read_load_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
(cd "$ROOT/workers/ingest" &&
  $WRANGLER kv key put --binding API_KEYS "apikey:$(sha256 "$INGEST_KEY")" '{"project_id":"load","name":"load","scopes":["ingest"]}' --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1 &&
  $WRANGLER kv key put --binding API_KEYS "apikey:$(sha256 "$READ_KEY")" '{"project_id":"load","name":"load-read","scopes":["read"]}' --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1)
(cd "$ROOT" && $WRANGLER dev -c "$CONFIG" -c workers/consumer/wrangler.jsonc --port "$INGEST_PORT" --persist-to "$STATE" \
  --var "TOKEN_SIGNING_SECRET:load" --inspector-port 0 >"$LOGS/ingest-consumer.log" 2>&1) & pids+=($!)
(cd "$ROOT/workers/api" && $WRANGLER dev --port "$API_PORT" --persist-to "$STATE" --inspector-port 0 >"$LOGS/api.log" 2>&1) & pids+=($!)
wait_for "http://127.0.0.1:$INGEST_PORT/health"
wait_for "http://127.0.0.1:$API_PORT/health"
INGEST_URL="http://127.0.0.1:$INGEST_PORT/api/ingest" API_URL="http://127.0.0.1:$API_PORT" INGEST_KEY="$INGEST_KEY" READ_KEY="$READ_KEY" \
  bun "$ROOT/scripts/load-test.ts"
