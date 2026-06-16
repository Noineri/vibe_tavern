import { useT } from "../../i18n/context.js";
import { Modal } from "./Modal.js";

interface ConfirmCloseModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmCloseModal(input: ConfirmCloseModalProps) {
  const { t } = useT();
  return (
    <Modal open={true} onClose={input.onCancel} overlayClassName="z-[700]" hideOverlay>
      <div
        className="w-[440px] rounded-lg border border-border bg-surface p-8 text-center shadow-xl"
      >
        <div className="mb-2 text-[18px] leading-[1.4] font-medium text-t1">
          {t("unsaved_changes_title")}
        </div>
        <div className="mb-6 text-[14px] leading-[1.5] text-t3">
          {t("close_without_saving_body")}
        </div>
        <div className="flex justify-center gap-4">
          <button type="button"
            className="h-12 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-[14px] leading-[1.2] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110"
            onClick={input.onCancel}
          >
            {t("keep_editing")}
          </button>
          <button type="button"
            className="h-12 cursor-pointer rounded-md border border-border bg-transparent px-4 font-ui text-[14px] leading-[1.2] text-t3 transition-colors duration-150 hover:border-danger hover:text-danger"
            onClick={input.onConfirm}
          >
            {t("close_without_saving")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
