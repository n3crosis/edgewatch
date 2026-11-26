#!/usr/bin/env bash
# Live end-to-end check, entirely local (wrangler dev / Miniflare, no Cloudflare account needed):
#   examples/laravel-sandbox --HTTPS transport--> workers/ingest --Queue--> workers/consumer --> D1 + R2 --> workers/api
# for two projects (e2e, e2e-billing) sent with one owner key, checking that the project filter returns each project's own data.
#
# Usage: scripts/e2e.sh            (from the repo root; needs bun install + composer install in the sandbox)
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
PROJECT_B="e2e-billing"   # second app, tagged with EDGEWATCH_PROJECT_ID on the same owner key (single-tenant)
SECRET="e2e-signing-secret"
SANDBOX="$ROOT/examples/laravel-sandbox"
# bun uses isolated installs, so wrangler lives in the worker package, not the repo root.
WRANGLER="$ROOT/workers/ingest/node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="bunx wrangler"

pass=0; fail=0
ok() { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
step() { echo; echo "==> $*"; }

pids=()
cleanup() {
  if [ "${E2E_KEEP:-0}" = "1" ] && [ "$fail" = "0" ]; then echo "E2E_KEEP=1: leaving processes running (${pids[*]})"; return; fi
  # wrangler spawns workerd and artisan serve spawns php; kill whole process trees so ports are freed.
  killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null || true; }
  for p in "${pids[@]:-}"; do [ -n "$p" ] && killtree "$p"; done
  wait 2>/dev/null || true
  rm -f "$ROOT"/workers/{ingest,consumer,api}/wrangler.e2e.jsonc
}
trap cleanup EXIT

