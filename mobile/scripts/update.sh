#!/data/data/com.termux/files/usr/bin/bash
# Vibe Tavern — update program files from the prebuilt Android ARM64 archive.
# Usage: bash update.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install.sh"

if [ ! -x "$INSTALL_SCRIPT" ]; then
    echo "❌ install.sh not found next to update.sh."
    echo "   Download the latest installer and run it again."
    exit 1
fi

echo "📥 Updating Vibe Tavern archive installation..."
"$INSTALL_SCRIPT"
echo "✅ Update complete. Run start.sh or tap Start Server in the APK."
