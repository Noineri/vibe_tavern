#!/data/data/com.termux/files/usr/bin/bash
# Vibe Tavern — archive installer for Termux + proot Ubuntu on Android.
# The APK passes the bundled archive path and its localhost fallback URL.

set -euo pipefail

ARCHIVE_URL="${VIBE_TAVERN_ARCHIVE_URL:-}"
ARCHIVE_PATH="${VIBE_TAVERN_ARCHIVE_PATH:-}"
DISTRO="${VIBE_TAVERN_DISTRO:-ubuntu}"
LOG="$HOME/vibe-tavern-install.log"

exec > >(tee -a "$LOG") 2>&1

echo "=== Vibe Tavern install/update: $(date) ==="

if [ -z "${TERMUX_VERSION:-}" ]; then
    echo "❌ This installer must run inside Termux."
    exit 1
fi

if [ -z "$ARCHIVE_PATH" ] && [ -z "$ARCHIVE_URL" ]; then
    echo "❌ The APK did not provide its bundled Vibe Tavern archive."
    exit 1
fi

echo "📦 Step 1/5: Updating Termux packages..."
yes | apt update -y 2>/dev/null || true
yes | apt full-upgrade -y 2>/dev/null || true

echo "📦 Step 2/5: Installing Termux tools..."
pkg update -y
pkg install -y curl tar proot-distro procps
printf '\n' | termux-setup-storage 2>/dev/null || true
termux-wake-lock 2>/dev/null || true

echo "🐧 Step 3/5: Ensuring proot Ubuntu exists..."
if ! proot-distro list 2>&1 | grep -q "$DISTRO"; then
    yes | proot-distro install "$DISTRO"
else
    echo "✅ $DISTRO already installed"
fi

mkdir -p ~/.termux
grep -qxF 'allow-external-apps=true' ~/.termux/termux.properties 2>/dev/null \
    || echo 'allow-external-apps=true' >> ~/.termux/termux.properties
termux-reload-settings 2>/dev/null || true

echo "📥 Step 4/5: Getting the bundled Vibe Tavern archive..."
proot-distro login "$DISTRO" -- bash -s -- "$ARCHIVE_PATH" "$ARCHIVE_URL" <<'UBUNTU_INSTALL'
set -euo pipefail

ARCHIVE_PATH="$1"
ARCHIVE_URL="$2"
APP_DIR="$HOME/vibe-tavern"
DATA_DIR="$HOME/.local/share/vibe-tavern"
TMP_ARCHIVE="/tmp/vibe-tavern-android-arm64.tar.gz"
NEXT_DIR="$HOME/vibe-tavern.next"
OLD_DIR="$HOME/vibe-tavern.old"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl tar procps

rm -f "$TMP_ARCHIVE"
RENAMED_ARCHIVE="${ARCHIVE_PATH}.gz"
if [ -n "$ARCHIVE_PATH" ] && [ -f "$ARCHIVE_PATH" ]; then
    echo "Using archive copied from Downloads: $ARCHIVE_PATH"
    cp "$ARCHIVE_PATH" "$TMP_ARCHIVE"
elif [ -n "$RENAMED_ARCHIVE" ] && [ -f "$RENAMED_ARCHIVE" ]; then
    echo "Using Android-renamed archive: $RENAMED_ARCHIVE"
    cp "$RENAMED_ARCHIVE" "$TMP_ARCHIVE"
elif [ -n "$ARCHIVE_URL" ]; then
    echo "Downloads archive is unavailable; using APK localhost fallback: $ARCHIVE_URL"
    curl --fail --location --connect-timeout 10 --retry 3 --retry-delay 1 "$ARCHIVE_URL" -o "$TMP_ARCHIVE"
else
    echo "❌ The bundled archive is not accessible from Downloads and no fallback URL was provided."
    exit 23
fi

if [ ! -s "$TMP_ARCHIVE" ]; then
    echo "❌ Archive copy/download produced an empty file."
    exit 24
fi
if ! tar -tzf "$TMP_ARCHIVE" >/dev/null; then
    echo "❌ Bundled archive is not a valid gzip tarball."
    exit 25
fi

echo "📦 Step 5/5: Installing Vibe Tavern inside Ubuntu..."
rm -rf "$NEXT_DIR"
mkdir -p "$NEXT_DIR"
tar -xzf "$TMP_ARCHIVE" -C "$NEXT_DIR"
if [ ! -s "$NEXT_DIR/version.txt" ]; then
    echo "❌ Bundled archive does not contain a payload version marker."
    exit 26
fi
INCOMING_VERSION="$(tr -d '\r\n' < "$NEXT_DIR/version.txt")"
if [ -z "$INCOMING_VERSION" ]; then
    echo "❌ Bundled archive contains an empty payload version marker."
    exit 27
fi
if [ ! -s "$NEXT_DIR/vibe-tavern" ]; then
    echo "❌ Bundled archive does not contain the Vibe Tavern server."
    exit 28
fi
# Windows-hosted archive builds cannot preserve POSIX executable bits reliably.
chmod 755 "$NEXT_DIR/vibe-tavern"
if [ ! -x "$NEXT_DIR/vibe-tavern" ]; then
    echo "❌ Could not mark the Vibe Tavern server as executable."
    exit 29
fi
echo "Installing Vibe Tavern server payload v$INCOMING_VERSION"

mkdir -p "$DATA_DIR"

# Stop only the exact compiled server process before swapping program files.
pkill -TERM -x 'vibe-tavern' 2>/dev/null || true
sleep 1
pkill -KILL -x 'vibe-tavern' 2>/dev/null || true

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

echo "✅ Vibe Tavern server payload installed from the bundled APK archive."
echo "🚀 Starting server in this Termux session..."
proot-distro login "$DISTRO" -- bash -lc 'exec "$HOME/start-vibe-tavern.sh"'
