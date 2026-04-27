FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN npm install
RUN npm run build:api-stack
RUN npm run build --workspace @rp-platform/web

RUN npm install -g serve@latest

RUN mkdir -p /app/data

ENV RP_PLATFORM_API_HOST=0.0.0.0
ENV RP_PLATFORM_API_PORT=8787
ENV RP_PLATFORM_DB_PATH=/app/data/app.sqlite
ENV RP_PLATFORM_WEB_PORT=3000
ENV NODE_ENV=production

EXPOSE 8787 3000

RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
