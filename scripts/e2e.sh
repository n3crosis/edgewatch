#!/usr/bin/env bash
# Live end-to-end check, entirely local (wrangler dev / Miniflare, no Cloudflare account needed):
#   examples/laravel-sandbox --HTTPS transport--> workers/ingest --Queue--> workers/consumer --> D1 + R2 --> workers/api
#
# Usage: scripts/e2e.sh            (from the repo root; needs pnpm install + composer install in the sandbox)
#   E2E_KEEP=1   leave wrangler/sandbox running afterwards for manual poking
#   INGEST_PORT / API_PORT / APP_PORT override the default 8787 / 8788 / 8010
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.wrangler/e2e-state"
LOGS="$ROOT/.wrangler/e2e-logs"
INGEST_PORT="${INGEST_PORT:-8787}"
API_PORT="${API_PORT:-8788}"
APP_PORT="${APP_PORT:-8010}"
PROJECT="e2e"
SECRET="e2e-signing-secret"
SANDBOX="$ROOT/examples/laravel-sandbox"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="npx wrangler"

pass=0; fail=0
ok() { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
step() { echo; echo "==> $*"; }

pids=()
cleanup() {
  if [ "${E2E_KEEP:-0}" = "1" ] && [ "$fail" = "0" ]; then echo "E2E_KEEP=1: leaving processes running (${pids[*]})"; return; fi
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for() { # url, name
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  echo "Timed out waiting for $2 ($1). Logs in $LOGS"; exit 1
}

sha256() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

for port in "$INGEST_PORT" "$API_PORT" "$APP_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "Port $port is already in use; stop that process or override the port."; exit 1; fi
done

step "Fresh local state in $STATE"
rm -rf "$STATE" "$LOGS"; mkdir -p "$STATE" "$LOGS"

step "Applying D1 migrations (local)"
(cd "$ROOT/workers/consumer" && $WRANGLER d1 migrations apply edgewatch --local --persist-to "$STATE" >"$LOGS/migrate.log" 2>&1)

step "Creating API keys in local KV"
INGEST_KEY="ew_live_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
READ_KEY="ew_read_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
(cd "$ROOT/workers/ingest" &&
  $WRANGLER kv key put --binding API_KEYS "apikey:$(sha256 "$INGEST_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e\",\"scopes\":[\"ingest\"]}" --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1 &&
  $WRANGLER kv key put --binding API_KEYS "apikey:$(sha256 "$READ_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e-read\",\"scopes\":[\"read\"]}" --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1)

step "Starting workers: ingest+consumer on :$INGEST_PORT (one process, shared local queue), api on :$API_PORT"
(cd "$ROOT" && $WRANGLER dev -c workers/ingest/wrangler.jsonc -c workers/consumer/wrangler.jsonc --port "$INGEST_PORT" \
  --persist-to "$STATE" --var "TOKEN_SIGNING_SECRET:$SECRET" --var "INGEST_URL:http://127.0.0.1:$INGEST_PORT/api/ingest" \
  --inspector-port 0 >"$LOGS/ingest-consumer.log" 2>&1) & pids+=($!)
(cd "$ROOT/workers/api" && $WRANGLER dev --port "$API_PORT" --persist-to "$STATE" --inspector-port 0 >"$LOGS/api.log" 2>&1) & pids+=($!)
wait_for "http://127.0.0.1:$INGEST_PORT/health" ingest
wait_for "http://127.0.0.1:$API_PORT/health" api

step "Preparing the Laravel sandbox (sqlite at database/e2e.sqlite)"
export EDGEWATCH_ENABLED=true EDGEWATCH_TOKEN="$INGEST_KEY" EDGEWATCH_INGEST_URI="http://127.0.0.1:$INGEST_PORT/api/ingest" \
  EDGEWATCH_SERVER=sandbox-e2e EDGEWATCH_TRANSPORT=http DB_CONNECTION=sqlite DB_DATABASE="$SANDBOX/database/e2e.sqlite" \
  QUEUE_CONNECTION=database CACHE_STORE=array APP_ENV=local APP_DEBUG=false
cd "$SANDBOX"
[ -f .env ] || { cp .env.example .env; php artisan key:generate -q; }
rm -f database/e2e.sqlite && touch database/e2e.sqlite
php artisan migrate --force -q && php artisan db:seed --force -q
php artisan serve --host 127.0.0.1 --port "$APP_PORT" >"$LOGS/sandbox.log" 2>&1 & pids+=($!)
wait_for "http://127.0.0.1:$APP_PORT/up" sandbox

step "Generating telemetry through the real HTTP path"
APP="http://127.0.0.1:$APP_PORT"
curl -fsS -o /dev/null "$APP/users/1" && ok "GET /users/1 (request + queries)" || bad "GET /users/1"
curl -fsS -o /dev/null "$APP/report" && ok "GET /report" || bad "GET /report"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/checkout"); [ "$code" = 500 ] && ok "POST /checkout -> 500 (exception)" || bad "POST /checkout returned $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/orders"); [ "$code" = 202 ] && ok "POST /orders -> 202 (cache + queued job)" || bad "POST /orders returned $code"
php artisan queue:work --once --stop-when-empty -q && ok "queue:work ran SendOrderConfirmation (job-attempt)" || bad "queue:work"
php artisan report:daily -q && ok "artisan report:daily (command)" || bad "artisan report:daily"

step "Waiting for the consumer to write D1/R2, then querying workers/api"
API="http://127.0.0.1:$API_PORT/v1/projects/$PROJECT"
auth=(-H "authorization: Bearer $READ_KEY")
traces=""
for _ in $(seq 1 45); do
  traces=$(curl -fsS "${auth[@]}" "$API/traces?limit=50" 2>/dev/null || true)
  n=$(printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.length)}catch{console.log(0)}})')
  [ "$n" -ge 6 ] && break; sleep 1
