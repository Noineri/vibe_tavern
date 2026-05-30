#!/data/data/com.termux/files/usr/bin/bash
# Vibe Tavern — start prebuilt server inside proot Ubuntu.
# Usage: bash start.sh

set -euo pipefail

DISTRO="${VIBE_TAVERN_DISTRO:-ubuntu}"

if [ -z "${TERMUX_VERSION:-}" ]; then
    echo "❌ This script must be run inside Termux."
    exit 1
fi

if ! command -v proot-distro >/dev/null 2>&1; then
    echo "❌ proot-distro not found. Run install.sh first."
    exit 1
fi

if ! proot-distro list 2>&1 | grep -q "${DISTRO}"; then
    echo "❌ proot ${DISTRO} not found. Run install.sh first."
    exit 1
fi

echo "🚀 Starting Vibe Tavern on http://127.0.0.1:8787 ..."
termux-wake-lock 2>/dev/null || true

proot-distro login "${DISTRO}" -- bash -lc '
set -euo pipefail
APP_DIR="$HOME/vibe-tavern"
START_SCRIPT="$HOME/start-vibe-tavern.sh"

if [ ! -x "$APP_DIR/vibe-tavern" ]; then
    echo "❌ Vibe Tavern binary not found. Run install.sh first."
    exit 1
fi

if [ -x "$START_SCRIPT" ]; then
    exec "$START_SCRIPT"
fi

export RP_PLATFORM_OPEN_BROWSER=0
export RP_PLATFORM_HOST=127.0.0.1
export RP_PLATFORM_PORT=8787
export RP_PLATFORM_DATA_DIR="$HOME/.local/share/vibe-tavern"
export RP_PLATFORM_WEB_DIR="$APP_DIR/web"
cd "$APP_DIR"
exec ./vibe-tavern
'
