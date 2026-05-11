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
        className="w-[320px] rounded-lg border border-border bg-surface p-5 shadow-xl"
        style={{ width: 360, padding: 28, textAlign: "center" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--t1)", marginBottom: 8 }}>
          {t("unsaved_changes_title")}
        </div>
        <div style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.55, marginBottom: 24 }}>
          {t("close_without_saving_body")}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            className="h-8 cursor-pointer rounded-md border-0 bg-transparent font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            style={{ padding: "0 14px", border: "1px solid var(--border)" }}
            onClick={input.onCancel}
          >
            {t("keep_editing")}
          </button>
          <button
            className="h-8 cursor-pointer rounded-md border-0 font-ui text-[12.5px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            style={{ padding: "0 18px", background: "oklch(0.38 0.14 25)" }}
            onClick={input.onConfirm}
          >
            {t("close_without_saving")}
          </button>
        </div>
      </div>
    </div>
  );
}
