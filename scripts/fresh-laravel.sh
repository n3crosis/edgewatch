#!/usr/bin/env bash
# Fresh Laravel 12 install check, entirely local (wrangler dev / Miniflare, no Cloudflare account needed):
#   composer create-project laravel/laravel:^12.0 in a temp dir outside the repo
#   + packages/laravel-edgewatch as a symlinked path repository
#   -> php artisan migrate, the package's Pest suite, the app's own tests
#   -> one HTTP request, one artisan command, one queued job and one cache call, sent to workers/ingest
#   -> the records read back from workers/api (project fresh-l12).
#
# CLIENT=nightwatch swaps the EdgeWatch package for the official laravel/nightwatch package and runs its unmodified
# `php artisan nightwatch:agent` with NIGHTWATCH_BASE_URL pointed at the local ingest Worker (the drop-in path).
#
# Usage: scripts/fresh-laravel.sh   (from the repo root; needs bun install, composer install in the package, network for create-project)
#   CLIENT=edgewatch|nightwatch  client to install (default edgewatch)
#   RUNTIME=workers|server      wrangler dev Workers (default), or the single Bun process in apps/server (SQLite + files)
#   FRESH_KEEP=1                leave the app dir and wrangler running afterwards
#   INGEST_PORT / API_PORT / APP_PORT / AGENT_PORT override the default 8797 / 8798 / 8020 / 2417
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.wrangler/fresh-state"
LOGS="$ROOT/.wrangler/fresh-logs"
INGEST_PORT="${INGEST_PORT:-8797}"
API_PORT="${API_PORT:-8798}"
APP_PORT="${APP_PORT:-8020}"
AGENT_PORT="${AGENT_PORT:-2417}"
CLIENT="${CLIENT:-edgewatch}"
case "$CLIENT" in edgewatch|nightwatch) ;; *) echo "CLIENT must be edgewatch or nightwatch"; exit 1 ;; esac
RUNTIME="${RUNTIME:-workers}"
case "$RUNTIME" in workers|server) ;; *) echo "RUNTIME must be workers or server"; exit 1 ;; esac
PROJECT="fresh-l12"
PACKAGE="$ROOT/packages/laravel-edgewatch"
WRANGLER="$ROOT/workers/ingest/node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="bunx wrangler"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/edgewatch-fresh-XXXXXX")"
APP="$WORK/app"

