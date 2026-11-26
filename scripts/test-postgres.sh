#!/usr/bin/env bash
# Runs scripts/postgres.test.ts against EDGEWATCH_TEST_POSTGRES_URL, or a throwaway Postgres container (needs Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${EDGEWATCH_TEST_POSTGRES_URL:-}" ]; then
  PG_PORT="${PG_PORT:-55434}"
  container="edgewatch-test-pg-$$"
  docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=edgewatch -e POSTGRES_DB=edgewatch -p "127.0.0.1:$PG_PORT:5432" \
    "${PG_IMAGE:-mirror.gcr.io/library/postgres:16-alpine}" >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 30); do docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
  export EDGEWATCH_TEST_POSTGRES_URL="postgres://postgres:edgewatch@127.0.0.1:$PG_PORT/edgewatch"
fi
cd "$ROOT" && bun test --timeout 60000 scripts/postgres.test.ts
