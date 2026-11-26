#!/usr/bin/env bash
# Live end-to-end check, entirely local (wrangler dev / Miniflare, no Cloudflare account needed):
#   agent-style gzip batches (the official Nightwatch agent's wire format) --> workers/ingest --Queue-->
#   workers/consumer --> D1 + R2 --> workers/api, across several projects sent with one owner key, checking that the
#   project filter returns each project's own data. The official agent itself is exercised by scripts/nightwatch-agent.sh.
#
# Usage: scripts/e2e.sh            (from the repo root; needs bun install)
#   E2E_KEEP=1   leave wrangler running afterwards for manual poking
#   INGEST_PORT / API_PORT override the default 8787 / 8788
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.wrangler/e2e-state"
LOGS="$ROOT/.wrangler/e2e-logs"
INGEST_PORT="${INGEST_PORT:-8787}"
API_PORT="${API_PORT:-8788}"
PROJECT="e2e"
PROJECT_B="e2e-billing"   # second app, tagged with X-EdgeWatch-Project on the same owner key (single-tenant)
SECRET="e2e-signing-secret"
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
  # wrangler spawns workerd; kill whole process trees so ports are freed.
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

for port in "$INGEST_PORT" "$API_PORT"; do
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
READ_KEY="ew_read_e2e_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
kvput "apikey:$(sha256 "$INGEST_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"e2e\",\"scopes\":[\"ingest\"]}"
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


API="http://127.0.0.1:$API_PORT/v1/projects/$PROJECT"
auth=(-H "authorization: Bearer $READ_KEY")
check() { # description, node expression over `d` (parsed JSON)
  printf '%s' "$2" | node -e "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}try{process.exit(($3)?0:1)}catch{process.exit(1)}})" && ok "$1" || bad "$1"
}

step "Second project ($PROJECT_B): same owner key, tagged with X-EdgeWatch-Project"
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
traces_b=""
for _ in $(seq 1 45); do
  traces_b=$(curl -fsS "${auth[@]}" "$API_B/traces?limit=50" 2>/dev/null || true)
  printf '%s' "$traces_b" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.exit(JSON.parse(s).data.length>=1?0:1)}catch{process.exit(1)}})' && break; sleep 1
done
printf "%s" "$traces_b" > "$LOGS/traces-b.json"
check "filter: $PROJECT_B traces are only its invoice request (status 500)" "$traces_b" "d.data.length===1 && d.data[0].trace_id==='$TB' && d.data[0].status_code===500"
check "filter: $PROJECT_B exceptions = only CardDeclined (PII scrubbed)" "$(curl -fsS "${auth[@]}" "$API_B/exceptions")" "d.data.length===1 && d.data[0].class.endsWith('CardDeclined') && !JSON.stringify(d).includes('billing@example.com')"
check "filter: $PROJECT_B queries are only its invoices insert, literals stripped" "$(curl -fsS "${auth[@]}" "$API_B/queries")" "d.data.length===1 && d.data[0].sql.includes('invoices') && !d.data[0].sql.includes('4200')"
check "api: $PROJECT exceptions contain none of $PROJECT_B's" "$(curl -fsS "${auth[@]}" "$API/exceptions")" "!d.data.some(e=>e.class.endsWith('CardDeclined'))"
check "api: /v1/traces?project_id=$PROJECT has none of $PROJECT_B's traces" "$(curl -fsS "${auth[@]}" "http://127.0.0.1:$API_PORT/v1/traces?project_id=$PROJECT&limit=200")" "!d.data.some(t=>t.trace_id==='$TB')"
check "api: /v1/projects lists the tagged project $PROJECT_B" "$(curl -fsS "${auth[@]}" "http://127.0.0.1:$API_PORT/v1/projects")" "d.data.some(p=>p.id==='$PROJECT_B')"
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