wait_for() { # url, name
  for _ in $(seq 1 60); do curl --connect-timeout 1 --max-time 2 -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
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

# E2E_DB=postgres: the consumer and API use E2E_POSTGRES_URL through a local Hyperdrive binding instead of D1.
# E2E_DB=mysql:    the same with E2E_MYSQL_URL (MySQL 8.0.19+).
# E2E_DB=libsql:   the consumer and API use E2E_LIBSQL_URL (LIBSQL_URL var) instead of D1.
# E2E_BLOBS=s3:    traces, parked payloads and dead letters go to the S3-compatible E2E_S3_ENDPOINT instead of R2.
# E2E_KEYS=sql:    API keys and project blocks live in the Postgres kv_store table instead of KV (needs E2E_DB=postgres).
if [ "${E2E_KEYS:-kv}" = "sql" ] && [ "${E2E_DB:-d1}" != "postgres" ]; then echo "E2E_KEYS=sql needs E2E_DB=postgres"; exit 1; fi
# Backend settings go into generated per-worker configs (wrangler dev --var only reaches the first of several -c configs).
backend_vars=""
if [ "${E2E_BLOBS:-r2}" = "s3" ]; then
  step "Blob store: S3 at $E2E_S3_ENDPOINT (bucket $E2E_S3_BUCKET)"
  backend_vars="\"S3_ENDPOINT\": \"$E2E_S3_ENDPOINT\", \"S3_BUCKET\": \"$E2E_S3_BUCKET\", \"S3_REGION\": \"us-east-1\", \"S3_ACCESS_KEY_ID\": \"${E2E_S3_ACCESS_KEY_ID:-test}\", \"S3_SECRET_ACCESS_KEY\": \"${E2E_S3_SECRET_ACCESS_KEY:-test}\", "
fi
[ "${E2E_KEYS:-kv}" = "sql" ] && { step "Key store: Postgres kv_store table"; backend_vars="$backend_vars\"KEY_STORE\": \"sql\", "; }
hyperdrive=""
db_vars=""
if [ "${E2E_DB:-d1}" = "libsql" ]; then
  step "Event store: libSQL at $E2E_LIBSQL_URL (fresh schema)"
  bun "$ROOT/scripts/libsql-migrate.ts" --fresh "$E2E_LIBSQL_URL" >>"$LOGS/migrate.log" 2>&1 || { echo "libSQL migration failed; see $LOGS/migrate.log"; exit 1; }
  db_vars="\"LIBSQL_URL\": \"$E2E_LIBSQL_URL\", "
elif [ "${E2E_DB:-d1}" = "postgres" ]; then
  step "Event store: Postgres at ${E2E_POSTGRES_URL%%@*}@... (fresh schema)"
  bun "$ROOT/scripts/pg-migrate.ts" --fresh "$E2E_POSTGRES_URL" >>"$LOGS/migrate.log" 2>&1 || { echo "Postgres migration failed; see $LOGS/migrate.log"; exit 1; }
  hyperdrive="  \"hyperdrive\": [{ \"binding\": \"HYPERDRIVE\", \"id\": \"00000000000000000000000000000000\", \"localConnectionString\": \"$E2E_POSTGRES_URL\" }],"
elif [ "${E2E_DB:-d1}" = "mysql" ]; then
  step "Event store: MySQL at ${E2E_MYSQL_URL%%@*}@... (fresh schema)"
  bun "$ROOT/scripts/mysql-migrate.ts" --fresh "$E2E_MYSQL_URL" >>"$LOGS/migrate.log" 2>&1 || { echo "MySQL migration failed; see $LOGS/migrate.log"; exit 1; }
  hyperdrive="  \"hyperdrive\": [{ \"binding\": \"HYPERDRIVE\", \"id\": \"00000000000000000000000000000000\", \"localConnectionString\": \"$E2E_MYSQL_URL\" }],"
fi
config() { # worker dir -> config path relative to the repo root
  local src="workers/$1/wrangler.jsonc"
  if [ -z "$backend_vars$hyperdrive$db_vars" ]; then echo "$src"; return; fi
  local hd="$hyperdrive" vars="$backend_vars$db_vars"; [ "$1" = ingest ] && [ "${E2E_KEYS:-kv}" != "sql" ] && { hd=""; vars="$backend_vars"; }
  awk -v hd="$hd" -v vars="$vars" '{ sub(/"vars": \{ /, "\"vars\": { " vars); print } /"compatibility_flags"/ && hd != "" { print hd }' "$ROOT/$src" >"$ROOT/workers/$1/wrangler.e2e.jsonc"
  echo "workers/$1/wrangler.e2e.jsonc"
}
INGEST_CONFIG=$(config ingest)
CONSUMER_CONFIG=$(config consumer)
API_CONFIG=$(config api)

kvput() { # key, json value: into KV, or into Postgres kv_store with E2E_KEYS=sql
  if [ "${E2E_KEYS:-kv}" = "sql" ]; then
    E2E_KV_KEY="$1" E2E_KV_VALUE="$2" bun -e "import { connectPostgres } from '$ROOT/packages/shared/src/postgres-js.ts'; import { SqlKeyStore } from '$ROOT/packages/shared/src/sql-keystore.ts';
      const pg = connectPostgres(process.env.E2E_POSTGRES_URL, { max: 1 }); await new SqlKeyStore(pg.db).put(process.env.E2E_KV_KEY, process.env.E2E_KV_VALUE); await pg.close();" >>"$LOGS/kv.log" 2>&1
  else
    (cd "$ROOT/workers/ingest" && $WRANGLER kv key put --binding API_KEYS "$1" "$2" --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1)
  fi
}

step "Creating API keys in local KV"
INGEST_KEY="ew_live_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BROWSER_KEY="ew_pub_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
READ_KEY="ew_read_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
kvput "apikey:$(sha256 "$INGEST_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e\",\"scopes\":[\"ingest\"]}"
kvput "apikey:$(sha256 "$BROWSER_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e-browser\",\"scopes\":[\"browser\"]}"
kvput "apikey:$(sha256 "$READ_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e-read\",\"scopes\":[\"read\"]}"

ADMIN_KEY="ew_read_admin_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
kvput "apikey:$(sha256 "$ADMIN_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e-admin\",\"scopes\":[\"admin\"]}"

step "Starting workers: ingest+consumer on :$INGEST_PORT (one process, shared local queue), api on :$API_PORT"
(cd "$ROOT" && $WRANGLER dev -c "$INGEST_CONFIG" -c "$CONSUMER_CONFIG" --port "$INGEST_PORT" \
  --persist-to "$STATE" --var "TOKEN_SIGNING_SECRET:$SECRET" --var "INGEST_URL:http://127.0.0.1:$INGEST_PORT/api/ingest" \
  --inspector-port 0 >"$LOGS/ingest-consumer.log" 2>&1) & pids+=($!)
# Serialize startup: both runtimes open the same local SQLite state.
wait_for "http://127.0.0.1:$INGEST_PORT/health" ingest
(cd "$ROOT" && $WRANGLER dev -c "$API_CONFIG" --port "$API_PORT" --persist-to "$STATE" --inspector-port 0 >"$LOGS/api.log" 2>&1) & pids+=($!)
wait_for "http://127.0.0.1:$API_PORT/health" api
for svc in "ingest $INGEST_PORT" "api $API_PORT"; do
  set -- $svc
  body=$(curl -sS -w '\n%{http_code}' "http://127.0.0.1:$2/healthz" || true)
  if [ "$(tail -n1 <<<"$body")" = 200 ] && grep -q '"status":"ok"' <<<"$body"; then ok "GET /healthz on $1 reports ok"; else bad "GET /healthz on $1: $body"; fi
done

step "Preparing the Laravel sandbox (sqlite at database/e2e.sqlite)"
export LOG_CHANNEL=stack LOG_STACK=single,edgewatch UPSTREAM_URL="http://127.0.0.1:$INGEST_PORT/health" EDGEWATCH_ENABLED=true EDGEWATCH_TOKEN="$INGEST_KEY" EDGEWATCH_INGEST_URI="http://127.0.0.1:$INGEST_PORT/api/ingest" \
  EDGEWATCH_SERVER=sandbox-e2e EDGEWATCH_ENVIRONMENT=e2e-staging EDGEWATCH_TRANSPORT=http DB_CONNECTION=sqlite DB_DATABASE="$SANDBOX/database/e2e.sqlite" \
  QUEUE_CONNECTION=database CACHE_STORE=array APP_ENV=local APP_DEBUG=false
cd "$SANDBOX"
[ -f .env ] || { cp .env.example .env; php artisan key:generate -q; }
rm -f database/e2e.sqlite && touch database/e2e.sqlite
EDGEWATCH_ENABLED=false php artisan migrate --force -q && EDGEWATCH_ENABLED=false php artisan db:seed --force -q
php artisan serve --host 127.0.0.1 --port "$APP_PORT" >"$LOGS/sandbox.log" 2>&1 & pids+=($!)
wait_for "http://127.0.0.1:$APP_PORT/up" sandbox

step "Generating telemetry through the real HTTP path"
APP="http://127.0.0.1:$APP_PORT"
curl -fsS -o /dev/null "$APP/users/1" && ok "GET /users/1 (request + queries)" || bad "GET /users/1"
curl -fsS -o /dev/null "$APP/report" && ok "GET /report" || bad "GET /report"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/welcome"); [ "$code" = 204 ] && ok "POST /welcome -> 204 (mail + notification)" || bad "POST /welcome returned $code"
curl -fsS -o /dev/null "$APP/upstream" && ok "GET /upstream (outgoing HTTP to the ingest /health)" || bad "GET /upstream"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/checkout"); [ "$code" = 500 ] && ok "POST /checkout -> 500 (exception)" || bad "POST /checkout returned $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/orders"); [ "$code" = 202 ] && ok "POST /orders -> 202 (cache + queued job)" || bad "POST /orders returned $code"
php artisan queue:work --once --stop-when-empty -q && ok "queue:work ran SendOrderConfirmation (job-attempt)" || bad "queue:work"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$INGEST_PORT/api/browser?key=$BROWSER_KEY" -H 'content-type: text/plain' \
  -d "{\"events\":[{\"type\":\"error\",\"timestamp\":$(date +%s),\"class\":\"TypeError\",\"message\":\"e2e browser error\",\"file\":\"https://shop.test/app.js\",\"line\":3,\"url\":\"https://shop.test/cart\"}]}")
[ "$code" = 200 ] && ok "POST /api/browser (browser error, EdgeWatch extension)" || bad "POST /api/browser returned $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$INGEST_PORT/api/browser?key=$BROWSER_KEY" -H 'content-type: text/plain' \
  -d "{\"events\":[{\"type\":\"vitals\",\"timestamp\":$(date +%s),\"url\":\"https://shop.test/cart\",\"vitals\":{\"lcp\":1800,\"inp\":120,\"cls\":0.02}}]}")
