#!/usr/bin/env bash

set -euo pipefail

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
    LATEST_TAG=$(echo "$LATEST_JSON" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    LATEST_VERSION="${LATEST_TAG#v}"

    if [[ ! -f "package.json" ]]; then
        echo "Error: package.json not found in the current directory." >&2
        exit 1
    fi

    LOCAL_VERSION=$(grep '"version"' package.json | sed -E 's/.*: *"([^"]+)".*/\1/' | head -n 1)

    if [[ "$LOCAL_VERSION" != "$LATEST_VERSION" ]]; then
        echo "--------------------------------------------------"
        echo "🚀 Update available!"
        echo "Current version: $LOCAL_VERSION"
        echo "Latest version:  $LATEST_VERSION"
        echo "Release notes:   $REPO_HTML_URL"
        echo "--------------------------------------------------"
        
        read -rp "Do you want to download and install this new release? (Y/N): " choice
        
        if [[ "$choice" =~ ^[Yy]$ ]]; then
            ZIP_NAME="vibe_tavern-${LATEST_VERSION}.zip"
            DOWNLOAD_URL="https://github.com/Noineri/vibe_tavern/releases/download/${LATEST_TAG}/${ZIP_NAME}"
            
            echo "Downloading $ZIP_NAME..."
            curl -sL "$DOWNLOAD_URL" -o "$ZIP_NAME"
            
            if [[ -d "data" ]]; then
                BACKUP_DIR="data_backup_${LOCAL_VERSION}"
                echo "Backing up existing data directory to ./${BACKUP_DIR}/..."
                
                if [[ -d "$BACKUP_DIR" ]]; then
                    rm -rf "$BACKUP_DIR"
                fi
                mv data "$BACKUP_DIR"
            fi

            echo "Extracting update..."
            unzip -qo "$ZIP_NAME"
            
            rm "$ZIP_NAME"
            
            echo "Update installed successfully."
        else
            echo "Skipping update. Starting current version..."
        fi
    else
        echo "Project is up to date (v$LOCAL_VERSION)."
    fi
fi

echo "Installing dependencies..."
bun install --frozen-lockfile --production

echo "Starting server..."
exec bun out/services/api/prod-server.js
