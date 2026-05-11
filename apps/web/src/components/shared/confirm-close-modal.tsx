import { useT } from "../../i18n/context.js";

interface ConfirmCloseModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmCloseModal(input: ConfirmCloseModalProps) {
  const { t } = useT();
  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/50" onClick={input.onCancel}>
      <div
        className="w-[360px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 text-base font-medium text-t1">
          {t("unsaved_changes_title")}
        </div>
        <div className="mb-6 text-[13px] leading-[1.55] text-t3">
          {t("close_without_saving_body")}
        </div>
        <div className="flex justify-center gap-2.5">
          <button
            className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            onClick={input.onCancel}
          >
            {t("keep_editing")}
          </button>
          <button
            className="h-8 cursor-pointer rounded-md border-0 bg-[oklch(0.38_0.14_25)] px-[18px] font-ui text-[12.5px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            onClick={input.onConfirm}
          >
            {t("close_without_saving")}
          </button>
        </div>
      </div>
    </div>
  );
}
