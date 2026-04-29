#!/bin/sh

# Forward SIGTERM/SIGINT to all child processes
trap "kill 0" SIGINT SIGTERM

echo "Starting RP Platform API server on ${RP_PLATFORM_API_HOST}:${RP_PLATFORM_API_PORT}..."
bun services/api/dist/services/api/src/dev-server.js &

echo "Starting web server on port ${RP_PLATFORM_WEB_PORT:-3000}..."
serve -s apps/web/dist -l "${RP_PLATFORM_WEB_PORT:-3000}" &

wait
