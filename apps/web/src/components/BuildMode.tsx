import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { PromptTraceRecordDto } from "@rp-platform/api-contracts";
import { LorebookEditor } from "./LorebookEditor.js";

export interface BuildCharacterDraft {
  name: string;
  description: string;
  firstMessage: string;
  scenario: string;
  systemPrompt: string;
  mesExample: string;
  alternateGreetings: string[];
  postHistoryInstructions: string;
  creatorNotes: string;
}

export type BuildTab = "character" | "lorebook" | "trace";

interface BuildModeProps {
  activeTab: BuildTab;
  characterId: string;
  characterName: string;
  description: string;
  firstMessage?: string | null;
  scenario: string;
  systemPrompt: string;
  mesExample: string | null;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  promptTraceCount: number;
  activeTrace: PromptTraceRecordDto | null;
  promptPayloadText: string;
  isSaving: boolean;
  saveNotice: string;
  importSurface: ReactNode;
  onTabChange: (tab: BuildTab) => void;
  onSave: (draft: BuildCharacterDraft) => void;
}

export function BuildMode(input: BuildModeProps) {
  const [draft, setDraft] = useState<BuildCharacterDraft>({
    name: input.characterName,
    description: input.description,
    firstMessage: input.firstMessage || "",
    scenario: input.scenario,
    systemPrompt: input.systemPrompt,
    mesExample: input.mesExample || "",
    alternateGreetings: input.alternateGreetings || [],
    postHistoryInstructions: input.postHistoryInstructions || "",
    creatorNotes: input.creatorNotes || "",
  });
  const [altGreetIdx, setAltGreetIdx] = useState(0);

  useEffect(() => {
    setDraft({
      name: input.characterName,
      description: input.description,
      firstMessage: input.firstMessage || "",
      scenario: input.scenario,
      systemPrompt: input.systemPrompt,
      mesExample: input.mesExample || "",
      alternateGreetings: input.alternateGreetings || [],
      postHistoryInstructions: input.postHistoryInstructions || "",
      creatorNotes: input.creatorNotes || "",
    });
  }, [input.characterId, input.characterName, input.description, input.firstMessage, input.scenario, input.systemPrompt, input.mesExample, input.alternateGreetings, input.postHistoryInstructions, input.creatorNotes]);

  const isDirty = useMemo(
    () =>
      draft.name !== input.characterName ||
      draft.description !== input.description ||
      draft.firstMessage !== (input.firstMessage || "") ||
      draft.scenario !== input.scenario ||
      draft.systemPrompt !== input.systemPrompt ||
      draft.mesExample !== (input.mesExample || "") ||
      draft.alternateGreetings.join("\n---\n") !== (input.alternateGreetings || []).join("\n---\n") ||
      draft.postHistoryInstructions !== (input.postHistoryInstructions || "") ||
      draft.creatorNotes !== (input.creatorNotes || ""),
    [draft, input.characterName, input.description, input.firstMessage, input.scenario, input.systemPrompt, input.mesExample, input.alternateGreetings, input.postHistoryInstructions, input.creatorNotes],
  );

  function patchDraft<K extends keyof BuildCharacterDraft>(key: K, value: BuildCharacterDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function resetDraft(): void {
    setDraft({
      name: input.characterName,
      description: input.description,
      firstMessage: input.firstMessage || "",
      scenario: input.scenario,
      systemPrompt: input.systemPrompt,
      mesExample: input.mesExample || "",
      alternateGreetings: input.alternateGreetings || [],
      postHistoryInstructions: input.postHistoryInstructions || "",
      creatorNotes: input.creatorNotes || "",
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
                firstMessage: draft.firstMessage,
                scenario: draft.scenario,
                systemPrompt: draft.systemPrompt,
                mesExample: draft.mesExample,
                alternateGreetings: draft.alternateGreetings,
                postHistoryInstructions: draft.postHistoryInstructions,
                creatorNotes: draft.creatorNotes,
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
          <label>First Message (Greeting)</label>
          <textarea
            value={draft.firstMessage}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("firstMessage", event.target.value)}
            placeholder="Первое сообщение персонажа..."
          />
        </div>
        <div className="build-field">
          <label>Alternate Greetings</label>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {draft.alternateGreetings.map((_, idx) => (
              <span
                key={idx}
                className={`alt-tab${idx === altGreetIdx ? " act" : ""}`}
                onClick={() => setAltGreetIdx(idx)}
              >
                Alt {idx + 1}
                <span
                  className="alt-tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = [...draft.alternateGreetings];
                    next.splice(idx, 1);
                    setDraft({ ...draft, alternateGreetings: next });
                    if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
                  }}
                >
                  ✕
                </span>
              </span>
            ))}
            <span
              className="alt-tab-add"
              onClick={() => {
                const next = [...draft.alternateGreetings, ""];
                setDraft({ ...draft, alternateGreetings: next });
                setAltGreetIdx(next.length - 1);
              }}
            >
              +
            </span>
          </div>
          {draft.alternateGreetings.length > 0 && (
            <textarea
              value={draft.alternateGreetings[altGreetIdx] ?? ""}
              disabled={input.isSaving}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                const next = [...draft.alternateGreetings];
                next[altGreetIdx] = event.target.value;
                setDraft({ ...draft, alternateGreetings: next });
              }}
              placeholder="Альтернативное приветствие..."
            />
          )}
        </div>
        <div className="build-field">
          <label>Message Examples</label>
          <textarea
            value={draft.mesExample}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("mesExample", event.target.value)}
            placeholder="<START>..."
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
        <div className="build-field">
          <label>Post-History Instructions (Jailbreak)</label>
          <textarea
            value={draft.postHistoryInstructions}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("postHistoryInstructions", event.target.value)}
          />
        </div>
        <div className="build-field">
          <label>Creator Notes</label>
          <textarea
            value={draft.creatorNotes}
            disabled={input.isSaving}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patchDraft("creatorNotes", event.target.value)}
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

  function renderLorebook(): ReactNode {
    return (
      <LorebookEditor charName={input.characterName} lorebookId={input.characterId} />
    );
  }

  function renderTrace(): ReactNode {
    return (
      <div className="build-placeholder" style={{ maxWidth: 800 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div className="build-section-title">Prompt Trace</div>
          {input.activeTrace && (
            <div className="tok-c ok" style={{ fontSize: 13, background: "var(--s2)", padding: "4px 10px", borderRadius: 20 }}>
              Total: {input.activeTrace.tokenAccounting?.total ?? input.activeTrace.layers.reduce((sum, l) => sum + l.tokenCount, 0)} tokens
            </div>
          )}
        </div>
        <div className="build-section-sub" style={{ color: "var(--t3)" }}>
          Prompt trace is captured per generation. Recorded traces for this chat: {input.promptTraceCount}.
        </div>

        {input.activeTrace ? (
          <div className="trace-container">
            {input.activeTrace.layers.map((layer, index) => (
              <div className="trace-layer" key={layer.id}>
                <div
                  className={`trace-head ${layer.sourceType === "system_preset" ? "sys" : layer.sourceType.includes("memory") || layer.sourceType === "lore_entry" ? "rag" : "msg"}`}
                  onClick={(e) => {
                    const next = e.currentTarget.nextElementSibling as HTMLElement;
                    if (next) next.style.display = next.style.display === "none" ? "block" : "none";
                  }}
                  style={{ cursor: "pointer", padding: "10px 14px", background: "var(--s2)", border: "1px solid var(--border)", borderRadius: 6, display: "flex", justifyContent: "space-between", marginBottom: 6 }}
                >
                  <div>
                    <strong>{index + 1}. {layer.sourceType}</strong>
                    <span style={{ color: "var(--t3)", marginLeft: 6 }}>{layer.sourceId}</span>
                  </div>
                  <div className="trace-meta">
                    <span style={{ fontSize: 12, color: "var(--t2)" }}>{layer.tokenCount} tokens</span>
                  </div>
                </div>
                <div className="trace-body" style={{ display: "none", padding: "12px", background: "var(--bg)", border: "1px solid var(--border2)", borderRadius: 6, marginBottom: 12, whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12, color: "var(--t2)" }}>
                  {layer.text}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 20 }}>
              <button
                className="api-test-btn idle"
                onClick={() => alert(input.promptPayloadText)}
                style={{ padding: "8px 16px", borderRadius: 6, cursor: "pointer" }}
              >
                View Raw JSON Payload
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 20, height: 120, background: "var(--s2)", borderRadius: 8, border: "1px dashed var(--border2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t3)", fontSize: 13, fontFamily: "var(--font-body)", fontStyle: "italic" }}>
            No traces recorded yet. Send a message to generate one.
          </div>
        )}
      </div>
    );
  }

  function renderTabContent(): ReactNode {
    switch (input.activeTab) {
      case "lorebook":
        return renderLorebook();
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