[ "$code" = 200 ] && ok "POST /api/browser (web vitals)" || bad "POST /api/browser vitals returned $code"
php artisan report:daily -q && ok "artisan report:daily (command)" || bad "artisan report:daily"
php artisan schedule:run -q && ok "artisan schedule:run ran count-users (scheduled-task)" || bad "artisan schedule:run"

step "Waiting for the consumer to write D1/R2, then querying workers/api"
API="http://127.0.0.1:$API_PORT/v1/projects/$PROJECT"
auth=(-H "authorization: Bearer $READ_KEY")
traces=""
for _ in $(seq 1 45); do
  traces=$(curl -fsS "${auth[@]}" "$API/traces?limit=50" 2>/dev/null || true)
  n=$(printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s).data;const has=x=>d.some(t=>t.execution_source===x);const requests=["/users/", "/report", "/welcome", "/upstream", "/checkout", "/orders"];const ready=requests.every(path=>d.some(t=>t.execution_source==="request"&&t.name.includes(path)));console.log(ready&&has("job")&&has("command")&&has("browser")?d.length:0)}catch{console.log(0)}})')
  [ "$n" -ge 7 ] && break; sleep 1
done
check() { # description, node expression over `d` (parsed JSON)
  printf '%s' "$2" | node -e "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}try{process.exit(($3)?0:1)}catch{process.exit(1)}})" && ok "$1" || bad "$1"
}
printf "%s" "$traces" > "$LOGS/traces.json"
check "api: >= 6 server traces (4 requests, 1 job, 1 command) from sandbox-e2e, plus 1 browser trace" "$traces" \
  "d.data.filter(t=>t.server==='sandbox-e2e').length>=6 && d.data.some(t=>t.execution_source==='browser') && d.data.every(t=>['sandbox-e2e','browser'].includes(t.server)) && ['request','job','command'].every(s=>d.data.some(t=>t.execution_source===s))"
