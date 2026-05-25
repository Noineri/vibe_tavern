import { useT } from "../../i18n/context.js";
import { Modal } from "./Modal.js";

interface ConfirmCloseModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmCloseModal(input: ConfirmCloseModalProps) {
  const { t } = useT();
  return (
    <Modal open={true} onClose={input.onCancel} overlayClassName="z-[700]">
      <div
        className="w-[400px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl"
      >
        <div className="mb-2 text-base font-medium text-t1">
          {t("unsaved_changes_title")}
        </div>
        <div className="mb-6 text-[13px] leading-[1.55] text-t3">
          {t("close_without_saving_body")}
        </div>
        <div className="flex justify-center gap-3">
          <button
            className="h-[38px] cursor-pointer rounded-md border-0 bg-accent px-6 font-ui text-[13px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            onClick={input.onCancel}
          >
            {t("keep_editing")}
          </button>
          <button
            className="h-[38px] cursor-pointer rounded-md border border-border bg-transparent px-5 font-ui text-[13px] text-t3 transition-colors duration-150 hover:border-danger hover:text-danger"
            onClick={input.onConfirm}
          >
            {t("close_without_saving")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
