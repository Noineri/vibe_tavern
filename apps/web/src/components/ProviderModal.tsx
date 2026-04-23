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
  canConnect: boolean;
  canRefreshModels: boolean;
  onClose: () => void;
  onSelectedProviderProfileChange: (providerProfileId: string) => void;
  onLoadProviderProfile: () => void;
  onConnectSavedProfile: () => void;
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
    <div className="provider-modal-overlay" onClick={input.onClose}>
      <div className="provider-modal" onClick={(event) => event.stopPropagation()}>
        <div className="provider-modal-head">
          <div>
            <div className="sidebar-label">Build Mode</div>
            <div className="provider-modal-title">Provider Settings</div>
            <div className="provider-modal-copy">Saved profiles, model list, and active Claw Tavern connection.</div>
          </div>
          <button className="icon-btn" aria-label="Close provider settings" title="Close provider settings" onClick={input.onClose}>
            <Icons.Close />
          </button>
        </div>
        <div className="provider-modal-body">
          <div className="api-body" style={{ padding: 0 }}>
            <div className="api-field">
              <label htmlFor="provider-modal-profile">Saved profile</label>
              <select
                id="provider-modal-profile"
                value={input.selectedProviderProfileId}
                onChange={(event) => input.onSelectedProviderProfileChange(event.target.value)}
              >
                <option value="">Select a saved profile</option>
                {input.providerProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.type}
                  </option>
                ))}
              </select>
              <div className="api-hint">Status: {input.connectionStatus}</div>
            </div>

            <div className="api-row" style={{ marginBottom: 16 }}>
              <button className="api-test-btn idle" type="button" onClick={input.onLoadProviderProfile}>
                Load
              </button>
              <button className="api-test-btn idle" type="button" onClick={input.onConnectSavedProfile}>
                Connect saved
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

            <div className="api-row">
              <button
                className="api-save-btn"
                type="button"
                disabled={!input.canConnect}
                onClick={input.onConnect}
              >
                Save and connect
              </button>
              <button className="api-cancel-btn" type="button" onClick={input.onSaveProviderProfile}>
                Save profile
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