check "api: Laravel traces capture environment independently of server, browser remains unknown" "$traces" "d.data.filter(t=>t.server==='sandbox-e2e').every(t=>t.environment==='e2e-staging') && d.data.filter(t=>t.execution_source==='browser').every(t=>t.environment===null)"
environment_traces=$(curl -fsS "${auth[@]}" "$API/traces?environment=e2e-staging")
check "api: environment filter returns only captured Laravel traces" "$environment_traces" "d.data.length>=6 && d.data.every(t=>t.environment==='e2e-staging'&&t.server==='sandbox-e2e')"
check "api: POST /checkout trace has status 500 and 1 exception" "$traces" "d.data.some(t=>t.name.includes('/checkout')&&t.status_code===500&&t.exception_count>=1)"

TRACE_ID=$(printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(t=>t.name.includes("/users/")).trace_id))')
detail=$(curl -fsS "${auth[@]}" "$API/traces/$TRACE_ID" || echo '{}')
check "api: trace detail reads raw records back from R2 (request + queries, literals stripped)" "$detail" \
  "d.records.some(r=>r.t==='request') && d.records.filter(r=>r.t==='query').length>=2 && !JSON.stringify(d).includes('@example.com')"
check "api: trace detail has a derived waterfall" "$detail" "d.spans.length>=3"
if [ "${E2E_BLOBS:-r2}" = "s3" ]; then
  listing=$(curl -fsS "$E2E_S3_ENDPOINT/$E2E_S3_BUCKET?list-type=2" || true)
  printf '%s' "$listing" | grep -q "<Key>traces/$PROJECT/" && ok "s3: trace JSON stored in the S3 bucket, not R2" || bad "s3: no traces/$PROJECT/ objects in $E2E_S3_BUCKET"
