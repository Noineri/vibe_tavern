#!/usr/bin/env bash
set -euo pipefail

# Resolve the script directory (extracted archive root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Constants
REPO_OWNER="Noineri"
REPO_NAME="vibe_tavern"
REPO_API_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
REPO_HTML_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest"
ARCHIVE_NAME_PATTERN="Vibe-Tavern"
BINARY="${SCRIPT_DIR}/vibe-tavern"

# Check for updates (non-blocking, graceful)
echo "Checking for updates..."
if LATEST_JSON=$(curl -sSf --connect-timeout 5 "$REPO_API_URL" 2>/dev/null); then
    # parse tag_name from JSON using grep/sed (NO bun/node dependency — this runs on bare Linux)
    LATEST_TAG=$(echo "$LATEST_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    LATEST_VERSION="${LATEST_TAG#v}"
    LOCAL_VERSION=""

    # Try to get local version from the binary's startup output
    if [ -x "$BINARY" ]; then
        LOCAL_VERSION=$("$BINARY" --version 2>/dev/null || true)

        # Also try parsing from the binary's first line of output
        if [ -z "$LOCAL_VERSION" ]; then
            # Fallback: read version from a VERSION file next to the binary if it exists
            if [ -f "${SCRIPT_DIR}/VERSION" ]; then
                LOCAL_VERSION=$(cat "${SCRIPT_DIR}/VERSION")
            fi
        fi
    fi

    if [ -n "$LOCAL_VERSION" ] && [ "$LOCAL_VERSION" != "$LATEST_VERSION" ]; then
        echo ""
        echo "--------------------------------------------------"
        echo "  Update available!"
        echo "  Current: v${LOCAL_VERSION}"
        echo "  Latest:  v${LATEST_VERSION}"
        echo "  Release: ${REPO_HTML_URL}"
        echo "--------------------------------------------------"
        read -rp "  Download and install update? [Y/n]: " choice || choice=""

        if [[ "$choice" =~ ^[Yy]$ || -z "$choice" ]]; then
            # Self-update: download, extract to .next, swap, restart
            ARCHIVE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}/Vibe-Tavern-${LATEST_VERSION}-linux.tar.gz"
            TMP_ARCHIVE=$(mktemp /tmp/vibe-tavern-update.XXXXXX.tar.gz)
            NEXT_DIR="${SCRIPT_DIR}.next"
            OLD_DIR="${SCRIPT_DIR}.old"

            echo "  Downloading..."
            curl -fL --progress-bar "$ARCHIVE_URL" -o "$TMP_ARCHIVE"

            echo "  Extracting..."
            rm -rf "$NEXT_DIR"
            mkdir -p "$NEXT_DIR"
            tar -xzf "$TMP_ARCHIVE" -C "$NEXT_DIR"
            chmod +x "${NEXT_DIR}/vibe-tavern"
            [ -f "${NEXT_DIR}/Vibe_Tavern.sh" ] && chmod +x "${NEXT_DIR}/Vibe_Tavern.sh"

            echo "  Updating..."
            rm -rf "$OLD_DIR"
            if [ -d "${SCRIPT_DIR}" ]; then
                mv "${SCRIPT_DIR}" "$OLD_DIR"
            fi
            mv "$NEXT_DIR" "${SCRIPT_DIR}"
            rm -rf "$OLD_DIR" "$TMP_ARCHIVE"

            echo "  Update complete!"
            echo ""
            # Re-exec the new wrapper from the same location
            exec "${SCRIPT_DIR}/Vibe_Tavern.sh" "$@"
        else
            echo "  Skipping update."
        fi
    else
        echo "Up to date."
    fi
else
    echo "Could not check for updates (offline or API unavailable)."
fi
echo ""

# Execute the binary
exec "$BINARY" "$@"