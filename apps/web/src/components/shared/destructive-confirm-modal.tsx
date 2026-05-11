import type { ReactNode } from "react";
import { useT } from "../../i18n/context.js";
import { useCharacterStore } from "../../stores/character-store.js";

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
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/50" onClick={input.onCancel}>
      <div
        className="w-[320px] rounded-lg border border-border bg-surface p-5 shadow-xl"
        style={{ width: 380, padding: 28, textAlign: "center" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--t1)", marginBottom: 8 }}>
          {input.title}
        </div>
        <div style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.55, marginBottom: 24 }}>
          {input.body}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            className="h-8 cursor-pointer rounded-md border-0 bg-transparent font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            style={{ padding: "0 14px", border: "1px solid var(--border)" }}
            onClick={input.onCancel}
          >
            {t("cancel")}
          </button>
          <button
            className="h-8 cursor-pointer rounded-md border-0 font-ui text-[12.5px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            style={{ padding: "0 18px", background: "oklch(0.4 0.15 25)" }}
            onClick={input.onConfirm}
          >
            {input.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Self-contained version that reads confirmDestroy from character store. */
export function ShellDestructiveConfirmModal() {
  const { t } = useT();
  const confirmDestroy = useCharacterStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  if (!confirmDestroy) return null;

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/50" onClick={() => setConfirmDestroy(null)}>
      <div
        className="w-[320px] rounded-lg border border-border bg-surface p-5 shadow-xl"
        style={{ width: 380, padding: 28, textAlign: "center" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--t1)", marginBottom: 8 }}>
          {confirmDestroy.title}
        </div>
        <div style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.55, marginBottom: 24 }}>
          {confirmDestroy.body}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            className="h-8 cursor-pointer rounded-md border-0 bg-transparent font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            style={{ padding: "0 14px", border: "1px solid var(--border)" }}
            onClick={() => setConfirmDestroy(null)}
          >
            {t("cancel")}
          </button>
          <button
            className="h-8 cursor-pointer rounded-md border-0 font-ui text-[12.5px] font-medium text-white transition-[filter] duration-100 hover:brightness-110"
            style={{ padding: "0 18px", background: "oklch(0.4 0.15 25)" }}
            onClick={() => {
              confirmDestroy!.onConfirm();
              setConfirmDestroy(null);
            }}
          >
            {confirmDestroy.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