fi

orders=$(printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(t=>t.name.includes("/orders")).trace_id))')
odetail=$(curl -fsS "${auth[@]}" "$API/traces/$orders" || echo '{}')
check "api: /orders trace holds cache-event and queued-job records" "$odetail" "d.records.some(r=>r.t==='cache-event') && d.records.some(r=>r.t==='queued-job')"

check "api: exceptions grouped, message PII scrubbed" "$(curl -fsS "${auth[@]}" "$API/exceptions")" \
  "d.data.some(e=>e.class==='RuntimeException' && e.message.includes('[email]') && !e.message.includes('jane@'))"
check "api: browser error stored as an exception (execution_source browser)" "$(curl -fsS "${auth[@]}" "$API/exceptions")" "d.data.some(e=>e.class==='TypeError' && e.message==='e2e browser error')"
check "api: request groups have p95 and complete status counts" "$(curl -fsS "${auth[@]}" "$API/requests?range=1h")" "d.data.length>0 && d.data.every(r=>r.p95_ms!==null && r.requests===r.status_2xx+r.status_3xx+r.status_4xx+r.status_5xx+r.status_other)"
check "api: chronological logs preserve context and origin" "$(curl -fsS "${auth[@]}" "$API/log-entries?level=warning&range=1h")" "d.data.some(r=>r.message.includes('Low stock') && r.trace_id && JSON.parse(r.context).sku==='TSHIRT-M')"
issues=$(curl -fsS "${auth[@]}" "$API/issues?status=open&range=1h")
check "api: unhandled exceptions create issues" "$issues" "d.data.length>0 && d.data.every(i=>i.status==='open')"
ISSUE_ID=$(printf '%s' "$issues" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).data[0].group_hash))')
check "api: admin resolves an issue" "$(curl -fsS -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' -X PUT -d '{"status":"resolved","expected_status":"open","expected_revision":0,"reason":"E2E lifecycle verification"}' "$API/issues/$ISSUE_ID")" "d.status==='resolved'"
check "api: issue resolution has audit history" "$(curl -fsS "${auth[@]}" "$API/issues/$ISSUE_ID")" "d.issue.status==='resolved' && d.changes.some(c=>c.reason==='E2E lifecycle verification') && d.impact.occurrences>0"
check "api: queries grouped by sql_hash" "$(curl -fsS "${auth[@]}" "$API/queries")" "d.data.length>=2 && d.data.every(q=>/^[0-9a-f]{32}$/.test(q.sql_hash))"
check "api: overview counts requests" "$(curl -fsS "${auth[@]}" "$API/overview?range=1h")" "d.requests>=4"
check "api: /jobs groups SendOrderConfirmation (queued + attempt, queue, duration)" "$(curl -fsS "${auth[@]}" "$API/jobs?range=1h")" "d.data.some(j=>j.key.endsWith('SendOrderConfirmation')&&j.queued>=1&&j.attempts>=1&&j.queue&&j.max_ms!==null)"
check "api: /commands lists the sandbox artisan run with its exit code" "$(curl -fsS "${auth[@]}" "$API/commands?range=1h")" "d.data.length>=1 && d.summary.runs>=1 && d.data.every(c=>typeof c.key==='string')"
check "api: /cache counts the /orders cache operations and a hit ratio" "$(curl -fsS "${auth[@]}" "$API/cache?range=1h")" "d.data.length>=1 && (d.summary.hits+d.summary.misses+d.summary.writes)>=1 && 'hit_ratio' in d.summary"
check "api: /outgoing-requests has the /upstream call (host, GET, 200)" "$(curl -fsS "${auth[@]}" "$API/outgoing-requests?range=1h")" "d.data.some(g=>g.key==='127.0.0.1' && g.methods.includes('GET') && g.failed===0)"
check "api: /mail has the /welcome email (subject scrubbed, notification mail not double counted)" "$(curl -fsS "${auth[@]}" "$API/mail/%28raw%29?range=1h")" "d.data.length===1 && d.data[0].subject==='Welcome [email]' && d.data[0].to_count===1"
check "api: /notifications has App\\Notifications\\Welcome via mail" "$(curl -fsS "${auth[@]}" "$API/notifications?range=1h")" "d.data.some(g=>g.key==='App\\\\Notifications\\\\Welcome' && g.channels==='mail')"
check "api: /scheduled-tasks has count-users (* * * * *, processed)" "$(curl -fsS "${auth[@]}" "$API/scheduled-tasks?range=1h")" "d.data.some(g=>g.key==='count-users' && g.cron==='* * * * *' && g.processed>=1 && g.failed===0)"
check "api: /logs has the /orders warning (message and context PII-scrubbed, level filter)" "$(curl -fsS "${auth[@]}" "$API/logs/warning?range=1h")" "d.data.some(r=>r.message==='Low stock after order for [email]' && JSON.parse(r.context).sku==='TSHIRT-M')"
check "api: /web-vitals groups the /cart page view" "$(curl -fsS "${auth[@]}" "$API/web-vitals?range=1h")" "d.data.some(g=>g.key==='/cart' && g.lcp_ms===1800 && g.lcp_good===1)"
check "api: /users answers (users list endpoint)" "$(curl -fsS "${auth[@]}" "$API/users?range=1h")" "Array.isArray(d.data) && 'users' in d.summary"

