# syntax=docker/dockerfile:1

# ---- Stage 1: Build ----
FROM oven/bun:1.4.0 AS builder
WORKDIR /app

# Layer-cached dependency install — copy all workspace manifests first
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/api-contracts/package.json packages/api-contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/import-export/package.json packages/import-export/
COPY packages/prompt-pipeline/package.json packages/prompt-pipeline/
COPY services/api/package.json services/api/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Source & build
COPY . .
RUN bun scripts/build.ts prod

# ---- Stage 2: Production runtime ----
FROM oven/bun:1.4.0-alpine AS release
WORKDIR /app

# Copy only runtime artifacts from builder
COPY --from=builder /app/out/services ./out/services
COPY --from=builder /app/out/apps/web ./out/apps/web

RUN mkdir -p /app/data && chown -R bun:bun /app

ENV VIBE_TAVERN_HOST=0.0.0.0
ENV VIBE_TAVERN_PORT=8787
ENV VIBE_TAVERN_ROOT_DIR=/app
ENV VIBE_TAVERN_DB_PATH=/app/data/vibe-tavern.db
ENV VIBE_TAVERN_OPEN_BROWSER=0
ENV VIBE_TAVERN_EXTERNAL_HOST=
ENV VIBE_TAVERN_DOCKER=1

EXPOSE 8787

RUN apk add --no-cache tini

USER bun

ENTRYPOINT ["tini", "--"]
CMD ["bun", "out/services/api/prod-server.js"]