pass=0; fail=0
ok() { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
step() { echo; echo "==> $*"; }

pids=()
cleanup() {
  if [ "${FRESH_KEEP:-0}" = "1" ]; then echo "FRESH_KEEP=1: app in $APP, processes left running (${pids[*]:-})"; return; fi
  killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null || true; }
  for p in "${pids[@]:-}"; do [ -n "$p" ] && killtree "$p"; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_for() { # url, name
  for _ in $(seq 1 60); do curl --connect-timeout 1 --max-time 2 -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  echo "Timed out waiting for $2 ($1). Logs in $LOGS"; exit 1
}
sha256() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
key() { echo "$1_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

for port in "$INGEST_PORT" "$API_PORT" "$APP_PORT" "$AGENT_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "Port $port is already in use; stop that process or override the port."; exit 1; fi
done

step "Local harness ($RUNTIME): fresh state in $STATE, migrations, keys"
rm -rf "$STATE" "$LOGS"; mkdir -p "$STATE" "$LOGS"
INGEST_KEY="$(key ew_live_fresh)"; READ_KEY="$(key ew_read_fresh)"
if [ "$RUNTIME" = server ]; then
  # One Bun process (apps/server) on SQLite + local files serves ingest, consumer and API on the same port.
  API_PORT="$INGEST_PORT"
  export EDGEWATCH_DATA_DIR="$STATE/server"
  bun "$ROOT/apps/server/src/main.ts" migrate >"$LOGS/migrate.log" 2>&1
  for k in "$INGEST_KEY:fresh:ingest" "$READ_KEY:fresh-read:read"; do
    IFS=: read -r value name scope <<<"$k"
    FRESH_KEY="apikey:$(sha256 "$value")" FRESH_VALUE="{\"project_id\":\"$PROJECT\",\"name\":\"$name\",\"scopes\":[\"$scope\"]}" bun -e "
      import { SqlKeyStore } from '$ROOT/packages/shared/src/sql-keystore.ts'; import { BunSqliteDatabase } from '$ROOT/apps/server/src/sqlite.ts';
      const db = new BunSqliteDatabase(process.env.EDGEWATCH_DATA_DIR + '/edgewatch.sqlite'); await new SqlKeyStore(db).put(process.env.FRESH_KEY, process.env.FRESH_VALUE); db.raw.close();" >>"$LOGS/kv.log" 2>&1
  done
  PORT="$INGEST_PORT" HOST=127.0.0.1 ACCESS_LOG=1 TOKEN_SIGNING_SECRET=fresh-signing-secret INGEST_URL="http://127.0.0.1:$INGEST_PORT/api/ingest" \
    bun "$ROOT/apps/server/src/main.ts" >"$LOGS/ingest-consumer.log" 2>&1 & pids+=($!)
  wait_for "http://127.0.0.1:$INGEST_PORT/health" server
else
  (cd "$ROOT/workers/consumer" && $WRANGLER d1 migrations apply edgewatch --local --persist-to "$STATE" >"$LOGS/migrate.log" 2>&1)
  (cd "$ROOT/workers/ingest" &&
    $WRANGLER kv key put --binding API_KEYS "apikey:$(sha256 "$INGEST_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"fresh\",\"scopes\":[\"ingest\"]}" --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1 &&
    $WRANGLER kv key put --binding API_KEYS "apikey:$(sha256 "$READ_KEY")" "{\"project_id\":\"$PROJECT\",\"name\":\"fresh-read\",\"scopes\":[\"read\"]}" --local --persist-to "$STATE" >>"$LOGS/kv.log" 2>&1)
  (cd "$ROOT" && $WRANGLER dev -c workers/ingest/wrangler.jsonc -c workers/consumer/wrangler.jsonc --port "$INGEST_PORT" \
    --persist-to "$STATE" --var "TOKEN_SIGNING_SECRET:fresh-signing-secret" --var "INGEST_URL:http://127.0.0.1:$INGEST_PORT/api/ingest" \
    --inspector-port 0 >"$LOGS/ingest-consumer.log" 2>&1) & pids+=($!)
  # Initialize shared local storage before the API opens it.
  wait_for "http://127.0.0.1:$INGEST_PORT/health" ingest
  (cd "$ROOT/workers/api" && $WRANGLER dev --port "$API_PORT" --persist-to "$STATE" --inspector-port 0 >"$LOGS/api.log" 2>&1) & pids+=($!)
  wait_for "http://127.0.0.1:$API_PORT/health" api
fi

step "composer create-project laravel/laravel:^12.0 in $WORK"
(cd "$WORK" && composer create-project laravel/laravel:^12.0 app --no-interaction --quiet)
cd "$APP"
echo "  $(php artisan --version)"
if [ "$CLIENT" = nightwatch ]; then
  PKG=laravel/nightwatch
  composer require laravel/nightwatch --no-interaction --quiet
else
  PKG=edgewatch/laravel-edgewatch
  composer config repositories.edgewatch "{\"type\":\"path\",\"url\":\"$PACKAGE\",\"options\":{\"symlink\":true}}"
  composer require "edgewatch/laravel-edgewatch:@dev" --no-interaction --quiet
fi
echo "  client: $PKG $(composer show "$PKG" 2>/dev/null | awk '/^versions/{print $NF}')"
php artisan package:discover | grep -q "$PKG" && ok "$PKG auto-discovered" || bad "$PKG auto-discovered"

step "php artisan migrate, package Pest suite, app tests"
EDGEWATCH_ENABLED=false php artisan migrate --force --no-interaction
php artisan migrate:status | grep -c ' Ran' | xargs -I{} echo "  {} migrations ran"
if [ "$CLIENT" = edgewatch ]; then
  out=$(cd "$APP/vendor/edgewatch/laravel-edgewatch" && vendor/bin/pest 2>&1) && ok "package Pest: $(printf '%s' "$out" | grep -oE 'Tests: .*' | tail -1)" || { printf '%s\n' "$out" | tail -20; bad "package Pest"; }
fi
out=$(EDGEWATCH_ENABLED=false php artisan test 2>&1) && ok "app tests: $(printf '%s' "$out" | grep -oE 'Tests: .*' | tail -1)" || { printf '%s\n' "$out" | tail -20; bad "app tests"; }

step "Adding routes, commands, a queued job, a mailable, a notification and a scheduled task"
php artisan make:job FreshJob -q
php artisan make:mail FreshMail -q
php artisan make:notification FreshNotice -q
python3 - <<'PY'
import re
p = 'app/Jobs/FreshJob.php'
s = open(p).read()
s = re.sub(r'public function handle\(\): void\s*\{\s*//\s*\}', lambda m: "public function handle(): void\n    {\n        \\App\\Models\\User::count();\n    }", s)
open(p, 'w').write(s)
p = 'app/Mail/FreshMail.php'
s = open(p).read().replace("view: 'view.name'", "htmlString: '<p>fresh</p>'")
open(p, 'w').write(s)
open('routes/web.php', 'a').write("""
Route::get('/fresh-all', function () {
    \\Illuminate\\Support\\Facades\\Auth::login(\\App\\Models\\User::forceCreate(['name' => 'Fresh User', 'email' => 'fresh@example.com', 'password' => bcrypt('fresh')]));
    \\Illuminate\\Support\\Facades\\Log::warning('fresh log line');
    report(new \\RuntimeException('fresh handled exception'));
    \\Illuminate\\Support\\Facades\\Http::get(env('FRESH_OUTGOING_URL'));
    \\Illuminate\\Support\\Facades\\Mail::to('fresh@example.com')->send(new \\App\\Mail\\FreshMail);
    \\Illuminate\\Support\\Facades\\Notification::route('mail', 'fresh@example.com')->notify(new \\App\\Notifications\\FreshNotice);

    return ['ok' => true];
})->name('fresh-all');
""")
open('routes/web.php', 'a').write("""
Route::get('/fresh', function () {
    \\App\\Jobs\\FreshJob::dispatch();

    return ['users' => \\App\\Models\\User::count()];
})->name('fresh');
""")
open('routes/console.php', 'a').write("""
Artisan::command('fresh:hello', function () {
    $this->info('users: '.\\App\\Models\\User::count());
});

Artisan::command('fresh:cache', function () {
    \\Illuminate\\Support\\Facades\\Cache::put('fresh:visits', 1, 60);
    $this->info('cached: '.\\Illuminate\\Support\\Facades\\Cache::get('fresh:visits'));
});

\\Illuminate\\Support\\Facades\\Schedule::call(fn () => \\App\\Models\\User::count())->everyMinute()->name('fresh-task');
""")
PY
grep -q 'User::count' app/Jobs/FreshJob.php && ok "FreshJob::handle() queries users" || bad "FreshJob::handle() edit"
grep -q htmlString app/Mail/FreshMail.php && ok "FreshMail renders an inline body" || bad "FreshMail edit"

export QUEUE_CONNECTION=database CACHE_STORE=database MAIL_MAILER=array LOG_CHANNEL=stack FRESH_OUTGOING_URL="http://127.0.0.1:$INGEST_PORT/health"
if [ "$CLIENT" = nightwatch ]; then
  # The official agent has no project header; records land in the ingest key's default project ($PROJECT).
  export LOG_STACK=single,nightwatch NIGHTWATCH_ENABLED=true NIGHTWATCH_TOKEN="$INGEST_KEY" NIGHTWATCH_INGEST_URI="127.0.0.1:$AGENT_PORT" NIGHTWATCH_SERVER=fresh-l12
  step "Starting the official agent: NIGHTWATCH_BASE_URL=http://127.0.0.1:$INGEST_PORT php artisan nightwatch:agent"
  NIGHTWATCH_BASE_URL="http://127.0.0.1:$INGEST_PORT" php artisan nightwatch:agent >"$LOGS/agent.log" 2>&1 & pids+=($!)
  for _ in $(seq 1 30); do (exec 3<>"/dev/tcp/127.0.0.1/$AGENT_PORT") 2>/dev/null && break; sleep 1; done
  (exec 3<>"/dev/tcp/127.0.0.1/$AGENT_PORT") 2>/dev/null && ok "agent listening on 127.0.0.1:$AGENT_PORT" || { cat "$LOGS/agent.log"; bad "agent did not start"; exit 1; }
  for _ in $(seq 1 15); do grep -q 'POST /api/agent-auth 200' "$LOGS/ingest-consumer.log" && break; sleep 1; done
  grep -q 'POST /api/agent-auth 200' "$LOGS/ingest-consumer.log" && ok "agent authenticated via /api/agent-auth" || bad "agent authentication (see $LOGS/agent.log)"
else
  export LOG_STACK=single,edgewatch EDGEWATCH_ENABLED=true EDGEWATCH_TOKEN="$INGEST_KEY" EDGEWATCH_INGEST_URI="http://127.0.0.1:$INGEST_PORT/api/ingest" \
    EDGEWATCH_TRANSPORT=http EDGEWATCH_PROJECT_ID="$PROJECT" EDGEWATCH_SERVER=fresh-l12
  step "php artisan edgewatch:test (one empty batch, no telemetry)"
  out=$(EDGEWATCH_TRANSPORT=auto EDGEWATCH_INGEST_URI="http://127.0.0.1:$INGEST_PORT" php artisan edgewatch:test 2>&1); printf '%s\n' "$out" | sed 's/^/  /'
  [[ "$out" == *"auto: ingest URL"* && "$out" == *"/api/ingest"* && "$out" == *"PASS  HTTP 200 in "* ]] && ok "edgewatch:test: HTTP auto-detected, /api/ingest added, HTTP 200" || bad "edgewatch:test"
  if out=$(EDGEWATCH_TOKEN=ew_live_not_a_real_key php artisan edgewatch:test 2>&1); then bad "edgewatch:test with a wrong token should exit 1"
  else [[ "$out" == *"FAIL  HTTP 401 in "* ]] && ok "edgewatch:test with a wrong token: HTTP 401, exit 1" || { printf '%s\n' "$out"; bad "edgewatch:test with a wrong token"; }; fi
fi

step "One HTTP request, one artisan command, one queued job, one cache call"
php artisan serve --host 127.0.0.1 --port "$APP_PORT" >"$LOGS/app.log" 2>&1 & pids+=($!)
wait_for "http://127.0.0.1:$APP_PORT/up" app
body=$(curl -s -w ' HTTP %{http_code}' "http://127.0.0.1:$APP_PORT/fresh"); echo "  GET /fresh -> $body"
[[ "$body" == *"HTTP 200" ]] && ok "request GET /fresh (dispatches FreshJob)" || bad "request GET /fresh"
php artisan fresh:hello && ok "command fresh:hello" || bad "command fresh:hello"
php artisan queue:work --once --stop-when-empty && ok "queued job FreshJob processed" || bad "queue:work"
php artisan fresh:cache && ok "cache call (fresh:cache: Cache::put + Cache::get)" || bad "cache call"
body=$(curl -s -w ' HTTP %{http_code}' "http://127.0.0.1:$APP_PORT/fresh-all"); echo "  GET /fresh-all -> $body"
[[ "$body" == *"HTTP 200" ]] && ok "request GET /fresh-all (signed-in user, log, handled exception, outgoing HTTP, mail, notification)" || bad "request GET /fresh-all"
php artisan schedule:run && ok "schedule:run (fresh-task)" || bad "schedule:run"

step "Records that reached the harness"
[ "$CLIENT" = nightwatch ] && for _ in $(seq 1 30); do [ "$(grep -c 'POST /api/ingest 200' "$LOGS/ingest-consumer.log" || true)" -ge 1 ] && break; sleep 1; done
echo "  ingest accepted $(grep -c 'POST /api/ingest 200' "$LOGS/ingest-consumer.log" || true) batches"
API="http://127.0.0.1:$API_PORT/v1/projects/$PROJECT"
get() { curl -fsS -H "authorization: Bearer $READ_KEY" "$API/$1"; }
check() { # description, json, node expression over d
  printf '%s' "$2" | node -e "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}try{process.exit(($3)?0:1)}catch{process.exit(1)}})" && ok "$1" || bad "$1"
}
traces=""
for _ in $(seq 1 60); do
  traces=$(get "traces?limit=50" 2>/dev/null || true)
  printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s).data,n=x=>d.filter(t=>t.execution_source===x).length;process.exit(n("request")>=2&&n("command")>=2&&n("job")>=1&&n("schedule")>=1?0:1)}catch{process.exit(1)}})' && break
  sleep 1
