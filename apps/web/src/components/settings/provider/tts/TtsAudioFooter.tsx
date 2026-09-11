/**
 * Audio-tab footer for ProviderModal (TTS profiles) — MasterDetailFooter with
 * Save/Cancel on the right and the Delete action on the left, plus the delete
 * confirm modal. Extracted per the master-detail house pattern (regex/service
 * tabs precedent): the detail editor owns NO inline save/delete; the stable
 * footer does. Lives as its own unit so the controls↔hook wiring is testable
 * without mounting the whole ProviderModal.
 */

import { useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { MasterDetailFooter } from "../../../shared/MasterDetailModal.js";
import { SaveButton } from "../../../shared/SaveBar.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { Icons } from "../../../shared/icons.js";
import { TtsNarrationModeBlock } from "./TtsNarrationModeBlock.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

export function TtsAudioFooter({ tts }: { tts: TtsHook }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editingExisting = tts.form?.id != null;

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
        /* MUI W7 (owner 2026-09-11, design variant A): on phones the footer
         * is two definite rows — row 1 = Delete icon + Cancel + icon-mode
         * Save (the shared footer's atomic right line), row 2 = this
         * settings block on a full-width row via `mobileBottomRow`. Desktop
         * keeps the settings INLINE in the right slot (the pre-W7 DOM). */
        mobileBottomRow={isMobile ? <TtsNarrationModeBlock /> : undefined}
        right={
          <div className="flex items-center gap-2">
            {/* Narration text-mode selector lives HERE in the footer row —
             * the same slot pattern as the LLM footer's default-proxy control
             * (owner 2026-08-31). Desktop only; the mobile copy renders in
             * `mobileBottomRow` above. */}
            {!isMobile && <TtsNarrationModeBlock />}
            {/* Cancel is ALWAYS available while a form is open (owner
             * 2026-08-29): gating it on `dirty` left the editor with no
             * exit — Save disabled by the same flag, the card could not be
             * collapsed without making a change. */}
            {tts.form !== null && (
              <button
                type="button"
                data-testid="tts-cancel-btn"
                className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1"
                onClick={tts.cancelEdit}
              >
                {t("cancel_btn")}
              </button>
            )}
            <SaveButton
              dirty={tts.dirty}
              saveState={tts.saving ? "saving" : "idle"}
              resetKey={tts.form?.id ?? null}
              onClick={() => void tts.save()}
              // MUI W7: the mobile footer row has no room for the 124px text
              // button — icon mode (36px square, the documented mobile-toolbar
              // usage; live precedent ExperienceEditor) keeps desktop's full
              // label untouched.
              icon={isMobile ? <Icons.Floppy /> : undefined}
            />
          </div>
        }
      />
      {confirmDelete && tts.form && (
        <DestructiveConfirmModal
          title={t("tts_profile_delete_confirm_title")}
          body={t("tts_profile_delete_confirm_body", { name: tts.form.name })}
          confirmLabel={t("delete_btn")}
          onConfirm={() => {
            setConfirmDelete(false);
            void tts.remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
