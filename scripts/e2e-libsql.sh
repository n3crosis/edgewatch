#!/usr/bin/env bash
# Runs scripts/e2e.sh with libSQL (LIBSQL_URL on the consumer and API) as the event store instead of D1.
# Uses E2E_LIBSQL_URL if set; otherwise starts a throwaway sqld container (needs Docker).
#   LIBSQL_IMAGE  image to run (default ghcr.io/tursodatabase/libsql-server:latest)
#   LIBSQL_PORT   host port for the container (default 58080)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${E2E_LIBSQL_URL:-}" ]; then
  LIBSQL_PORT="${LIBSQL_PORT:-58080}"
  container="edgewatch-e2e-libsql-$$"
  docker run -d --rm --name "$container" -p "127.0.0.1:$LIBSQL_PORT:8080" "${LIBSQL_IMAGE:-ghcr.io/tursodatabase/libsql-server:latest}" >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$LIBSQL_PORT/health" >/dev/null && break; sleep 1; done
  export E2E_LIBSQL_URL="http://127.0.0.1:$LIBSQL_PORT"
fi
E2E_DB=libsql bash "$ROOT/scripts/e2e.sh"
