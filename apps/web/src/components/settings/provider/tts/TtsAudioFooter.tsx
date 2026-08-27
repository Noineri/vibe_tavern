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
import { MasterDetailFooter } from "../../../shared/MasterDetailModal.js";
import { SaveButton } from "../../../shared/SaveBar.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { Icons } from "../../../shared/icons.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

export function TtsAudioFooter({ tts }: { tts: TtsHook }) {
  const { t } = useT();
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
        right={
          <div className="flex items-center gap-2">
            {tts.dirty && (
              <button
                type="button"
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
