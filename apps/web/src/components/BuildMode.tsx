import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ConnectionSettingsForm, type ConnectionSettingsFormProps } from "./ConnectionSettingsForm.js";

export interface BuildCharacterDraft {
  name: string;
  description: string;
  scenario: string;
}

export type BuildTab = "character" | "lorebook" | "persona" | "trace" | "settings";

interface BuildModeProps {
  activeTab: BuildTab;
  characterId: string;
  characterName: string;
  description: string;
  scenario: string;
  personaName: string;
  personaDescription: string;
  promptTraceCount: number;
  providerLabel: string;
  connectionStatus: string;
  isSaving: boolean;
  saveNotice: string;
  importSurface: ReactNode;
  connectionSettings: ConnectionSettingsFormProps;
  onTabChange: (tab: BuildTab) => void;
  onSave: (draft: BuildCharacterDraft) => void;
}

export function BuildMode(input: BuildModeProps) {
  const [draft, setDraft] = useState<BuildCharacterDraft>({
    name: input.characterName,
    description: input.description,
    scenario: input.scenario,
  });

  useEffect(() => {
    setDraft({
      name: input.characterName,
      description: input.description,
      scenario: input.scenario,
    });
  }, [input.characterId, input.characterName, input.description, input.scenario]);

  const isDirty = useMemo(
    () =>
      draft.name !== input.characterName ||
      draft.description !== input.description ||
      draft.scenario !== input.scenario,
    [draft, input.characterName, input.description, input.scenario],
  );

  function patchDraft<K extends keyof BuildCharacterDraft>(key: K, value: BuildCharacterDraft[K]): void {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function resetDraft(): void {
    setDraft({
      name: input.characterName,
      description: input.description,
      scenario: input.scenario,
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
            <input value={input.personaName} readOnly />
          </label>
          <label className="build-field">
            <span>Description</span>
            <textarea value={input.personaDescription} readOnly />
          </label>
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
      return (
        <div className="build-content">
          <div className="build-title">Generation Settings</div>
          <div className="build-copy">
            Provider settings now live here instead of the right chat panel.
          </div>
          <ConnectionSettingsForm {...input.connectionSettings} />
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
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="pill-btn active"
            disabled={input.isSaving || !draft.name.trim() || !isDirty}
            onClick={() => input.onSave({
              name: draft.name.trim(),
              description: draft.description,
              scenario: draft.scenario,
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
