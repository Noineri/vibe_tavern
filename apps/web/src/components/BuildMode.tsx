import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderProfileRecord } from "../app-client.js";
import type { ConnectionState } from "./app-shell-types.js";

export interface BuildCharacterDraft {
  name: string;
  description: string;
  scenario: string;
  systemPrompt: string;
}

export interface BuildPersonaDraft {
  name: string;
  description: string;
}

interface BuildConnectionSettingsProps {
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

export type BuildTab = "character" | "lorebook" | "persona" | "trace" | "settings";

interface BuildModeProps {
  activeTab: BuildTab;
  characterId: string;
  characterName: string;
  description: string;
  scenario: string;
  systemPrompt: string;
  personaId: string | null;
  personaName: string;
  personaDescription: string;
  promptTraceCount: number;
  providerLabel: string;
  connectionStatus: string;
  isSaving: boolean;
  saveNotice: string;
  importSurface: ReactNode;
  connectionSettings: BuildConnectionSettingsProps;
  onTabChange: (tab: BuildTab) => void;
  onSave: (draft: BuildCharacterDraft) => void;
  onSavePersona: (draft: BuildPersonaDraft) => void;
}

export function BuildMode(input: BuildModeProps) {
  const [draft, setDraft] = useState<BuildCharacterDraft>({
    name: input.characterName,
    description: input.description,
    scenario: input.scenario,
    systemPrompt: input.systemPrompt,
  });
  const [personaDraft, setPersonaDraft] = useState<BuildPersonaDraft>({
    name: input.personaName,
    description: input.personaDescription,
  });

  useEffect(() => {
    setDraft({
      name: input.characterName,
      description: input.description,
      scenario: input.scenario,
      systemPrompt: input.systemPrompt,
    });
  }, [input.characterId, input.characterName, input.description, input.scenario, input.systemPrompt]);

  useEffect(() => {
    setPersonaDraft({
      name: input.personaName,
      description: input.personaDescription,
    });
  }, [input.personaName, input.personaDescription, input.personaId]);

  const isDirty = useMemo(
    () =>
      draft.name !== input.characterName ||
      draft.description !== input.description ||
      draft.scenario !== input.scenario ||
      draft.systemPrompt !== input.systemPrompt,
    [draft, input.characterName, input.description, input.scenario, input.systemPrompt],
  );
  const isPersonaDirty = useMemo(
    () =>
      personaDraft.name !== input.personaName ||
      personaDraft.description !== input.personaDescription,
    [personaDraft, input.personaName, input.personaDescription],
  );

  function patchDraft<K extends keyof BuildCharacterDraft>(key: K, value: BuildCharacterDraft[K]): void {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function patchPersonaDraft<K extends keyof BuildPersonaDraft>(key: K, value: BuildPersonaDraft[K]): void {
    setPersonaDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function resetDraft(): void {
    setDraft({
      name: input.characterName,
      description: input.description,
      scenario: input.scenario,
      systemPrompt: input.systemPrompt,
    });
  }

  function resetPersonaDraft(): void {
    setPersonaDraft({
      name: input.personaName,
      description: input.personaDescription,
    });
  }

  function renderTabContent() {
    if (input.activeTab === "lorebook") {
      return (
        <div className="build-content">
          <div className="build-title">Lorebook import</div>
          <div className="build-copy">
            This tab is now live as an import surface. Drop a SillyTavern lorebook JSON here to attach
            it to the current character.
          </div>
          {input.importSurface}
        </div>
      );
    }

    if (input.activeTab === "persona") {
      return (
        <div className="build-content">
          <div className="build-title">Persona</div>
          <label className="build-field">
            <span>Name</span>
            <input
              value={personaDraft.name}
              disabled={input.isSaving || !input.personaId}
              onChange={(event: ChangeEvent<HTMLInputElement>) => patchPersonaDraft("name", event.target.value)}
            />
          </label>
          <label className="build-field">
            <span>Description</span>
            <textarea
              value={personaDraft.description}
              disabled={input.isSaving || !input.personaId}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                patchPersonaDraft("description", event.target.value)
              }
            />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="pill-btn active"
              disabled={input.isSaving || !input.personaId || !personaDraft.name.trim() || !isPersonaDirty}
              onClick={() => input.onSavePersona({
                name: personaDraft.name.trim(),
                description: personaDraft.description,
              })}
            >
              {input.isSaving ? "Saving..." : "Save"}
            </button>
            <button
              className="pill-btn"
              disabled={input.isSaving || !input.personaId || !isPersonaDirty}
              onClick={resetPersonaDraft}
            >
              Reset
            </button>
            <span className="build-copy" style={{ margin: 0 }}>
              {!input.personaId
                ? "No persona is attached to this chat."
                : isPersonaDirty
                ? "Unsaved changes"
                : "Saved state"}
            </span>
          </div>
        </div>
      );
    }

    if (input.activeTab === "trace") {
      return (
        <div className="build-content">
          <div className="build-title">Prompt Trace</div>
          <div className="build-copy">
            Trace history is already functional in Play Mode. Current recorded traces for this chat: {input.promptTraceCount}.
          </div>
        </div>
      );
    }

    if (input.activeTab === "settings") {
      const settings = input.connectionSettings;

      return (
        <div className="build-content">
          <div className="build-title">Generation Settings</div>
          <div className="build-copy">
            Provider settings now live here instead of the right chat panel.
          </div>
          <div className="api-body" style={{ padding: 0 }}>
            <div className="api-field">
              <label htmlFor="build-provider-profile">Saved profile</label>
              <select
                id="build-provider-profile"
                value={settings.selectedProviderProfileId}
                onChange={(event) => settings.onSelectedProviderProfileChange(event.target.value)}
              >
                <option value="">Select a saved profile</option>
                {settings.providerProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.type}
                  </option>
                ))}
              </select>
              <div className="api-hint">Status: {settings.connectionStatus}</div>
            </div>

            <div className="api-row" style={{ marginBottom: 16 }}>
              <button className="api-test-btn idle" type="button" onClick={settings.onLoadProviderProfile}>
                Load
              </button>
              <button className="api-test-btn idle" type="button" onClick={settings.onConnectSavedProfile}>
                Connect saved
              </button>
              <button className="api-test-btn err" type="button" onClick={settings.onDeleteProviderProfile}>
                Delete
              </button>
            </div>

            <div className="api-field">
              <label htmlFor="build-provider-name">Profile name</label>
              <input
                id="build-provider-name"
                value={settings.connection.providerLabel}
                onChange={(event) => settings.onPatchConnection({ providerLabel: event.target.value })}
              />
            </div>

            <div className="api-field">
              <label htmlFor="build-provider-url">Base URL</label>
              <input
                id="build-provider-url"
                value={settings.connection.baseUrl}
                onChange={(event) => settings.onPatchConnection({ baseUrl: event.target.value })}
              />
            </div>

            <div className="api-field">
              <label htmlFor="build-provider-key">API key</label>
              <input
                id="build-provider-key"
                type="password"
                value={settings.connection.apiKey}
                placeholder={settings.connection.hasStoredApiKey ? "Stored on backend" : "Paste API key"}
                onChange={(event) => settings.onPatchConnection({ apiKey: event.target.value })}
              />
            </div>

            <div className="api-row" style={{ marginBottom: 16 }}>
              <div className="api-field">
                <label htmlFor="build-provider-model">Model</label>
                <select
                  id="build-provider-model"
                  value={settings.connection.model}
                  onChange={(event) => settings.onPatchConnection({ model: event.target.value })}
                >
                  <option value="">Select a model</option>
                  {settings.connection.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="api-test-btn idle"
                type="button"
                disabled={!settings.canRefreshModels}
                onClick={settings.onRefreshModels}
              >
                Refresh models
              </button>
            </div>

            <div className="api-hint" style={{ marginBottom: 16 }}>
              {settings.connectionHint}
            </div>

            <div className="api-row">
              <button
                className="api-save-btn"
                type="button"
                disabled={!settings.canConnect}
                onClick={settings.onConnect}
              >
                Save and connect
              </button>
              <button className="api-cancel-btn" type="button" onClick={settings.onSaveProviderProfile}>
                Save profile
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="build-content">
        <div className="build-title">{input.characterName}</div>
        <div className="build-copy">
          Character editor is now live. You can switch tabs, edit the card fields, and save changes back
          into the local prototype runtime.
        </div>
        {input.importSurface}
        <label className="build-field">
          <span>Name</span>
          <input
            value={draft.name}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLInputElement>) => patchDraft("name", event.target.value)}
          />
        </label>
        <label className="build-field">
          <span>Description</span>
          <textarea
            value={draft.description}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              patchDraft("description", event.target.value)
            }
          />
        </label>
        <label className="build-field">
          <span>Scenario</span>
          <textarea
            value={draft.scenario}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("scenario", event.target.value)}
          />
        </label>
        <label className="build-field">
          <span>System Prompt</span>
          <textarea
            value={draft.systemPrompt}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              patchDraft("systemPrompt", event.target.value)
            }
          />
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="pill-btn active"
            disabled={input.isSaving || !draft.name.trim() || !isDirty}
            onClick={() => input.onSave({
              name: draft.name.trim(),
              description: draft.description,
              scenario: draft.scenario,
              systemPrompt: draft.systemPrompt,
            })}
          >
            {input.isSaving ? "Saving..." : "Save"}
          </button>
          <button className="pill-btn" disabled={input.isSaving || !isDirty} onClick={resetDraft}>
            Reset
          </button>
          <span className="build-copy" style={{ margin: 0 }}>
            {input.saveNotice || (isDirty ? "Unsaved changes" : "Saved state")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <section className="build-shell">
      <nav className="build-nav">
        <div className="sidebar-label">Editors</div>
        <button
          className={`build-nav-item${input.activeTab === "character" ? " active" : ""}`}
          onClick={() => input.onTabChange("character")}
        >
          Character Card
        </button>
        <button
          className={`build-nav-item${input.activeTab === "lorebook" ? " active" : ""}`}
          onClick={() => input.onTabChange("lorebook")}
        >
          Lorebook
        </button>
        <button
          className={`build-nav-item${input.activeTab === "persona" ? " active" : ""}`}
          onClick={() => input.onTabChange("persona")}
        >
          Persona
        </button>
        <button
          className={`build-nav-item${input.activeTab === "trace" ? " active" : ""}`}
          onClick={() => input.onTabChange("trace")}
        >
          Prompt Trace
        </button>
        <button
          className={`build-nav-item${input.activeTab === "settings" ? " active" : ""}`}
          onClick={() => input.onTabChange("settings")}
        >
          Generation Settings
        </button>
      </nav>
      {renderTabContent()}
    </section>
  );
}
