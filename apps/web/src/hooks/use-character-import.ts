import { useCallback, useState } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { uploadAsset, updateCharacterAvatar } from "../app-client.js";
import { extractPngMetadata, parseCharacterMetadata } from "../lib/png-reader.js";
import { getT } from "../i18n/context.js";
import { importCharacterAction } from "../stores/api-actions/character-actions.js";

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

      // If we uploaded an avatar, attach it to the newly created character
      if (avatarAssetId && result?.activeChatId) {
        try {
          const characterId = result.snapshot?.character?.id;
          if (characterId) {
            const updatedSnapshot = await updateCharacterAvatar(characterId, result.activeChatId, avatarAssetId);
            // Replace snapshot so the caller sees the avatar
            result.snapshot = updatedSnapshot;
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
