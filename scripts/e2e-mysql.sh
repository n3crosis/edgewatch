#!/usr/bin/env bash
# Runs scripts/e2e.sh with MySQL (through a local Hyperdrive binding) as the event store instead of D1.
# Uses E2E_MYSQL_URL if set; otherwise starts a throwaway MySQL container (needs Docker).
#   MYSQL_IMAGE  image to run (default mirror.gcr.io/library/mysql:8.4; Docker Hub can rate-limit)
#   MYSQL_PORT   host port for the container (default 53306)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${E2E_MYSQL_URL:-}" ]; then
  MYSQL_PORT="${MYSQL_PORT:-53306}"
  container="edgewatch-e2e-mysql-$$"
  docker run -d --rm --name "$container" -e MYSQL_ROOT_PASSWORD=edgewatch -e MYSQL_DATABASE=edgewatch -p "127.0.0.1:$MYSQL_PORT:3306" \
    "${MYSQL_IMAGE:-mirror.gcr.io/library/mysql:8.4}" >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 90); do docker exec "$container" mysql -uroot -pedgewatch -h 127.0.0.1 -e 'SELECT 1' edgewatch >/dev/null 2>&1 && break; sleep 1; done
  export E2E_MYSQL_URL="mysql://root:edgewatch@127.0.0.1:$MYSQL_PORT/edgewatch"
fi
E2E_DB=mysql bash "$ROOT/scripts/e2e.sh"
