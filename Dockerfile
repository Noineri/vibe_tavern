FROM node:20-slim

RUN npm install -g bun@1.3.11

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile
RUN bun run build:api-stack
RUN bun run --filter @rp-platform/web build

RUN mkdir -p /app/data

ENV RP_PLATFORM_API_HOST=0.0.0.0
ENV RP_PLATFORM_API_PORT=8787
ENV RP_PLATFORM_ROOT_DIR=/app
ENV RP_PLATFORM_DB_PATH=/app/data/rp-platform.db
ENV RP_PLATFORM_WEB_PORT=3000

EXPOSE 8787 3000

CMD ["sh", "-c", "trap 'kill 0' SIGINT SIGTERM; bun services/api/dist/services/api/src/dev-server.js & bun scripts/serve-static.ts apps/web/dist ${RP_PLATFORM_WEB_PORT:-3000} & wait"]