done
printf '%s' "$traces" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const t of JSON.parse(s).data)console.log(`  trace ${t.execution_source.padEnd(8)} ${t.name}  status=${t.status_code??t.status??"-"} queries=${t.query_count} ${t.duration_ms.toFixed(1)}ms`)})' || true
check "request trace: GET /fresh, route fresh, 200" "$traces" "d.data.some(t=>t.execution_source==='request'&&t.route==='fresh'&&t.status_code===200)"
check "command traces: fresh:hello and fresh:cache, exit 0" "$traces" "['fresh:hello','fresh:cache'].every(n=>d.data.some(t=>t.execution_source==='command'&&t.name.includes(n)&&t.status_code===0))"
check "job trace: App\\Jobs\\FreshJob processed" "$traces" "d.data.some(t=>t.execution_source==='job'&&t.name==='App\\\\Jobs\\\\FreshJob'&&t.status==='processed')"
if [ "$CLIENT" = nightwatch ]; then
  check "job trace links back to the GET /fresh request that dispatched it" "$traces" "d.data.some(t=>t.execution_source==='job'&&t.origin_trace_id===d.data.find(r=>r.route==='fresh')?.trace_id)"
fi
commands=$(get "commands?range=1h"); echo "  /commands $commands"
check "/commands lists fresh:hello" "$commands" "d.data.some(c=>c.key==='fresh:hello'&&c.failed===0)"
jobs=$(get "jobs?range=1h"); echo "  /jobs $jobs"
check "/jobs: FreshJob queued 1, processed 1" "$jobs" "d.data.some(j=>j.key==='App\\\\Jobs\\\\FreshJob'&&j.queued===1&&j.processed===1)"
cache=$(get "cache?range=1h"); echo "  /cache $cache"
check "/cache: fresh:visits 1 write, 1 hit" "$cache" "d.data.some(c=>c.key==='fresh:visits'&&c.writes===1&&c.hits===1)"
queries=$(get "queries?range=1h")
printf '%s' "$queries" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const q of JSON.parse(s).data)console.log(`  query x${q.calls} ${q.sql}`)})' || true
check "/queries has the users count query" "$queries" "d.data.some(q=>/count\\(\\*\\).*users/i.test(q.sql))"
show() { local d; d=$(get "$1"); echo "  /$1 $(printf '%s' "$d" | cut -c1-300)" >&2; printf '%s' "$d"; }
check "/exceptions: RuntimeException (handled)" "$(show 'exceptions?range=1h')" "d.data.some(e=>e.class==='RuntimeException'&&e.message.includes('fresh handled exception'))"
check "/logs: warning 'fresh log line'" "$(show 'logs/warning?q=fresh')" "d.data.some(l=>l.message==='fresh log line')"
check "/outgoing-requests: GET 127.0.0.1/health 200" "$(show 'outgoing-requests/127.0.0.1')" "d.data.some(o=>o.method==='GET'&&o.status_code===200)"
check "/mail: App\\Mail\\FreshMail to 1 recipient" "$(show 'mail/App%5CMail%5CFreshMail')" "d.data.some(m=>m.to_count===1)"
check "/notifications: App\\Notifications\\FreshNotice via mail" "$(show 'notifications/App%5CNotifications%5CFreshNotice')" "d.data.some(n=>n.channel==='mail')"
check "/users: Fresh User with the GET /fresh-all trace" "$(show 'users?range=1h')" "d.data.some(u=>u.name==='Fresh User'&&u.requests>=1)"
check "/scheduled-tasks: fresh-task processed" "$(show 'scheduled-tasks/fresh-task')" "d.data.some(s=>s.status==='processed'&&s.cron==='* * * * *')"

echo
echo "Fresh Laravel ($PKG) result: $pass passed, $fail failed. Logs: $LOGS"
[ "$fail" = 0 ]
