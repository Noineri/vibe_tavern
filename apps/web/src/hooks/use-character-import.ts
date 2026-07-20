import { useCallback, useState } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { uploadCharacterAvatar } from "../app-client.js";
import { extractPngMetadata, parseCharacterMetadata, extractVtmdMonolith } from "../lib/png-reader.js";
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
      const lowerName = file.name.toLowerCase();
      const isPng = file.type === "image/png" || lowerName.endsWith(".png");

      // Build the import payload. A VTF `vtmd` chunk (PNG) or a standalone
      // `.md`/`.vtmd` monolith is the LOSSLESS native representation and is
      // passed as `monolithText` (the backend prefers it over the lossy
      // `chara`/`ccv3` JSON). ST cards / JSONL stay on `jsonText`.
      let jsonText: string | undefined;
      let monolithText: string | undefined;

      if (isPng) {
        // Extract character JSON from PNG metadata. The PNG is uploaded as
        // the character's folder-resident avatar AFTER the character is
        // created (POST /api/characters/:id/avatar) — see post-import block.
        const metadata = await extractPngMetadata(file);
        const vtmd = extractVtmdMonolith(metadata);
        if (vtmd) monolithText = vtmd;
        // The ST chara/ccv3 JSON is the fallback when no vtmd is present, and
        // an extra safety net when it is (the backend prefers the monolith).
        // An external tool that writes only a vtmd chunk has no JSON to parse
        // — skip it rather than throwing.
        try {
          const card = parseCharacterMetadata(metadata);
          jsonText = typeof card === "string" ? card : JSON.stringify(card);
        } catch {
          if (!monolithText) throw new Error(getT()("import_unsupported_type"));
        }
      } else if (lowerName.endsWith(".jsonl")) {
        jsonText = await file.text();
      } else if (file.type === "application/json" || lowerName.endsWith(".json")) {
        jsonText = JSON.stringify(JSON.parse(await file.text()));
      } else if (
        lowerName.endsWith(".md") ||
        lowerName.endsWith(".markdown") ||
        lowerName.endsWith(".vtmd")
      ) {
        // Standalone VTF monolith: YAML frontmatter + markdown sections — the
        // lossless native representation, distinct from the AI-Assistant
        // `.md`/`.txt` prose→formalization modal (different entry point).
        monolithText = await file.text();
      } else {
        throw new Error(getT()("import_unsupported_type"));
      }

      const result = await importCharacterAction({
        fileName: file.name,
        jsonText,
        monolithText,
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
      //
      // The PNG card is passed as BOTH crop and full: ST cards are uncropped
      // by definition (ST does not crop on import), so the same bytes serve
      // both the display avatar ({id}/avatar.png) and the uncropped source
      // ({id}/avatar-full.png, paired with avatarFullExt). This wires the
      // imported card into the existing crop-confirm flow: the user can later
      // re-crop the original art from avatar-full.png without needing the
      // original PNG file. Mirrors the backend scanner's avatar write.
      const characterId = result?.snapshot?.character?.id;
      if (characterId && isPng) {
        try {
          const { avatarExt, avatarFullExt } = await uploadCharacterAvatar(characterId, file, file);
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
