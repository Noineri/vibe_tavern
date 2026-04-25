interface ConfirmCloseModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmCloseModal(input: ConfirmCloseModalProps) {
  return (
    <div className="api-overlay" style={{ zIndex: 700 }} onClick={input.onCancel}>
      <div
        className="api-modal"
        style={{ width: 360, padding: 28, textAlign: "center" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--t1)", marginBottom: 8 }}>
          Unsaved changes
        </div>
        <div style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.55, marginBottom: 24 }}>
          Closing now will discard your changes.
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            className="api-cancel-btn"
            style={{ border: "1px solid var(--border)" }}
            onClick={input.onCancel}
          >
            Keep editing
          </button>
          <button
            className="api-save-btn"
            style={{ background: "oklch(0.38 0.14 25)", color: "#fff" }}
            onClick={input.onConfirm}
          >
            Close without saving
          </button>
        </div>
      </div>
    </div>
  );
}
