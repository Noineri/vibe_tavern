import type { ProviderProfileRecord } from "../app-client.js";
import { TYPE_LABELS } from "../provider-presets.js";
import type { FormState } from "./ProviderModal.js";
import { Icons } from "./shared/icons.js";

interface ProviderProfileListSectionProps {
  filteredProfiles: ProviderProfileRecord[];
  editingId: string | null;
  activeProviderProfileId: string | null;
  profileSearch: string;
  onProfileSearchChange: (value: string) => void;
  onSelectProfile: (id: string) => void;
  onAddProfile: () => void;
}

export function ProviderProfileListSection({
  filteredProfiles,
  editingId,
  activeProviderProfileId,
  profileSearch,
  onProfileSearchChange,
  onSelectProfile,
  onAddProfile,
}: ProviderProfileListSectionProps) {
  return (
            <div className="pm-nav" style={{ width: 220, minWidth: 220 }}>
              <div className="sb-lbl" style={{ padding: "4px 14px 8px" }}>
                Profiles
              </div>
              <div className="sb-search" style={{ margin: "0 10px 6px" }} title="Search profiles">
                <Icons.Search />
                <input
                  placeholder="Search profiles..."
                  value={profileSearch}
                  onChange={(e) => onProfileSearchChange(e.target.value)}
                />
              </div>
              {filteredProfiles.map((p) => {
                const isSelected = editingId === p.id;
                const isActive = activeProviderProfileId === p.id;
                const dotClass = isActive
                  ? p.hasStoredApiKey
                    ? "ok"
                    : "err"
                  : "none";
                return (
                  <div
                    key={p.id}
                    className={`pm-preset${isSelected ? " act" : ""}`}
                    onClick={() => onSelectProfile(p.id)}
                    style={{
                      whiteSpace: "normal",
                      padding: "10px 14px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        className={`provider-dot ${dotClass}`}
                        style={{
                          width: 8,
                          height: 8,
                          flexShrink: 0,
                          borderRadius: "50%",
                          background:
                            dotClass === "ok"
                              ? "oklch(0.68 0.16 145)"
                              : dotClass === "err"
                                ? "oklch(0.62 0.2 25)"
                                : "var(--t4)",
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          className="long-name-cell"
                          title={p.name}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isActive ? "★ " : ""}
                          {p.name}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: isSelected ? "var(--accent)" : "var(--t3)",
                            marginTop: 3,
                          }}
                        >
                          {TYPE_LABELS[p.type] || p.type}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="pm-add-btn" onClick={() => void onAddProfile()}>
                + New profile
              </div>
            </div>
  );
}

interface ProviderSamplerFieldsProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}

export function ProviderSamplerFields({ form, updateForm }: ProviderSamplerFieldsProps) {
  return (
    <>
                  <div className="api-section-title">Samplers (Advanced)</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Temperature ({form.temperature})</label>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.05"
                        value={form.temperature}
                        onChange={(e) => updateForm("temperature", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Max Context</label>
                      <input
                        type="number"
                        min="1024"
                        max="2000000"
                        step="1024"
                        value={form.maxTokens || ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateForm("maxTokens", v === "" ? 0 : parseInt(v) || 0);
                        }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Top P ({form.topP})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={form.topP}
                        onChange={(e) => updateForm("topP", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Min P ({form.minP})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={form.minP}
                        onChange={(e) => updateForm("minP", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Top K</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={form.topK}
                        onChange={(e) => updateForm("topK", parseInt(e.target.value) || 40)}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Typical P ({form.typicalP})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={form.typicalP}
                        onChange={(e) => updateForm("typicalP", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Rep. Penalty ({form.repPen})</label>
                      <input
                        type="range"
                        min="1"
                        max="2"
                        step="0.05"
                        value={form.repPen}
                        onChange={(e) => updateForm("repPen", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Frequency Penalty ({form.freqPen})</label>
                      <input
                        type="range"
                        min="-2"
                        max="2"
                        step="0.1"
                        value={form.freqPen}
                        onChange={(e) => updateForm("freqPen", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Presence Penalty ({form.presPen})</label>
                      <input
                        type="range"
                        min="-2"
                        max="2"
                        step="0.1"
                        value={form.presPen}
                        onChange={(e) => updateForm("presPen", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
                    <div className="api-field" style={{ flex: 1 }}>
                      <label>Stop Sequences (comma-separated)</label>
                      <input
                        type="text"
                        value={form.stopSeq}
                        onChange={(e) => updateForm("stopSeq", e.target.value)}
                        placeholder="User:, \nUser"
                      />
                    </div>
                    <div className="api-field" style={{ width: 120 }}>
                      <label>Seed</label>
                      <input
                        type="number"
                        value={form.seed ?? ""}
                        onChange={(e) =>
                          updateForm(
                            "seed",
                            e.target.value === "" ? null : e.target.value,
                          )
                        }
                        placeholder="Random"
                      />
                    </div>
                    <div className="api-field" style={{ width: 160 }}>
                      <label>Reasoning Effort</label>
                      <select
                        value={form.reasoningEffort}
                        onChange={(e) => updateForm("reasoningEffort", e.target.value)}
                        style={{ height: 34 }}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
    </>
  );
}

interface ProviderActionFooterProps {
  providerProfiles: ProviderProfileRecord[];
  saveState: "idle" | "saving" | "saved" | "error";
  onDuplicate: () => void;
  onDelete: () => void;
  onSave: () => void;
  onActivate: () => void;
}

export function ProviderActionFooter({
  providerProfiles,
  saveState,
  onDuplicate,
  onDelete,
  onSave,
  onActivate,
}: ProviderActionFooterProps) {
  return (
        <div className="api-foot">
          <span
            className="act-btn"
            style={{ color: "var(--t3)", padding: "6px 12px", cursor: "pointer" }}
            onClick={() => void onDuplicate()}
          >
            <Icons.Copy /> Duplicate provider
          </span>
          {providerProfiles.length > 1 && (
            <span
              className="act-btn"
              style={{ color: "var(--t3)", padding: "6px 12px", cursor: "pointer" }}
              onClick={onDelete}
            >
              <Icons.Trash /> Delete profile
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <button
              className={`api-save-btn ${saveState === "saved" ? "save-btn-saved" : ""} ${saveState === "saving" ? "save-btn-saving" : ""}`}
              onClick={() => onSave()}
            >
              {saveState === "saving"
                ? "Saving..."
                : saveState === "saved"
                  ? "Saved"
                  : "Save profile"}
            </button>
            <button
              className="api-save-btn"
              onClick={() => void onActivate()}
            >
              Set as active
            </button>
          </div>
        </div>
  );
}
