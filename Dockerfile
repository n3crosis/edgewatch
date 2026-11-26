# EdgeWatch as one Bun process (apps/server): ingest, consumer, API and dashboard on port 8080.
#   docker build -t edgewatch .
#   docker run -p 8080:8080 -v edgewatch-data:/data edgewatch
# SQLite and blobs live in /data unless DATABASE_URL (Postgres) and S3_* are set. See docs/deployment.md.
ARG BUN_IMAGE=oven/bun:1.4.5-alpine

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/server/package.json apps/server/
COPY packages/browser/package.json packages/browser/
COPY packages/shared/package.json packages/shared/
COPY workers/api/package.json workers/api/
COPY workers/consumer/package.json workers/consumer/
COPY workers/ingest/package.json workers/ingest/

FROM deps AS dashboard
RUN bun install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages packages
COPY apps/dashboard apps/dashboard
RUN cd apps/dashboard && VITE_API_URL=/ bun run build

FROM deps
RUN bun install --frozen-lockfile --production && rm -rf ~/.bun/install/cache
COPY packages/shared/src packages/shared/src
COPY workers/api/src workers/api/src
COPY workers/consumer/src workers/consumer/src
COPY workers/ingest/src workers/ingest/src
COPY workers/migrations workers/migrations
COPY scripts/accounts.ts scripts/keys.ts scripts/pg-migrate.ts scripts/mysql-migrate.ts scripts/libsql-migrate.ts scripts/
COPY apps/server/src apps/server/src
COPY --from=dashboard /app/apps/dashboard/dist /app/dashboard
ENV PORT=8080 EDGEWATCH_DATA_DIR=/data DASHBOARD_DIR=/app/dashboard NODE_ENV=production
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["bun", "apps/server/src/main.ts"]
CMD ["serve"]
