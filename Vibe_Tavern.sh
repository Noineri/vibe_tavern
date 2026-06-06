#!/usr/bin/env bash

set -euo pipefail

cleanup() {
    rm -f "${ZIP_NAME:-}" 2>/dev/null
    rm -rf "${TEMP_DIR:-}" 2>/dev/null
}
trap cleanup EXIT

REPO_API_URL="https://api.github.com/repos/Noineri/vibe_tavern/releases/latest"
REPO_HTML_URL="https://github.com/Noineri/vibe_tavern/releases/latest"

echo "Checking for Bun installation..."
if ! command -v bun &> /dev/null; then
    echo "Error: 'bun' is not installed or not in your PATH." >&2
    echo "Please install Bun by following the instructions at: https://bun.sh/docs/installation" >&2
    exit 1
fi
echo "Bun found."

SKIP_UPDATE=false
LATEST_JSON=""

echo "Checking for updates..."
if ! LATEST_JSON=$(curl -sSf --connect-timeout 5 "$REPO_API_URL" 2>/dev/null); then
    echo "⚠️ Warning: Could not reach GitHub API. Skipping update check."
    SKIP_UPDATE=true
fi

if [[ "$SKIP_UPDATE" == "false" ]]; then
    LATEST_TAG=$(echo "$LATEST_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text());console.log(d.tag_name)")
    LATEST_VERSION="${LATEST_TAG#v}"

    if [[ ! -f "package.json" ]]; then
        echo "Error: package.json not found in the current directory." >&2
        exit 1
    fi

    LOCAL_VERSION=$(bun -e "console.log(require('./package.json').version)")

    if [[ "$LOCAL_VERSION" != "$LATEST_VERSION" ]]; then
        echo "--------------------------------------------------"
        echo "🚀 Update available!"
        echo "Current version: $LOCAL_VERSION"
        echo "Latest version:  $LATEST_VERSION"
        echo "Release notes:   $REPO_HTML_URL"
        echo "--------------------------------------------------"
        
        read -rp "Do you want to download and install this new release? (Y/N): " choice || choice=""
        
        if [[ "$choice" =~ ^[Yy]$ ]]; then
            ZIP_NAME="vibe_tavern-${LATEST_VERSION}.zip"
            DOWNLOAD_URL="https://github.com/Noineri/vibe_tavern/releases/download/${LATEST_TAG}/${ZIP_NAME}"
            
            echo "Downloading $ZIP_NAME..."
            curl -sL "$DOWNLOAD_URL" -o "$ZIP_NAME"
            
            if [[ ! -f "$ZIP_NAME" ]] || [[ ! -s "$ZIP_NAME" ]]; then
                echo "Error: Download failed or file is empty." >&2
                rm -f "$ZIP_NAME" 2>/dev/null
                exit 1
            fi
            
            if [[ -d "data" ]]; then
                BACKUP_DIR="data_backup_${LOCAL_VERSION}"
                echo "Backing up existing data directory to ./${BACKUP_DIR}/..."
                
                if [[ -d "$BACKUP_DIR" ]]; then
                    rm -rf "$BACKUP_DIR"
                fi
                mv data "$BACKUP_DIR"
            fi

            echo "Extracting update..."
            TEMP_DIR=$(mktemp -d)
            if ! unzip -qo "$ZIP_NAME" -d "$TEMP_DIR"; then
                echo "Error: Extraction failed." >&2
                rm -rf "$TEMP_DIR"
                rm -f "$ZIP_NAME"
                # Rollback: restore backup if it exists
                if [[ -d "${BACKUP_DIR:-}" ]]; then
                    echo "Restoring backup..."
                    rm -rf data 2>/dev/null
                    mv "$BACKUP_DIR" data
                    echo "Backup restored."
                fi
                exit 1
            fi
            cp -rf "$TEMP_DIR"/vibe_tavern/* .
            rm -rf "$TEMP_DIR"
            
            rm "$ZIP_NAME"
            
            echo "Update installed successfully."
        else
            echo "Skipping update. Starting current version..."
        fi
    else
        echo "Project is up to date (v$LOCAL_VERSION)."
    fi
fi

INSTALL_HASH=".install-hash"
SKIP_INSTALL=false

if [[ -d "node_modules" ]] && [[ -f "$INSTALL_HASH" ]]; then
    CURRENT_HASH=$(md5sum bun.lock | cut -d' ' -f1)
    SAVED_HASH=$(cat "$INSTALL_HASH")
    if [[ "$CURRENT_HASH" == "$SAVED_HASH" ]]; then
        echo "Dependencies up to date. Skipping install."
        SKIP_INSTALL=true
    fi
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "Installing dependencies..."
    bun install --frozen-lockfile
    md5sum bun.lock | cut -d' ' -f1 > "$INSTALL_HASH"
fi

echo "Building..."
bun scripts/install-platform-optionals.ts
bun scripts/build.ts prod

echo "Starting server..."
exec bun out/services/api/prod-server.js
