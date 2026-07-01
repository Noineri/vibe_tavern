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

    # Baked in at build time by build-linux-dist.ts (mirrors Vibe_Tavern.bat).
    # If the placeholder wasn't substituted (raw source copy, stale checkout),
    # fall back to the VERSION file shipped alongside the binary.
    # NEVER use "$BINARY" --version here — the binary ignores the flag and starts
    # the full server inside the command substitution, hanging the script.
    LOCAL_VERSION="__VERSION__"
    if ! [[ "$LOCAL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9] ]]; then
        if [ -f "${SCRIPT_DIR}/VERSION" ]; then
            LOCAL_VERSION="$(cat "${SCRIPT_DIR}/VERSION")"
        else
            LOCAL_VERSION=""
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
            # Self-update: download, extract to .next, replace files in-place, restart
            ARCHIVE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}/Vibe-Tavern-${LATEST_TAG}-linux.tar.gz"
            TMP_ARCHIVE=$(mktemp /tmp/vibe-tavern-update.XXXXXX.tar.gz)
            NEXT_DIR="${SCRIPT_DIR}.next"

            echo "  Downloading..."
            curl -fL --progress-bar "$ARCHIVE_URL" -o "$TMP_ARCHIVE"

            echo "  Extracting..."
            rm -rf "$NEXT_DIR"
            mkdir -p "$NEXT_DIR"
            tar -xzf "$TMP_ARCHIVE" -C "$NEXT_DIR"
            [ -f "${NEXT_DIR}/vibe-tavern" ] && chmod +x "${NEXT_DIR}/vibe-tavern"
            [ -f "${NEXT_DIR}/Vibe_Tavern.sh" ] && chmod +x "${NEXT_DIR}/Vibe_Tavern.sh"

            echo "  Updating..."
            # Replace each top-level entry in the install dir in-place rather
            # than swapping the whole directory. This keeps the install dir's
            # inode alive, so any shell (this one or the parent) with CWD set
            # inside it keeps working — no CWD-deleted errors after update.
            # mv on the script file we're currently running is safe: rename()
            # atomically swaps the directory entry to a new inode; bash keeps
            # reading the old inode (now anonymous but kept alive by its open
            # read FD) and the exec below resolves the path to the new inode.
            for entry in "$NEXT_DIR"/*; do
                [ -e "$entry" ] || continue
                name="$(basename "$entry")"
                rm -rf "${SCRIPT_DIR:?}/$name"
                mv "$entry" "${SCRIPT_DIR}/$name"
            done
            rm -rf "$NEXT_DIR" "$TMP_ARCHIVE"

            echo "  Update complete!"
            echo ""
            exec "${SCRIPT_DIR}/Vibe_Tavern.sh" "$@"
        else
            echo "  Skipping update."
        fi
    else
        echo "You're using the latest version of Vibe Tavern."
    fi
else
    echo "Could not check for updates (offline or API unavailable)."
fi
echo ""

# Execute the binary
exec "$BINARY" "$@"