import { useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { MasterDetailFooter } from "../../../shared/MasterDetailModal.js";
import { SaveButton } from "../../../shared/SaveBar.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { Icons } from "../../../shared/icons.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** Image-gen-tab footer (IMAGE_GENERATION_PLAN IG-11) — the SttFooter fork:
 *  MasterDetailFooter with Save/Cancel on the right and Delete (+ confirm
 *  modal) on the left. No settings block rides the footer row — image-gen
 *  has no dictation/narration twin (its actions live in the editor's
 *  connection card), so the footer stays the bare save/delete pattern. */
export function ImageGenFooter({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editingExisting = imageGen.form?.id != null;

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
            {/* Cancel is ALWAYS available while a form is open (the STT/TTS
             *  footer rule: gating on `dirty` left the editor no exit). */}
            {imageGen.form !== null && (
              <button
                type="button"
                data-testid="image-gen-cancel-btn"
                className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1"
                onClick={imageGen.cancelEdit}
              >
                {t("cancel_btn")}
              </button>
            )}
            <SaveButton
              dirty={imageGen.dirty}
              saveState={imageGen.saving ? "saving" : "idle"}
              resetKey={imageGen.form?.id ?? null}
              onClick={() => void imageGen.save()}
              // MUI W7: the mobile footer row has no room for the text
              // button — icon mode (the STT footer precedent).
              icon={isMobile ? <Icons.Floppy /> : undefined}
            />
          </div>
        }
      />
      {confirmDelete && imageGen.form && (
        <DestructiveConfirmModal
          title={t("image_gen_profile_delete_confirm_title")}
          body={t("image_gen_profile_delete_confirm_body", { name: imageGen.form.name })}
          confirmLabel={t("delete_btn")}
          onConfirm={() => {
            setConfirmDelete(false);
            void imageGen.remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
