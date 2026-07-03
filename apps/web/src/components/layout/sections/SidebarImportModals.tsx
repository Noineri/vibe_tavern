/**
 * SidebarImportModals — the character/chat import modals rendered at the
 * sidebar root, guarded by the `importModal` discriminator state. Shared by
 * the RP `Sidebar` and `CoauthorSidebar` (E1, post-SF-4 dedup). Identical
 * behavior in both — the import flow is mode-agnostic.
 */
import { CharacterImportModal, ChatImportModal } from "../../modals/ImportModals.js";
import type { ChatId } from "@vibe-tavern/domain";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ImportModalKind } from "./section-types.js";

export function SidebarImportModals({
  importModal,
  setImportModal,
  character,
  activeChatId,
}: {
  importModal: ImportModalKind;
  setImportModal: (v: ImportModalKind) => void;
  character: CharacterControllerActions;
  activeChatId: ChatId | null;
}) {
  if (importModal === "character") {
    return (
      <CharacterImportModal
        isImporting={character.isImporting}
        onClose={() => setImportModal(null)}
        onImportFiles={(files) => void character.handleImportFiles(files)}
      />
    );
  }
  if (importModal === "chat") {
    return (
      <ChatImportModal
        activeChatId={activeChatId}
        isImporting={character.isImporting}
        onClose={() => setImportModal(null)}
        onImportFiles={(files) => void character.handleImportFiles(files)}
      />
    );
  }
  return null;
}
