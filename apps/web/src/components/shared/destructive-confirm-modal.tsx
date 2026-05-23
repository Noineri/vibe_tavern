import type { ReactNode } from "react";
import { useT } from "../../i18n/context.js";
import { useCharacterStore } from "../../stores/character-store.js";
import { Modal } from "./Modal.js";

interface DestructiveConfirmModalProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Generic destructive confirm — accepts explicit props for local use. */
export function DestructiveConfirmModal(input: DestructiveConfirmModalProps) {
  const { t } = useT();
  return (
    <Modal open={true} onClose={input.onCancel} overlayClassName="z-[700]">
      <div
        className="w-[380px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl"
      >
        <div className="mb-2 text-base font-medium text-t1">
          {input.title}
        </div>
        <div className="mb-6 text-[13px] leading-[1.55] text-t3">
          {input.body}
        </div>
        <div className="flex justify-center gap-2.5">
          <button
            className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            onClick={input.onCancel}
          >
            {t("cancel")}
          </button>
          <button
            className="h-8 cursor-pointer rounded-md border-0 bg-[oklch(0.4_0.15_25)] px-[18px] font-ui text-[12.5px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            onClick={input.onConfirm}
          >
            {input.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Self-contained version that reads confirmDestroy from character store. */
export function ShellDestructiveConfirmModal() {
  const { t } = useT();
  const confirmDestroy = useCharacterStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  if (!confirmDestroy) return null;

  return (
    <Modal open={true} onClose={() => setConfirmDestroy(null)} overlayClassName="z-[700]">
      <div
        className="w-[380px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl"
      >
        <div className="mb-2 text-base font-medium text-t1">
          {confirmDestroy.title}
        </div>
        <div className="mb-6 text-[13px] leading-[1.55] text-t3">
          {confirmDestroy.body}
        </div>
        <div className="flex justify-center gap-2.5">
          <button
            className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            onClick={() => setConfirmDestroy(null)}
          >
            {t("cancel")}
          </button>
          <button
            className="h-8 cursor-pointer rounded-md border-0 bg-[oklch(0.4_0.15_25)] px-[18px] font-ui text-[12.5px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            onClick={() => {
              confirmDestroy!.onConfirm();
              setConfirmDestroy(null);
            }}
          >
            {confirmDestroy.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
