#!/usr/bin/env bash
# Runs scripts/libsql.test.ts against EDGEWATCH_TEST_LIBSQL_URL, or a throwaway sqld (libSQL server) container (needs Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${EDGEWATCH_TEST_LIBSQL_URL:-}" ]; then
  LIBSQL_PORT="${LIBSQL_PORT:-58081}"
  container="edgewatch-test-libsql-$$"
  docker run -d --rm --name "$container" -p "127.0.0.1:$LIBSQL_PORT:8080" "${LIBSQL_IMAGE:-ghcr.io/tursodatabase/libsql-server:latest}" >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$LIBSQL_PORT/health" >/dev/null && break; sleep 1; done
  export EDGEWATCH_TEST_LIBSQL_URL="http://127.0.0.1:$LIBSQL_PORT"
fi
cd "$ROOT" && bun test --timeout 60000 scripts/libsql.test.ts
