#!/data/data/com.termux/files/usr/bin/bash
# Vibe Tavern — archive installer for Termux + proot Ubuntu on Android.
# Usage: curl -fsSL https://.../install.sh | bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ARCHIVE_URL="${VIBE_TAVERN_ARCHIVE_URL:-}"
ARCHIVE_PATH="${VIBE_TAVERN_ARCHIVE_PATH:-}"
DISTRO="${VIBE_TAVERN_DISTRO:-ubuntu}"
TOKEN="${VIBE_TAVERN_GH_TOKEN:-${GH_TOKEN:-}}"

echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      Vibe Tavern — Android Setup     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""

if [ -z "${TERMUX_VERSION:-}" ]; then
    echo -e "${RED}❌ This script must be run inside Termux.${NC}"
    echo "   Install Termux from F-Droid, not Play Store:"
    echo "   https://f-droid.org/packages/com.termux/"
    exit 1
fi

echo -e "${GREEN}✅ Termux detected${NC}"

echo ""
echo "📦 Step 1/5: Updating system packages (fixes broken curl on fresh Termux)..."
yes | apt update -y 2>/dev/null || true
yes | apt full-upgrade -y 2>/dev/null || true

echo ""
echo "📦 Step 2/5: Installing Termux packages..."
yes | pkg update -y
yes | pkg install -y curl tar proot-distro procps

echo ""
echo "🐧 Step 3/5: Ensuring proot Ubuntu exists..."
if ! proot-distro list 2>&1 | grep -q "${DISTRO}"; then
    yes | proot-distro install "${DISTRO}"
else
    echo -e "${GREEN}✅ ${DISTRO} already installed${NC}"
fi

echo ""
echo "📥 Step 4/5: Downloading Vibe Tavern archive..."
if [ -z "${ARCHIVE_PATH}" ] && [ -z "${ARCHIVE_URL}" ]; then
    echo -e "${RED}❌ Set VIBE_TAVERN_ARCHIVE_PATH or VIBE_TAVERN_ARCHIVE_URL.${NC}"
    exit 1
fi
proot-distro login "${DISTRO}" -- bash -s -- "${ARCHIVE_PATH}" "${ARCHIVE_URL}" "${TOKEN}" <<'UBUNTU_INSTALL'
set -euo pipefail

echo '📦 Step 5/5: Installing Vibe Tavern inside Ubuntu...'

ARCHIVE_PATH="$1"
ARCHIVE_URL="$2"
TOKEN="$3"
APP_DIR="$HOME/vibe-tavern"
DATA_DIR="$HOME/.local/share/vibe-tavern"
TMP_ARCHIVE="/tmp/vibe-tavern-android-arm64.tar.gz"
NEXT_DIR="$HOME/vibe-tavern.next"
OLD_DIR="$HOME/vibe-tavern.old"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl tar procps

mkdir -p "$DATA_DIR"
rm -f "$TMP_ARCHIVE"

if [ -n "$ARCHIVE_PATH" ]; then
    cp "$ARCHIVE_PATH" "$TMP_ARCHIVE"
elif [ -n "$TOKEN" ]; then
    curl -fL \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/octet-stream" \
        "$ARCHIVE_URL" \
        -o "$TMP_ARCHIVE"
else
    curl -fL "$ARCHIVE_URL" -o "$TMP_ARCHIVE"
fi

rm -rf "$NEXT_DIR"
mkdir -p "$NEXT_DIR"
tar -xzf "$TMP_ARCHIVE" -C "$NEXT_DIR"
chmod +x "$NEXT_DIR/vibe-tavern"

rm -rf "$OLD_DIR"
if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$OLD_DIR"
fi
mv "$NEXT_DIR" "$APP_DIR"
rm -rf "$OLD_DIR" "$TMP_ARCHIVE"

cat > "$HOME/start-vibe-tavern.sh" <<'START_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
export RP_PLATFORM_OPEN_BROWSER=0
export RP_PLATFORM_HOST=127.0.0.1
export RP_PLATFORM_PORT=8787
export RP_PLATFORM_DATA_DIR="$HOME/.local/share/vibe-tavern"
export RP_PLATFORM_WEB_DIR="$HOME/vibe-tavern/web"
cd "$HOME/vibe-tavern"
exec ./vibe-tavern
START_SCRIPT
chmod +x "$HOME/start-vibe-tavern.sh"
UBUNTU_INSTALL

echo ""
echo -e "${GREEN}✅ Vibe Tavern installed/updated.${NC}"
echo "   Program files: proot ${DISTRO}: ~/vibe-tavern"
echo "   User data:     proot ${DISTRO}: ~/.local/share/vibe-tavern"
echo ""
echo -e "${YELLOW}Next:${NC} run ./start.sh or tap Start Server in the APK."
