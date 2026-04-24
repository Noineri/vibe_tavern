import type { ProviderProfileRecord } from "../app-client.js";
import type { ConnectionState } from "./app-shell-types.js";
import { Icons } from "./shared/icons.js";

interface ProviderModalProps {
  isOpen: boolean;
  connection: ConnectionState;
  connectionHint: string;
  connectionStatus: string;
  providerProfiles: ProviderProfileRecord[];
  selectedProviderProfileId: string;
  activeProviderProfileId: string | null;
  canConnect: boolean;
  canRefreshModels: boolean;
  onClose: () => void;
  onSelectedProviderProfileChange: (providerProfileId: string) => void;
  onLoadProviderProfile: () => void;
  onConnectSavedProfile: () => void;
  onActivateProviderProfile: (providerProfileId: string) => void;
  onDeleteProviderProfile: () => void;
  onPatchConnection: (patch: Partial<ConnectionState>) => void;
  onConnect: () => void;
  onRefreshModels: () => void;
  onSaveProviderProfile: () => void;
}

export function ProviderModal(input: ProviderModalProps) {
  if (!input.isOpen) {
    return null;
  }

  return (
    <div className="api-overlay" onClick={input.onClose}>
      <div
        className="api-modal"
        style={{ width: 860, maxHeight: "90vh", display: "flex", flexDirection: "column" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="api-head" style={{ paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div className="api-title">Provider Settings</div>
              <div className="api-sub">Saved profiles, model list, and active Claw Tavern connection.</div>
            </div>
            <button
              className="icon-btn"
              aria-label="Close provider settings"
              title="Close provider settings"
              onClick={input.onClose}
            >
              <Icons.Close />
            </button>
          </div>
        </div>

        <div className="api-body" style={{ padding: 0, display: "flex", flex: 1, overflow: "hidden" }}>
          <div className="pm-layout" style={{ margin: 0, width: "100%" }}>
            <div className="pm-nav" style={{ width: 220, minWidth: 220 }}>
              <div className="sb-lbl" style={{ padding: "4px 14px 8px" }}>Saved profiles</div>
              {input.providerProfiles.length === 0 && (
                <div className="api-hint" style={{ padding: "8px 14px" }}>No saved profiles yet.</div>
              )}
              {input.providerProfiles.map((profile) => {
                const isSelected = input.selectedProviderProfileId === profile.id;
                const isActive = input.activeProviderProfileId === profile.id;
                return (
                  <div
                    key={profile.id}
                    className={`pm-preset${isSelected ? " act" : ""}`}
                    onClick={() => input.onSelectedProviderProfileChange(profile.id)}
                    style={{ whiteSpace: "normal", padding: "10px 14px", cursor: "pointer" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        className={`provider-dot${isActive ? " ok" : " none"}`}
                        style={{
                          width: 8,
                          height: 8,
                          flexShrink: 0,
                          borderRadius: "50%",
                          background: isActive ? "var(--accent)" : "var(--t4)",
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          className="long-name-cell"
                          title={profile.name}
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {profile.isActive ? "★ " : ""}{profile.name}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: isSelected ? "var(--accent)" : "var(--t3)",
                            marginTop: 3,
                          }}
                        >
                          {profile.type}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="pm-main">
              {input.providerProfiles.length > 0 && !input.activeProviderProfileId && (
                <div className="api-hint" style={{ marginBottom: 12, color: "var(--accent)" }}>
                  No active profile selected. Pick one from the list and click "Set as active".
                </div>
              )}

              <div className="api-hint" style={{ marginBottom: 12 }}>Status: {input.connectionStatus}</div>

              <div className="api-row" style={{ marginBottom: 16 }}>
                <button className="api-test-btn idle" type="button" onClick={input.onLoadProviderProfile}>
                  Load
                </button>
                <button className="api-test-btn idle" type="button" onClick={input.onConnectSavedProfile}>
                  Connect saved
                </button>
                <button
                  className="api-test-btn idle"
                  type="button"
                  disabled={
                    !input.selectedProviderProfileId ||
                    input.selectedProviderProfileId === input.activeProviderProfileId
                  }
                  onClick={() => input.onActivateProviderProfile(input.selectedProviderProfileId)}
                >
                  Set as active
                </button>
                <button className="api-test-btn err" type="button" onClick={input.onDeleteProviderProfile}>
                  Delete
                </button>
              </div>

              <div className="api-field">
                <label htmlFor="provider-modal-name">Profile name</label>
                <input
                  id="provider-modal-name"
                  value={input.connection.providerLabel}
                  onChange={(event) => input.onPatchConnection({ providerLabel: event.target.value })}
                />
              </div>

              <div className="api-field">
                <label htmlFor="provider-modal-url">Base URL</label>
                <input
                  id="provider-modal-url"
                  value={input.connection.baseUrl}
                  onChange={(event) => input.onPatchConnection({ baseUrl: event.target.value })}
                />
              </div>

              <div className="api-field">
                <label htmlFor="provider-modal-key">API key</label>
                <input
                  id="provider-modal-key"
                  type="password"
                  value={input.connection.apiKey}
                  placeholder={input.connection.hasStoredApiKey ? "Stored on backend" : "Paste API key"}
                  onChange={(event) => input.onPatchConnection({ apiKey: event.target.value })}
                />
              </div>

              <div className="api-row" style={{ marginBottom: 16 }}>
                <div className="api-field">
                  <label htmlFor="provider-modal-model">Model</label>
                  <select
                    id="provider-modal-model"
                    value={input.connection.model}
                    onChange={(event) => input.onPatchConnection({ model: event.target.value })}
                  >
                    <option value="">Select a model</option>
                    {input.connection.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="api-test-btn idle"
                  type="button"
                  disabled={!input.canRefreshModels}
                  onClick={input.onRefreshModels}
                >
                  Refresh models
                </button>
              </div>

              <div className="api-hint" style={{ marginBottom: 16 }}>
                {input.connectionHint}
              </div>
            </div>
          </div>
        </div>

        <div className="api-foot">
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <button className="api-cancel-btn" type="button" onClick={input.onSaveProviderProfile}>
              Save profile
            </button>
            <button
              className="api-save-btn"
              type="button"
              disabled={!input.canConnect}
              onClick={input.onConnect}
            >
              Save and connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
