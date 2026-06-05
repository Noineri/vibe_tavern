# syntax=docker/dockerfile:1

# ---- Stage 1: Build ----
FROM oven/bun:1.3.14 AS builder
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
RUN bun install --frozen-lockfile

# Source & build
COPY . .
RUN bun scripts/install-platform-optionals.ts
RUN bun scripts/build.ts prod

# ---- Stage 2: Production runtime ----
FROM oven/bun:1.3.14-alpine AS release
WORKDIR /app

# Copy only runtime artifacts from builder
COPY --from=builder /app/out/services/api/prod-server.js ./out/services/api/
COPY --from=builder /app/out/services/api/prod-server.js.map ./out/services/api/
COPY --from=builder /app/out/services/api/script-ai-prompt.md ./out/services/api/
COPY --from=builder /app/out/services/api/tokenizers ./out/services/api/tokenizers/
COPY --from=builder /app/out/services/api/drizzle ./out/services/api/drizzle/
COPY --from=builder /app/out/apps/web ./out/apps/web

RUN mkdir -p /app/data && chown -R bun:bun /app

ENV RP_PLATFORM_HOST=0.0.0.0
ENV RP_PLATFORM_PORT=8787
ENV RP_PLATFORM_ROOT_DIR=/app
ENV VIBE_TAVERN_DB_PATH=/app/data/vibe-tavern.db
ENV RP_PLATFORM_OPEN_BROWSER=0
ENV VIBE_TAVERN_EXTERNAL_HOST=

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8787/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

USER bun
CMD ["bun", "out/services/api/prod-server.js"]
