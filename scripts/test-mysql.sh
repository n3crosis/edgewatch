#!/usr/bin/env bash
# Runs scripts/mysql.test.ts against EDGEWATCH_TEST_MYSQL_URL, or a throwaway MySQL container (needs Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${EDGEWATCH_TEST_MYSQL_URL:-}" ]; then
  MYSQL_PORT="${MYSQL_PORT:-53307}"
  container="edgewatch-test-mysql-$$"
  docker run -d --rm --name "$container" -e MYSQL_ROOT_PASSWORD=edgewatch -e MYSQL_DATABASE=edgewatch -p "127.0.0.1:$MYSQL_PORT:3306" \
    "${MYSQL_IMAGE:-mirror.gcr.io/library/mysql:8.4}" >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 90); do docker exec "$container" mysql -uroot -pedgewatch -h 127.0.0.1 -e 'SELECT 1' edgewatch >/dev/null 2>&1 && break; sleep 1; done
  export EDGEWATCH_TEST_MYSQL_URL="mysql://root:edgewatch@127.0.0.1:$MYSQL_PORT/edgewatch"
fi
cd "$ROOT" && bun test --timeout 60000 scripts/mysql.test.ts
