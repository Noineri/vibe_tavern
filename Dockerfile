FROM oven/bun:1

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile
RUN bun run build:api-stack
RUN bun run --filter @rp-platform/web build

RUN mkdir -p /app/data
RUN chmod +x /app/docker-entrypoint.sh

ENV RP_PLATFORM_API_HOST=0.0.0.0
ENV RP_PLATFORM_API_PORT=8787
ENV RP_PLATFORM_DB_PATH=/app/data/app.sqlite
ENV RP_PLATFORM_WEB_PORT=3000

EXPOSE 8787 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
