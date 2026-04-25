import { Icons } from "./shared/icons.js";
import { EmptyState } from "./shared/empty-state.js";

interface PromptManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PromptManagerModal(input: PromptManagerModalProps) {
  if (!input.isOpen) return null;

  return (
    <div className="api-overlay" onClick={input.onClose}>
      <div
        className="api-modal"
        style={{ width: 760, height: 580, display: "flex", flexDirection: "column" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="api-head" style={{ paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div className="api-title">Prompt Manager</div>
              <div className="api-sub">System, post-history, and summary/tools instructions per preset.</div>
            </div>
            <button
              className="icon-btn"
              aria-label="Close prompt manager"
              title="Close prompt manager"
              onClick={input.onClose}
            >
              <Icons.Close />
            </button>
          </div>
        </div>

        <div className="api-body" style={{ padding: 0, display: "flex", flex: 1, overflow: "hidden" }}>
          <div className="pm-layout" style={{ margin: 0, width: "100%" }}>
            <div className="pm-nav" style={{ width: 180, minWidth: 180 }}>
              <div className="sb-lbl" style={{ padding: "4px 14px 8px" }}>Presets</div>
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px" }}>
                <EmptyState
                  icon={<Icons.Terminal />}
                  title="No presets"
                  sub="Backend persistence is not yet wired. Presets will appear here once the prompt-preset endpoints land."
                />
              </div>
              <div
                className="pm-add-btn"
                style={{ opacity: 0.45, cursor: "not-allowed" }}
                title="Backend pending — D3 follow-up"
              >
                + New preset
              </div>
            </div>

            <div className="pm-main" style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="pm-preset-name">Preset name</label>
                  <input id="pm-preset-name" type="text" disabled value="" placeholder="No preset selected" />
                </div>
                <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="pm-bind-model">Bind to model</label>
                  <select id="pm-bind-model" disabled style={{ height: 34 }}>
                    <option value="">Default (Global)</option>
                  </select>
                </div>
              </div>

              <div
                className="pm-tabs"
                style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 16, gap: 16 }}
              >
                <div
                  className="pm-tab act"
                  style={{ fontSize: 12, fontWeight: 500, color: "var(--accent-t)", padding: "8px 4px", cursor: "default", borderBottom: "2px solid var(--accent)" }}
                >
                  System Prompt
                </div>
                <div
                  className="pm-tab"
                  style={{ fontSize: 12, fontWeight: 500, color: "var(--t3)", padding: "8px 4px", cursor: "default", borderBottom: "2px solid transparent" }}
                  title="Backend pending — D3 follow-up"
                >
                  Post-History (Jailbreak)
                </div>
                <div
                  className="pm-tab"
                  style={{ fontSize: 12, fontWeight: 500, color: "var(--t3)", padding: "8px 4px", cursor: "default", borderBottom: "2px solid transparent" }}
                  title="Backend pending — D3 follow-up"
                >
                  Summary & Tools
                </div>
              </div>

              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <textarea
                  disabled
                  value=""
                  placeholder="Backend pending — D3 follow-up will wire prompt-preset endpoints."
                  style={{
                    flex: 1,
                    width: "100%",
                    background: "var(--s2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                    fontFamily: "monospace",
                    fontSize: 12,
                    color: "var(--t3)",
                    resize: "none",
                    outline: "none",
                    opacity: 0.7,
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="api-foot">
          <span
            className="act-btn"
            style={{ color: "var(--t3)", padding: "6px 12px", opacity: 0.45, cursor: "not-allowed" }}
            title="Backend pending — D3 follow-up"
          >
            Duplicate preset
          </span>
          <button
            className="api-save-btn"
            disabled
            title="Backend pending — D3 follow-up"
            style={{ marginLeft: "auto" }}
          >
            Save
          </button>
          <button className="api-cancel-btn" onClick={input.onClose} style={{ marginLeft: 8 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
