import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

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

export type BuildTab = "character" | "lorebook" | "persona" | "trace";

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
  isSaving: boolean;
  saveNotice: string;
  importSurface: ReactNode;
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
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function patchPersonaDraft<K extends keyof BuildPersonaDraft>(key: K, value: BuildPersonaDraft[K]): void {
    setPersonaDraft((current) => ({ ...current, [key]: value }));
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

  function renderCharacter(): ReactNode {
    return (
      <div className="build-placeholder">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div className="build-section-title">{draft.name || "Unnamed"}</div>
          <button
            className="api-save-btn"
            style={{ height: 28, padding: "0 12px" }}
            disabled={input.isSaving || !draft.name.trim() || !isDirty}
            onClick={() =>
              input.onSave({
                name: draft.name.trim(),
                description: draft.description,
                scenario: draft.scenario,
                systemPrompt: draft.systemPrompt,
              })
            }
          >
            {input.isSaving ? "Saving..." : "Save"}
          </button>
        </div>
        <div className="build-section-sub">Character card - edit inline</div>
        {input.importSurface}
        <div className="build-field">
          <label>Name</label>
          <input
            type="text"
            value={draft.name}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLInputElement>) => patchDraft("name", event.target.value)}
          />
        </div>
        <div className="build-field">
          <label>Description</label>
          <textarea
            value={draft.description}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("description", event.target.value)}
          />
        </div>
        <div className="build-field">
          <label>Scenario</label>
          <textarea
            value={draft.scenario}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("scenario", event.target.value)}
          />
        </div>
        <div className="build-field">
          <label>System Prompt</label>
          <textarea
            value={draft.systemPrompt}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("systemPrompt", event.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <button className="api-cancel-btn" disabled={input.isSaving || !isDirty} onClick={resetDraft}>
            Reset
          </button>
          <span className="build-section-sub" style={{ margin: 0 }}>
            {input.saveNotice || (isDirty ? "Unsaved changes" : "Saved state")}
          </span>
        </div>
      </div>
    );
  }

  function renderPersona(): ReactNode {
    return (
      <div className="build-placeholder">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div className="build-section-title">{personaDraft.name || "Your persona"}</div>
          <button
            className="api-save-btn"
            style={{ height: 28, padding: "0 12px" }}
            disabled={input.isSaving || !input.personaId || !personaDraft.name.trim() || !isPersonaDirty}
            onClick={() =>
              input.onSavePersona({
                name: personaDraft.name.trim(),
                description: personaDraft.description,
              })
            }
          >
            {input.isSaving ? "Saving..." : "Save"}
          </button>
        </div>
        <div className="build-section-sub">Your persona - how you appear in chat.</div>
        <div className="build-field">
          <label>Name</label>
          <input
            type="text"
            value={personaDraft.name}
            disabled={input.isSaving || !input.personaId}
            onChange={(event: ChangeEvent<HTMLInputElement>) => patchPersonaDraft("name", event.target.value)}
          />
        </div>
        <div className="build-field">
          <label>Description</label>
          <textarea
            value={personaDraft.description}
            disabled={input.isSaving || !input.personaId}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              patchPersonaDraft("description", event.target.value)
            }
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <button
            className="api-cancel-btn"
            disabled={input.isSaving || !input.personaId || !isPersonaDirty}
            onClick={resetPersonaDraft}
          >
            Reset
          </button>
          <span className="build-section-sub" style={{ margin: 0 }}>
            {!input.personaId
              ? "No persona attached to this chat."
              : isPersonaDirty
              ? "Unsaved changes"
              : "Saved state"}
          </span>
        </div>
      </div>
    );
  }

  function renderLorebook(): ReactNode {
    return (
      <div className="build-placeholder">
        <div className="build-section-title">Lorebook</div>
        <div className="build-section-sub">
          Import a SillyTavern lorebook JSON and attach it to the active character.
        </div>
        {input.importSurface}
        <div
          style={{
            marginTop: 20,
            height: 120,
            background: "var(--s2)",
            borderRadius: 8,
            border: "1px dashed var(--border2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--t3)",
            fontSize: 13,
            fontFamily: "var(--font-body)",
            fontStyle: "italic",
          }}
        >
          Full entry editor coming in a later phase.
        </div>
      </div>
    );
  }

  function renderTrace(): ReactNode {
    return (
      <div className="build-placeholder">
        <div className="build-section-title">Prompt Trace</div>
        <div className="build-section-sub">
          Prompt trace is captured per generation. Recorded traces for this chat: {input.promptTraceCount}.
        </div>
        <div
          style={{
            marginTop: 20,
            height: 120,
            background: "var(--s2)",
            borderRadius: 8,
            border: "1px dashed var(--border2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--t3)",
            fontSize: 13,
            fontFamily: "var(--font-body)",
            fontStyle: "italic",
          }}
        >
          Layered prompt viewer coming in a later phase.
        </div>
      </div>
    );
  }

  function renderTabContent(): ReactNode {
    switch (input.activeTab) {
      case "lorebook":
        return renderLorebook();
      case "persona":
        return renderPersona();
      case "trace":
        return renderTrace();
      case "character":
      default:
        return renderCharacter();
    }
  }

  return (
    <div className="build-wrap">
      <div className="build-nav">
        <div className="build-nav-title">Editor</div>
        <button
          className={input.activeTab === "character" ? "build-nav-item" + " act" : "build-nav-item"}
          onClick={() => input.onTabChange("character")}
        >
          Character Card
        </button>
        <button
          className={input.activeTab === "lorebook" ? "build-nav-item" + " act" : "build-nav-item"}
          onClick={() => input.onTabChange("lorebook")}
        >
          Lorebook
        </button>
        <button
          className={input.activeTab === "persona" ? "build-nav-item" + " act" : "build-nav-item"}
          onClick={() => input.onTabChange("persona")}
        >
          Persona
        </button>
        <button
          className={input.activeTab === "trace" ? "build-nav-item" + " act" : "build-nav-item"}
          onClick={() => input.onTabChange("trace")}
        >
          Prompt Trace
        </button>
      </div>
      <div className="build-content">{renderTabContent()}</div>
    </div>
  );
}
