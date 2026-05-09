import type { ReactNode } from "react";

interface DestructiveConfirmModalProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DestructiveConfirmModal(input: DestructiveConfirmModalProps) {
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
            className="api-cancel-btn"
            style={{ border: "1px solid var(--border)" }}
            onClick={input.onCancel}
          >
            Cancel
          </button>
          <button
            className="api-save-btn"
            style={{ background: "oklch(0.4 0.15 25)", color: "#fff" }}
            onClick={input.onConfirm}
          >
            {input.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
