/**
 * STT-tab footer for ProviderModal — MasterDetailFooter with Save/Cancel on
 * the right and the Delete action on the left, plus the delete confirm modal.
 * Fork of TtsAudioFooter: the dictation controls live HERE in the footer row
 * (P6, audit 2026-09-04) — the same slot pattern as the TTS footer's
 * narration-mode block and the LLM footer's default-proxy control. Lives as
 * its own unit so the controls↔hook wiring is testable without mounting the
 * whole ProviderModal.
 */

import { useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { MasterDetailFooter } from "../../../shared/MasterDetailModal.js";
import { SaveButton } from "../../../shared/SaveBar.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { Icons } from "../../../shared/icons.js";
import { SttDictationBlock } from "./SttDictationBlock.js";
import type { useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

export function SttFooter({ stt }: { stt: SttHook }) {
  const { t } = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editingExisting = stt.form?.id != null;

  return (
    <>
      <MasterDetailFooter
        actions={
          editingExisting
            ? [
                {
                  icon: <Icons.Trash />,
                  label: t("delete"),
                  onClick: () => setConfirmDelete(true),
                },
              ]
            : []
        }
        right={
          <div className="flex items-center gap-2">
            {/* Dictation controls live HERE in the footer row — the same
             * slot pattern as the TTS footer's narration-mode block (owner
             * reference) and the LLM footer's default-proxy control. */}
            <SttDictationBlock profiles={stt.profiles} />
            {/* Cancel is ALWAYS available while a form is open (owner
             * 2026-08-29 decision, ported from the TTS footer): gating it on
             * `dirty` left the editor with no exit — Save disabled by the
             * same flag, the card could not be collapsed without a change. */}
            {stt.form !== null && (
              <button
                type="button"
                data-testid="stt-cancel-btn"
                className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1"
                onClick={stt.cancelEdit}
              >
                {t("cancel_btn")}
              </button>
            )}
            <SaveButton
              dirty={stt.dirty}
              saveState={stt.saving ? "saving" : "idle"}
              resetKey={stt.form?.id ?? null}
              onClick={() => void stt.save()}
            />
          </div>
        }
      />
      {confirmDelete && stt.form && (
        <DestructiveConfirmModal
          title={t("stt_profile_delete_confirm_title")}
          body={t("stt_profile_delete_confirm_body", { name: stt.form.name })}
          confirmLabel={t("delete_btn")}
          onConfirm={() => {
            setConfirmDelete(false);
            void stt.remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}