step "Second project ($PROJECT_B): same owner key, tagged with EDGEWATCH_PROJECT_ID / X-EdgeWatch-Project"
EDGEWATCH_PROJECT_ID="$PROJECT_B" EDGEWATCH_SERVER=billing-e2e php artisan report:daily -q \
  && ok "artisan report:daily with EDGEWATCH_PROJECT_ID=$PROJECT_B (same owner token)" || bad "artisan report:daily ($PROJECT_B)"
TB="0f1e2d3c-4b5a-4987-8a6b-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
NOW=$(date +%s)
BATCH_B=$(cat <<JSON
{"records":[
 {"v":1,"t":"request","timestamp":$NOW.1,"deploy":"b1","server":"billing-e2e","_group":"g","trace_id":"$TB","execution_source":"request","execution_id":"$TB","execution_preview":"POST /v1/invoices","execution_stage":"end","user":"7","method":"POST","url":"https://billing.test/v1/invoices","route_path":"/v1/invoices","status_code":500,"duration":42000},
 {"v":1,"t":"query","timestamp":$NOW.2,"deploy":"b1","server":"billing-e2e","_group":"g","trace_id":"$TB","execution_source":"request","execution_id":"$TB","execution_preview":"POST /v1/invoices","execution_stage":"action","user":"7","sql":"insert into invoices (customer_id, amount_cents) values (991, 4200)","file":"app/Billing/Invoicer.php","line":20,"duration":2100,"connection":"pgsql"},
 {"v":3,"t":"exception","timestamp":$NOW.3,"deploy":"b1","server":"billing-e2e","_group":"gx","trace_id":"$TB","execution_source":"request","execution_id":"$TB","execution_preview":"POST /v1/invoices","execution_stage":"action","user":"7","class":"App\\\\Billing\\\\CardDeclined","file":"app/Billing/Invoicer.php","line":31,"message":"Card declined for billing@example.com","code":"402","trace":"[]","handled":false}
]}
JSON
)
code=$(printf '%s' "$BATCH_B" | gzip -c | curl -s -o "$LOGS/ingest-b.json" -w '%{http_code}' -X POST "http://127.0.0.1:$INGEST_PORT/api/ingest" \
  -H "authorization: Bearer $INGEST_KEY" -H "x-edgewatch-project: $PROJECT_B" -H 'content-type: application/json' -H 'content-encoding: gzip' -H 'user-agent: NightwatchAgent/1.30.6' --data-binary @-)
