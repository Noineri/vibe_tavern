import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderProfileRecord } from "../app-client.js";
import type { ConnectionState } from "./app-shell-types.js";

export interface ConnectionSettingsFormProps {
  connection: ConnectionState;
  connectionHint: string;
  connectionStatus: string;
  providerProfiles: ProviderProfileRecord[];
  selectedProviderProfileId: string;
  canConnect: boolean;
  canRefreshModels: boolean;
  onSelectedProviderProfileChange: (providerProfileId: string) => void;
  onLoadProviderProfile: () => void;
  onConnectSavedProfile: () => void;
  onDeleteProviderProfile: () => void;
  onPatchConnection: (patch: Partial<ConnectionState>) => void;
  onConnect: () => void;
  onRefreshModels: () => void;
  onSaveProviderProfile: () => void;
}

export function ConnectionSettingsForm(input: ConnectionSettingsFormProps) {
  const [modelFilter, setModelFilter] = useState("");

  useEffect(() => {
    if (!input.connection.model) {
      setModelFilter("");
      return;
    }

    const selectedModel = input.connection.models.find((model) => model.id === input.connection.model);
    setModelFilter(selectedModel?.label ?? input.connection.model);
  }, [input.connection.model, input.connection.models]);

  const filteredModels = useMemo(() => {
    const needle = modelFilter.trim().toLowerCase();
    if (!needle) {
      return input.connection.models.slice(0, 80);
    }

    return input.connection.models
      .filter((model) =>
        `${model.id} ${model.label}`.toLowerCase().includes(needle),
      )
      .slice(0, 80);
  }, [modelFilter, input.connection.models]);

  return (
    <>
      <div className="connection-hint">{input.connectionHint}</div>
      <label className="field-label">
        <span>Saved profiles</span>
        <select
          className="field-input"
          value={input.selectedProviderProfileId}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            input.onSelectedProviderProfileChange(event.target.value)
          }
        >
          <option value="">
            {input.providerProfiles.length > 0 ? "Select saved profile" : "No saved profiles"}
          </option>
          {input.providerProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <div className="connection-row">
        <button
          className="pill-btn"
          disabled={!input.selectedProviderProfileId}
          onClick={input.onLoadProviderProfile}
        >
          Load
        </button>
        <button
          className="pill-btn"
          disabled={!input.selectedProviderProfileId}
          onClick={input.onConnectSavedProfile}
        >
          Connect saved
        </button>
        <button
          className="pill-btn"
          disabled={!input.selectedProviderProfileId}
          onClick={input.onDeleteProviderProfile}
        >
          Delete
        </button>
      </div>
      <label className="field-label">
        <span>Provider</span>
        <input
          className="field-input"
          value={input.connection.providerLabel}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            input.onPatchConnection({
              providerLabel: event.target.value,
            })}
          placeholder="NanoGPT"
        />
      </label>
      <label className="field-label">
        <span>Base URL</span>
        <input
          className="field-input"
          value={input.connection.baseUrl}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            input.onPatchConnection({
              baseUrl: event.target.value,
              activeProviderProfileId: null,
              error: "",
              status: "idle",
            })}
          placeholder="https://nano-gpt.com/api/v1"
        />
      </label>
      <label className="field-label">
        <span>API Key</span>
        <input
          className="field-input"
          value={input.connection.apiKey}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            input.onPatchConnection({
              apiKey: event.target.value,
              activeProviderProfileId: null,
              error: "",
              status: "idle",
            })}
          placeholder={
            input.connection.hasStoredApiKey && !input.connection.apiKey.trim()
              ? "Stored locally. Enter a new key only to replace it."
              : "sk-..."
          }
          type="password"
        />
      </label>
      <div className="connection-row">
        <button className="pill-btn" disabled={!input.canConnect} onClick={input.onConnect}>
          Connect
        </button>
        <button className="pill-btn" disabled={!input.canRefreshModels} onClick={input.onRefreshModels}>
          Refresh models
        </button>
        <button
          className="pill-btn"
          disabled={!input.connection.providerLabel.trim() || !input.connection.baseUrl.trim()}
          onClick={input.onSaveProviderProfile}
        >
          Save profile
        </button>
      </div>
      <div className="connection-status">Status: {input.connectionStatus}</div>
      <label className="field-label">
        <span>Model</span>
        <input
          className="field-input"
          disabled={input.connection.models.length === 0}
          value={modelFilter}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setModelFilter(event.target.value)}
          placeholder={
            input.connection.models.length > 0 ? "Search model" : "No models loaded"
          }
        />
      </label>
      {input.connection.models.length > 0 && (
        <div className="model-picker">
          <div className="model-picker-meta">
            {input.connection.model
              ? `Selected: ${input.connection.model}`
              : `${input.connection.models.length} models loaded`}
          </div>
          <div className="model-picker-list">
            {filteredModels.length > 0 ? (
              filteredModels.map((model) => (
                <button
                  key={model.id}
                  className={`model-option${model.id === input.connection.model ? " active" : ""}`}
                  onClick={() => {
                    input.onPatchConnection({
                      model: model.id,
                      error: "",
                    });
                    setModelFilter(model.label);
                  }}
                  title={model.label}
                >
                  <span className="model-option-name">{model.id}</span>
                  {model.label !== model.id && (
                    <span className="model-option-meta">{model.label}</span>
                  )}
                </button>
              ))
            ) : (
              <div className="model-picker-empty">No models match the current filter.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
