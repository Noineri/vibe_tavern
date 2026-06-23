import { useCallback, useState } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { uploadAsset, updateCharacterAvatar } from "../app-client.js";
import { extractPngMetadata, parseCharacterMetadata } from "../lib/png-reader.js";
import { getT } from "../i18n/locale-helpers.js";
import { importCharacterAction } from "../stores/api-actions/character-actions.js";
import { fetchBootstrapAction } from "../stores/api-actions/bootstrap-actions.js";

export interface CharacterImportOptions {
  chatId?: ChatId;
}

export function useCharacterImport() {
  const [isImporting, setIsImporting] = useState(false);

  const importFile = useCallback(async (file: File, options?: CharacterImportOptions) => {
    setIsImporting(true);
    try {
      let payload: unknown;
      const lowerName = file.name.toLowerCase();
      let avatarAssetId: string | null = null;

      const isPng = file.type === "image/png" || lowerName.endsWith(".png");

      if (isPng) {
        // Extract character JSON from PNG metadata
        const metadata = await extractPngMetadata(file);
        payload = parseCharacterMetadata(metadata);

        // Upload the PNG itself as the character's avatar
        try {
          const asset = await uploadAsset(file);
          avatarAssetId = asset.assetId;
        } catch (err) {
          console.warn("Failed to upload character avatar during import:", err);
        }
      } else if (lowerName.endsWith(".jsonl")) {
        payload = await file.text();
      } else if (file.type === "application/json" || lowerName.endsWith(".json")) {
        const text = await file.text();
        payload = JSON.parse(text);
      } else {
        throw new Error(getT()("import_unsupported_type"));
      }

      const result = await importCharacterAction({
        fileName: file.name,
        jsonText: typeof payload === "string" ? payload : JSON.stringify(payload),
        chatId: options?.chatId,
      });

      // If we uploaded an avatar, attach it to the newly created character.
      // The PATCH returns a ConfigPatchResponse (a partial snapshot carrying
      // only `character` — no activeChat/messages/branches), so we MERGE its
      // updated character into the import's authoritative snapshot rather than
      // replacing it. Replacing used to drop activeChat, leaving the store in a
      // half-corrupted state (activeChatId from the import, activeChat stale).
      if (avatarAssetId && result?.activeChatId) {
        try {
          const characterId = result.snapshot?.character?.id;
          if (characterId) {
            const patched = await updateCharacterAvatar(characterId, result.activeChatId, avatarAssetId);
            if (patched.character && result.snapshot) {
              result.snapshot = { ...result.snapshot, character: patched.character };
            }
            // Refresh global lists (allCharacters now carries the avatar
            // asset id) without syncing the active snapshot — the import's
            // snapshot above is authoritative.
            await fetchBootstrapAction({ silent: true, skipSnapshotSync: true });
          }
        } catch (err) {
          console.warn("Failed to attach avatar to imported character:", err);
        }
      }

      return result;
    } catch (err: unknown) {
      console.error("Import error:", err);
      const message = err instanceof Error ? err.message : getT()("import_character_failed");
      throw new Error(message);
    } finally {
      setIsImporting(false);
    }
  }, []);

  return {
    importFile,
    isImporting,
  };
}