[ "$code" = 200 ] && grep -q '"accepted":3' "$LOGS/ingest-b.json" && ok "ingest: $PROJECT_B gzip batch accepted (request, query, exception)" || bad "ingest $PROJECT_B returned $code $(cat "$LOGS/ingest-b.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$INGEST_PORT/api/ingest?project=bad%20tag" -H "authorization: Bearer $INGEST_KEY" \
  -H 'content-type: application/json' -d '{"records":[]}')
[ "$code" = 422 ] && ok "ingest: malformed project tag -> 422" || bad "malformed project tag returned $code"

API_B="http://127.0.0.1:$API_PORT/v1/projects/$PROJECT_B"
auth_b=("${auth[@]}")   # one read key for every project
traces_b=""
for _ in $(seq 1 45); do
  traces_b=$(curl -fsS "${auth_b[@]}" "$API_B/traces?limit=50" 2>/dev/null || true)
  printf '%s' "$traces_b" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s).data;process.exit(d.length>=2?0:1)}catch{process.exit(1)}})' && break; sleep 1
done
traces_a=$(curl -fsS "${auth[@]}" "$API/traces?limit=200")
exc_a=$(curl -fsS "${auth[@]}" "$API/exceptions"); exc_b=$(curl -fsS "${auth_b[@]}" "$API_B/exceptions")
qry_a=$(curl -fsS "${auth[@]}" "$API/queries"); qry_b=$(curl -fsS "${auth_b[@]}" "$API_B/queries")
printf '%s' "$traces_b" > "$LOGS/traces-b.json"
check "filter: $PROJECT_B traces are only its command + invoice request" "$traces_b" \
  "d.data.length===2 && d.data.every(t=>t.server==='billing-e2e') && d.data.some(t=>t.trace_id==='$TB'&&t.status_code===500) && d.data.some(t=>t.execution_source==='command')"
check "filter: $PROJECT traces contain none of $PROJECT_B's" "$traces_a" "d.data.length>=7 && !d.data.some(t=>t.server==='billing-e2e'||t.trace_id==='$TB')"
check "filter: $PROJECT_B exceptions = only CardDeclined (PII scrubbed)" "$exc_b" "d.data.length===1 && d.data[0].class.endsWith('CardDeclined') && !d.data[0].message.includes('billing@')"
check "filter: $PROJECT exceptions contain no CardDeclined" "$exc_a" "d.data.length>=2 && !d.data.some(e=>e.class.endsWith('CardDeclined'))"
check "filter: $PROJECT_B queries are only its own (invoices insert + users count)" "$qry_b" "d.data.length>=1 && d.data.some(q=>q.sql.includes('invoices')) && d.data.every(q=>!q.sql.includes('orders'))"
check "filter: $PROJECT queries contain no invoices SQL" "$qry_a" "d.data.length>=2 && !d.data.some(q=>q.sql.includes('invoices'))"
all_t=$(curl -fsS "${auth[@]}" "http://127.0.0.1:$API_PORT/v1/traces?limit=200")
check "api: /v1/traces without a filter returns both projects" "$all_t" "d.data.some(t=>t.trace_id==='$TB') && d.data.some(t=>t.trace_id==='$TRACE_ID')"
check "api: /v1/exceptions?project_id=$PROJECT_B = only CardDeclined" "$(curl -fsS "${auth[@]}" "http://127.0.0.1:$API_PORT/v1/exceptions?project_id=$PROJECT_B")" "d.data.length===1 && d.data[0].class.endsWith('CardDeclined')"
code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$API_B/traces/$TRACE_ID"); [ "$code" = 404 ] && ok "api: $PROJECT trace id is 404 under the $PROJECT_B filter" || bad "trace under other filter returned $code"

