#!/usr/bin/env bash
# Vibe Tavern launcher — thin wrapper around the compiled binary.
# Self-update logic lives inside the binary: `vibe-tavern update` does the
# check, prompt, download, verify, and atomic swap, then exits so we can
# exec the (possibly updated) server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="${SCRIPT_DIR}/vibe-tavern"

if [ ! -x "$BINARY" ]; then
	echo "Error: $BINARY not found or not executable." >&2
	echo "  Re-download from https://github.com/Noineri/vibe_tavern/releases" >&2
	exit 1
fi

# Update is best-effort — never block server start. Failures exit 0 so we
# still exec the current build.
"$BINARY" update || echo "  (update skipped, starting current version)"

exec "$BINARY" "$@"
