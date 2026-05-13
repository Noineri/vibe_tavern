FROM oven/bun:1.3.13

WORKDIR /app

# --- Layer-cached dependency install ---
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/api-contracts/package.json packages/api-contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/import-export/package.json packages/import-export/
COPY packages/prompt-pipeline/package.json packages/prompt-pipeline/
COPY services/api/package.json services/api/
RUN bun install --frozen-lockfile

# --- Source & build ---
COPY . .
RUN bun run build:api-stack
RUN bun run --filter @rp-platform/web build

RUN mkdir -p /app/data

ENV RP_PLATFORM_API_HOST=0.0.0.0
ENV RP_PLATFORM_API_PORT=8787
ENV RP_PLATFORM_ROOT_DIR=/app
ENV RP_PLATFORM_DB_PATH=/app/data/rp-platform.db
ENV RP_PLATFORM_WEB_PORT=3000

EXPOSE 8787 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8787/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "trap 'kill 0' SIGINT SIGTERM; bun services/api/dist/services/api/src/dev-server.js & bun scripts/serve-static.ts apps/web/dist ${RP_PLATFORM_WEB_PORT:-3000} & wait"]