step "Dashboard data path: project selector"
auth_all=("${auth[@]}")
check "api: /v1/projects lists exactly $PROJECT and $PROJECT_B" "$(curl -fsS "${auth_all[@]}" "http://127.0.0.1:$API_PORT/v1/projects")" \
  "d.data.map(p=>p.id).sort().join(',')==='$PROJECT,$PROJECT_B'.split(',').sort().join(',')"
ov_a=$(curl -fsS "${auth_all[@]}" "$API/overview?range=1h"); ov_b=$(curl -fsS "${auth_all[@]}" "$API_B/overview?range=1h")
check "dashboard overview: $PROJECT and $PROJECT_B counted separately" "{\"a\":$ov_a,\"b\":$ov_b}" "d.a.requests>=4 && d.b.requests===1 && d.b.exceptions===1 && d.a.top_routes.every(r=>!r.route.includes('invoices'))"

step "Every Nightwatch record type across two more projects (agent-style gzip batches): D1, R2, API and project filter"
node "$ROOT/scripts/e2e-records.mjs" "http://127.0.0.1:$INGEST_PORT" "http://127.0.0.1:$API_PORT/v1" "$INGEST_KEY" "$READ_KEY" e2e-matrix-a e2e-matrix-b > "$LOGS/records.log" 2>&1; records_exit=$?
while IFS= read -r line; do
  case "$line" in PASS\ *) ok "${line#PASS }" ;; FAIL\ *) bad "${line#FAIL }" ;; *) [ -n "$line" ] && echo "  $line" ;; esac
done < "$LOGS/records.log"
[ "$records_exit" = 0 ] && ok "record matrix script exited 0" || bad "record matrix script exited $records_exit (see $LOGS/records.log)"

step "Nightwatch agent handshake and over-quota stop instruction"
auth_body=$(curl -s -X POST "http://127.0.0.1:$INGEST_PORT/api/agent-auth" -H "authorization: Bearer $INGEST_KEY" -H 'content-type: application/json' -H 'nightwatch-server: e2e' -d '{}')
check "ingest: /api/agent-auth returns token, expires_in, refresh_in, ingest_url" "$auth_body" "typeof d.token==='string' && Number.isInteger(d.expires_in) && Number.isInteger(d.refresh_in) && d.ingest_url.endsWith('/api/ingest')"
kvput "project:$PROJECT" "{\"over_quota_until\":$(( $(date +%s) + 120 )),\"message\":\"e2e quota\"}"
sleep 1
quota=$(curl -s -D "$LOGS/quota.headers" -X POST "http://127.0.0.1:$INGEST_PORT/api/ingest" -H "authorization: Bearer $INGEST_KEY" -H 'content-type: application/json' -d '{"records":[]}')
check "ingest: over-quota project gets 429 {stop:true, refresh_in}" "$quota" "d.stop===true && d.refresh_in>60"
grep -qi '^retry-after:' "$LOGS/quota.headers" && grep -q ' 429' "$LOGS/quota.headers" && ok "ingest: 429 carries Retry-After" || bad "ingest: 429 + Retry-After header"

echo
echo "E2E result: $pass passed, $fail failed. Logs: $LOGS"
[ "$fail" = 0 ]
