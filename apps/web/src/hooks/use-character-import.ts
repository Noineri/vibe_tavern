import { useCallback, useState } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { uploadCharacterAvatar } from "../app-client.js";
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

      const isPng = file.type === "image/png" || lowerName.endsWith(".png");

      if (isPng) {
        // Extract character JSON from PNG metadata. The PNG is uploaded as
        // the character's folder-resident avatar AFTER the character is
        // created (POST /api/characters/:id/avatar) — see post-import block.
        const metadata = await extractPngMetadata(file);
        payload = parseCharacterMetadata(metadata);
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

      // Upload the PNG as the character's folder-resident avatar
      // (POST /api/characters/:id/avatar → {id}/avatar.{ext}). This replaces
      // the legacy two-step uploadAsset + PATCH. The folder route returns only
      // the stored extensions (not a full character/snapshot), so we splice
      // them into the import's snapshot.character BEFORE returning — the
      // caller (handleImportFiles) writes this snapshot into the active
      // snapshot store via writeSnapshot, which is what the top bar, chat, and
      // character editor read for the avatar. Without this splice those slots
      // render the fallback initial until the next full snapshot fetch.
      // skipSnapshotSync on the bootstrap refresh stays — the import's snapshot
      // is authoritative for the active chat (see importCharacterAction's
      // race rationale); the sidebar picks up the avatar via allCharacters.
      const characterId = result?.snapshot?.character?.id;
      if (characterId && isPng) {
        try {
          const { avatarExt, avatarFullExt } = await uploadCharacterAvatar(characterId, file);
          if (result.snapshot?.character) {
            result.snapshot = {
              ...result.snapshot,
              character: { ...result.snapshot.character, avatarExt, avatarFullExt },
            };
          }
          await fetchBootstrapAction({ silent: true, skipSnapshotSync: true });
        } catch (err) {
          console.warn("Failed to upload character avatar during import:", err);
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
