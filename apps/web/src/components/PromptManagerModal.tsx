import { useEffect, useState } from "react";
import type { PromptPresetDto } from "@rp-platform/domain";
import { ConfirmCloseModal } from "./shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { EmptyState } from "./shared/empty-state.js";
import { Icons } from "./shared/icons.js";
import { SaveBtn } from "./shared/save-btn.js";
import { useDirtyState } from "./shared/use-dirty-state.js";

interface PromptManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  presets: PromptPresetDto[];
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
  onCreate: (input: { name: string; bindModel?: string; system?: string; jailbreak?: string; summary?: string; tools?: string }) => Promise<{ id: string } | null>;
  onUpdate: (presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>) => Promise<boolean>;
  onDelete: (presetId: string) => Promise<boolean>;
  availableModels?: Array<{ id: string; name: string }>;
}

export function PromptManagerModal(input: PromptManagerModalProps) {
  const [activeTab, setActiveTab] = useState<"system" | "jailbreak" | "tools">("system");
  const [draft, setDraft] = useState({ name: "", bindModel: "", system: "", jailbreak: "", summary: "", tools: "" });
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const dirtyState = useDirtyState();
  const activePreset = input.presets.find((p) => p.id === input.activePresetId) ?? null;

  useEffect(() => {
    if (activePreset) {
      setDraft({
        name: activePreset.name,
        bindModel: activePreset.bindModel,
        system: activePreset.system,
        jailbreak: activePreset.jailbreak,
        summary: activePreset.summary,
        tools: activePreset.tools,
      });
      dirtyState.reset();
    } else {
      setDraft({ name: "", bindModel: "", system: "", jailbreak: "", summary: "", tools: "" });
      dirtyState.reset();
    }
  }, [activePreset?.id]);

  function updateDraft<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    dirtyState.markDirty();
  }

  if (!input.isOpen) return null;

  const handleClose = () => {
    if (dirtyState.dirty) {
      setConfirmCloseOpen(true);
    } else {
      input.onClose();
    }
  };

  const handleSave = () => {
    if (!input.activePresetId) return;
    dirtyState.triggerSave(() => {
      void input.onUpdate(input.activePresetId!, draft);
    });
  };

  const handleDuplicate = () => {
    void input.onCreate({ ...draft, name: `${draft.name} (copy)` });
  };

  const handleAdd = () => {
    void input.onCreate({ name: "New preset" });
  };

  const handleConfirmDelete = () => {
    if (!input.activePresetId) return;
    void input.onDelete(input.activePresetId);
    setConfirmDeleteOpen(false);
  };

  const textareaStyle: React.CSSProperties = {
    flex: 1,
    width: "100%",
    background: "var(--s2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 12,
    color: "var(--t1)",
    resize: "none",
    outline: "none",
  };

  return (
    <div className="api-overlay" onClick={handleClose}>
      {confirmCloseOpen && (
        <ConfirmCloseModal
          onCancel={() => setConfirmCloseOpen(false)}
          onConfirm={() => { dirtyState.reset(); setConfirmCloseOpen(false); input.onClose(); }}
        />
      )}
      {confirmDeleteOpen && (
        <DestructiveConfirmModal
          title="Delete preset"
          body={<>Are you sure? The preset <b>{activePreset?.name || "Unnamed"}</b> will be permanently deleted.</>}
          confirmLabel="Delete preset"
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
      <div
        className="api-modal"
        style={{ width: 760, height: 580, display: "flex", flexDirection: "column" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="api-head" style={{ paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div className="api-title" style={{ display: "flex", alignItems: "center" }}>
                Prompt Manager
                {dirtyState.dirty && <span className="dirty-dot" title="Unsaved changes" />}
              </div>
              <div className="api-sub">System, post-history, and summary/tools instructions per preset.</div>
            </div>
            <button
              className="iBtn"
              aria-label="Close prompt manager"
              title="Close prompt manager"
              onClick={handleClose}
            >
              <Icons.Close />
            </button>
          </div>
        </div>

        <div className="api-body" style={{ padding: 0, display: "flex", flex: 1, overflow: "hidden" }}>
          <div className="pm-layout" style={{ margin: 0, width: "100%" }}>
            <div className="pm-nav" style={{ width: 180, minWidth: 180 }}>
              <div className="sb-lbl" style={{ padding: "4px 14px 8px" }}>Presets</div>
              {input.presets.length === 0 ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px" }}>
                  <EmptyState
                    icon={<Icons.Terminal />}
                    title="No presets"
                    sub="Create a preset to start configuring prompts."
                  />
                </div>
              ) : (
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {input.presets.map((p) => (
                    <div
                      key={p.id}
                      className={`pm-preset ${input.activePresetId === p.id ? "act" : ""}`}
                      onClick={() => input.setActivePresetId(p.id)}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "6px 14px", cursor: "pointer" }}
                    >
                      <span className="long-name-cell" title={p.name}>{p.name}</span>
                      <span style={{ fontSize: 9, color: p.bindModel ? "var(--t3)" : "var(--accent-t)", textTransform: "uppercase", flexShrink: 0, letterSpacing: ".04em" }}>
                        {p.bindModel ? `→ ${p.bindModel}` : "Global"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div
                className="pm-add-btn"
                role="button"
                tabIndex={0}
                onClick={handleAdd}
              >
                + New preset
              </div>
            </div>

            <div className="pm-main" style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="pm-preset-name">Preset name</label>
                  <input
                    id="pm-preset-name"
                    type="text"
                    value={draft.name}
                    onChange={(e) => updateDraft("name", e.target.value)}
                    placeholder={activePreset ? "Preset name" : "No preset selected"}
                    disabled={!activePreset}
                  />
                </div>
                <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="pm-bind-model">Bind to model</label>
                  <select
                    id="pm-bind-model"
                    value={draft.bindModel}
                    onChange={(e) => updateDraft("bindModel", e.target.value)}
                    disabled={!activePreset}
                    style={{ height: 34 }}
                  >
                    <option value="">Default (Global)</option>
                    {input.availableModels?.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div
                className="pm-tabs"
                style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 16, gap: 16 }}
              >
                <div
                  className={`pm-tab ${activeTab === "system" ? "act" : ""}`}
                  style={{ fontSize: 12, fontWeight: 500, color: activeTab === "system" ? "var(--accent-t)" : "var(--t3)", padding: "8px 4px", cursor: "pointer", borderBottom: activeTab === "system" ? "2px solid var(--accent)" : "2px solid transparent" }}
                  onClick={() => setActiveTab("system")}
                >
                  System Prompt
                </div>
                <div
                  className={`pm-tab ${activeTab === "jailbreak" ? "act" : ""}`}
                  style={{ fontSize: 12, fontWeight: 500, color: activeTab === "jailbreak" ? "var(--accent-t)" : "var(--t3)", padding: "8px 4px", cursor: "pointer", borderBottom: activeTab === "jailbreak" ? "2px solid var(--accent)" : "2px solid transparent" }}
                  onClick={() => setActiveTab("jailbreak")}
                >
                  Post-History (Jailbreak)
                </div>
                <div
                  className={`pm-tab ${activeTab === "tools" ? "act" : ""}`}
                  style={{ fontSize: 12, fontWeight: 500, color: activeTab === "tools" ? "var(--accent-t)" : "var(--t3)", padding: "8px 4px", cursor: "pointer", borderBottom: activeTab === "tools" ? "2px solid var(--accent)" : "2px solid transparent" }}
                  onClick={() => setActiveTab("tools")}
                >
                  Summary &amp; Tools
                </div>
              </div>

              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                {activeTab === "system" && (
                  <textarea
                    value={draft.system}
                    onChange={(e) => updateDraft("system", e.target.value)}
                    placeholder="System prompt instructions..."
                    disabled={!activePreset}
                    style={textareaStyle}
                  />
                )}
                {activeTab === "jailbreak" && (
                  <textarea
                    value={draft.jailbreak}
                    onChange={(e) => updateDraft("jailbreak", e.target.value)}
                    placeholder="[Post-history instructions...]"
                    disabled={!activePreset}
                    style={textareaStyle}
                  />
                )}
                {activeTab === "tools" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <label style={{ display: "block", fontSize: "10.5px", fontWeight: 500, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--t3)", marginBottom: "6px" }}>Summary</label>
                      <textarea
                        value={draft.summary}
                        onChange={(e) => updateDraft("summary", e.target.value)}
                        disabled={!activePreset}
                        style={textareaStyle}
                      />
                    </div>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <label style={{ display: "block", fontSize: "10.5px", fontWeight: 500, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--t3)", marginBottom: "6px" }}>Tools</label>
                      <textarea
                        value={draft.tools}
                        onChange={(e) => updateDraft("tools", e.target.value)}
                        disabled={!activePreset}
                        style={textareaStyle}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="api-foot">
          <span
            className="act-btn"
            role="button"
            tabIndex={0}
            style={{ color: "var(--t3)", padding: "6px 12px", opacity: activePreset ? 1 : 0.45, cursor: activePreset ? "pointer" : "not-allowed" }}
            onClick={activePreset ? handleDuplicate : undefined}
          >
            Duplicate preset
          </span>
          {activePreset && input.presets.length > 0 && (
            <span
              className="act-btn"
              role="button"
              tabIndex={0}
              style={{ color: "var(--t3)", padding: "6px 12px" }}
              onClick={() => setConfirmDeleteOpen(true)}
            >
              <Icons.Trash /> Delete preset
            </span>
          )}
          <SaveBtn
            dirty={dirtyState.dirty}
            saveState={dirtyState.saveState}
            onClick={handleSave}
            disabled={!activePreset || !dirtyState.dirty}
            style={{ marginLeft: "auto" }}
          />
          <button className="api-cancel-btn" onClick={handleClose} style={{ marginLeft: 8 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