done
check() { # description, node expression over `d` (parsed JSON)
  printf '%s' "$2" | node -e "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}try{process.exit(($3)?0:1)}catch{process.exit(1)}})" && ok "$1" || bad "$1"
}
check "api: >= 6 traces (4 requests, 1 job, 1 command) from server sandbox-e2e" "$traces" \
  "d.data.length>=6 && d.data.every(t=>t.server==='sandbox-e2e') && ['request','job','command'].every(s=>d.data.some(t=>t.execution_source===s))"
check "api: POST /checkout trace has status 500 and 1 exception" "$traces" "d.data.some(t=>t.name.includes('/checkout')&&t.status_code===500&&t.exception_count>=1)"

TRACE_ID=$(printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(t=>t.name.includes("/users/")).trace_id))')
detail=$(curl -fsS "${auth[@]}" "$API/traces/$TRACE_ID" || echo '{}')
check "api: trace detail reads raw records back from R2 (request + queries, literals stripped)" "$detail" \
  "d.records.some(r=>r.t==='request') && d.records.filter(r=>r.t==='query').length>=2 && !JSON.stringify(d).includes('@example.com')"
check "api: trace detail has a derived waterfall" "$detail" "d.spans.length>=3"

orders=$(printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(t=>t.name.includes("/orders")).trace_id))')
odetail=$(curl -fsS "${auth[@]}" "$API/traces/$orders" || echo '{}')
check "api: /orders trace holds cache-event and queued-job records" "$odetail" "d.records.some(r=>r.t==='cache-event') && d.records.some(r=>r.t==='queued-job')"

check "api: exceptions grouped, message PII scrubbed" "$(curl -fsS "${auth[@]}" "$API/exceptions")" \
  "d.data.some(e=>e.class==='RuntimeException' && e.message.includes('[email]') && !e.message.includes('jane@'))"
check "api: queries grouped by sql_hash" "$(curl -fsS "${auth[@]}" "$API/queries")" "d.data.length>=2 && d.data.every(q=>/^[0-9a-f]{32}$/.test(q.sql_hash))"
check "api: overview counts requests" "$(curl -fsS "${auth[@]}" "$API/overview?range=1h")" "d.requests>=4"

step "Nightwatch agent handshake and over-quota stop instruction"
auth_body=$(curl -s -X POST "http://127.0.0.1:$INGEST_PORT/api/agent-auth" -H "authorization: Bearer $INGEST_KEY" -H 'content-type: application/json' -H 'nightwatch-server: e2e' -d '{}')
check "ingest: /api/agent-auth returns token, expires_in, refresh_in, ingest_url" "$auth_body" "typeof d.token==='string' && Number.isInteger(d.expires_in) && Number.isInteger(d.refresh_in) && d.ingest_url.endsWith('/api/ingest')"
(cd "$ROOT/workers/ingest" && $WRANGLER kv key put --binding API_KEYS "project:$PROJECT" "{\"over_quota_until\":$(( $(date +%s) + 120 )),\"message\":\"e2e quota\"}" --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1)
sleep 1
quota=$(curl -s -D "$LOGS/quota.headers" -X POST "http://127.0.0.1:$INGEST_PORT/api/ingest" -H "authorization: Bearer $INGEST_KEY" -H 'content-type: application/json' -d '{"records":[]}')
check "ingest: over-quota project gets 429 {stop:true, refresh_in}" "$quota" "d.stop===true && d.refresh_in>60"
grep -qi '^retry-after:' "$LOGS/quota.headers" && grep -q ' 429' "$LOGS/quota.headers" && ok "ingest: 429 carries Retry-After" || bad "ingest: 429 + Retry-After header"

echo
echo "E2E result: $pass passed, $fail failed. Logs: $LOGS"
[ "$fail" = 0 ]
