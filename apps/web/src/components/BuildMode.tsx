import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { PromptTraceRecordDto } from "@rp-platform/domain";
import { Ic } from "./shared/icons";
import { cn } from "../lib/cn";
import { CharacterForm } from "./build/CharacterForm.js";
import { getGatewayBaseUrl } from "../gateway-client.js";

export interface BuildCharacterDraft {
  name: string;
  description: string;
  firstMessage: string;
  mesExample: string;
  scenario: string;
  personalitySummary: string;
  systemPrompt: string;
  alternateGreetings: string[];
  postHistoryInstructions: string;
  creatorNotes: string;
  characterBook: string;
  depthPrompt: string;
  depthPromptDepth: number;
  depthPromptRole: string;
  extensions: string;
  tags: string[];
}

export type BuildTab = "character" | "lorebook" | "trace";
type InternalBuildTab = "char" | "trace";

interface BuildModeProps {
  characterId: string;
  characterName: string;
  description: string;
  firstMessage?: string | null;
  scenario: string;
  systemPrompt: string;
  subtitle?: string | null;
  mesExample: string | null;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook?: string | null;
  depthPrompt?: string | null;
  depthPromptDepth?: number | null;
  depthPromptRole?: string | null;
  extensions?: string | null;
  tags?: string[];
  avatarAssetId?: string | null;
  promptTraceCount: number;
  activeTrace: PromptTraceRecordDto | null;
  promptPayloadText: string;
  isSaving: boolean;
  saveNotice: string;
  /** @deprecated — import is now handled inside CharacterForm */
  importSurface?: ReactNode;
  /** @deprecated — tab state is now internal */
  activeTab?: string;
  /** @deprecated — tab state is now internal */
  onTabChange?: (tab: string) => void;
  onSave: (draft: BuildCharacterDraft) => void;
  onAvatarUpload?: (file: File) => void;
}

export function BuildMode(input: BuildModeProps) {
  const [active, setActive] = useState<InternalBuildTab>(input.activeTab === "trace" ? "trace" : "char");

  useEffect(() => {
    if (input.activeTab === "trace") setActive("trace");
    if (input.activeTab === "character") setActive("char");
  }, [input.activeTab]);

  const [draft, setDraft] = useState<Record<string, any>>({
    name: input.characterName,
    description: input.description,
    firstMessage: input.firstMessage || "",
    mesExample: input.mesExample || "",
    scenario: input.scenario,
    personalitySummary: input.subtitle || "",
    systemPrompt: input.systemPrompt,
    alternateGreetings: input.alternateGreetings || [],
    postHistoryInstructions: input.postHistoryInstructions || "",
    creatorNotes: input.creatorNotes || "",
    characterBook: input.characterBook || "",
    depthPrompt: input.depthPrompt || "",
    depthPromptDepth: input.depthPromptDepth ?? 4,
    depthPromptRole: input.depthPromptRole || "system",
    extensions: input.extensions || "",
    tags: input.tags || [],
    _avatarPreview: null as string | null,
  });

  // Sync draft when input props change (character switch, server save, etc.)
  useEffect(() => {
    setDraft({
      name: input.characterName,
      description: input.description,
      firstMessage: input.firstMessage || "",
      mesExample: input.mesExample || "",
      scenario: input.scenario,
      personalitySummary: input.subtitle || "",
      systemPrompt: input.systemPrompt,
      alternateGreetings: input.alternateGreetings || [],
      postHistoryInstructions: input.postHistoryInstructions || "",
      creatorNotes: input.creatorNotes || "",
      characterBook: input.characterBook || "",
      depthPrompt: input.depthPrompt || "",
      depthPromptDepth: input.depthPromptDepth ?? 4,
      depthPromptRole: input.depthPromptRole || "system",
      extensions: input.extensions || "",
      tags: input.tags || [],
      _avatarPreview: null,
    });
  }, [
    input.characterId, input.characterName, input.description, input.firstMessage,
    input.scenario, input.subtitle, input.systemPrompt, input.mesExample,
    input.alternateGreetings, input.postHistoryInstructions, input.creatorNotes,
    input.characterBook, input.depthPrompt, input.depthPromptDepth,
    input.depthPromptRole, input.extensions, input.tags,
  ]);

  const isDirty = useMemo(() => {
    return (
      draft.name !== input.characterName ||
      draft.description !== input.description ||
      draft.firstMessage !== (input.firstMessage || "") ||
      draft.mesExample !== (input.mesExample || "") ||
      draft.scenario !== input.scenario ||
      draft.personalitySummary !== (input.subtitle || "") ||
      draft.systemPrompt !== input.systemPrompt ||
      draft.alternateGreetings?.join("\n---\n") !== (input.alternateGreetings || []).join("\n---\n") ||
      draft.postHistoryInstructions !== (input.postHistoryInstructions || "") ||
      draft.creatorNotes !== (input.creatorNotes || "") ||
      draft.characterBook !== (input.characterBook || "") ||
      draft.depthPrompt !== (input.depthPrompt || "") ||
      draft.depthPromptDepth !== (input.depthPromptDepth ?? 4) ||
      draft.depthPromptRole !== (input.depthPromptRole || "system") ||
      draft.extensions !== (input.extensions || "") ||
      draft.tags?.join("\n") !== (input.tags || []).join("\n") ||
      !!draft._avatarPreview
    );
  }, [
    draft, input.characterName, input.description, input.firstMessage,
    input.scenario, input.subtitle, input.systemPrompt, input.mesExample,
    input.alternateGreetings, input.postHistoryInstructions, input.creatorNotes,
    input.characterBook, input.depthPrompt, input.depthPromptDepth,
    input.depthPromptRole, input.extensions, input.tags,
  ]);

  function patchDraft(key: string, value: any): void {
    setDraft((current: Record<string, any>) => ({ ...current, [key]: value }));
  }

  function resetDraft(): void {
    setDraft({
      name: input.characterName,
      description: input.description,
      firstMessage: input.firstMessage || "",
      mesExample: input.mesExample || "",
      scenario: input.scenario,
      personalitySummary: input.subtitle || "",
      systemPrompt: input.systemPrompt,
      alternateGreetings: input.alternateGreetings || [],
      postHistoryInstructions: input.postHistoryInstructions || "",
      creatorNotes: input.creatorNotes || "",
      characterBook: input.characterBook || "",
      depthPrompt: input.depthPrompt || "",
      depthPromptDepth: input.depthPromptDepth ?? 4,
      depthPromptRole: input.depthPromptRole || "system",
      extensions: input.extensions || "",
      tags: input.tags || [],
      _avatarPreview: null,
    });
  }

  function handleSave(): void {
    input.onSave({
      name: draft.name?.trim() || "",
      description: draft.description,
      firstMessage: draft.firstMessage,
      mesExample: draft.mesExample,
      scenario: draft.scenario,
      personalitySummary: draft.personalitySummary,
      systemPrompt: draft.systemPrompt,
      alternateGreetings: draft.alternateGreetings || [],
      postHistoryInstructions: draft.postHistoryInstructions,
      creatorNotes: draft.creatorNotes,
      characterBook: draft.characterBook,
      depthPrompt: draft.depthPrompt,
      depthPromptDepth: draft.depthPromptDepth ?? 4,
      depthPromptRole: draft.depthPromptRole || "system",
      extensions: draft.extensions,
      tags: draft.tags || [],
    });
  }

  function handleAvatarUpload(file: File): void {
    input.onAvatarUpload?.(file);
  }

  const avatarUrl = input.avatarAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${input.avatarAssetId}`
    : undefined;

  // Nav items — Phase 1: only Character + Trace
  const navItems: Array<{ id: InternalBuildTab; icon: ReactNode; label: string }> = [
    { id: "char", icon: <Ic.wrench />, label: "Character Card" },
    { id: "trace", icon: <Ic.trace />, label: "Prompt Trace" },
    // Phase 2: uncomment when Lorebook/Retrieval/MCP are implemented
    // { id: "lore", icon: <Ic.book />, label: "Lorebook" },
    // { id: "retrieval", icon: <Ic.search />, label: "Retrieval" },
    // { id: "mcp", icon: <Ic.tool />, label: "MCP Servers" },
  ];

  function renderTraceContent(): ReactNode {
    const trace = input.activeTrace;
    return (
      <div className="max-w-[800px]">
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <div className="font-body text-[22px] font-medium text-t1" style={{ marginBottom: 6 }}>
            Prompt Trace
          </div>
          {trace && (
            <div
              className="rounded-full bg-s2 font-ui text-[13px] text-t2"
              style={{ padding: "4px 10px" }}
            >
              Total: {trace.tokenAccounting?.total ?? trace.layers.reduce((sum, l) => sum + l.tokenCount, 0)} tokens
            </div>
          )}
        </div>
        <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t3 leading-[1.55]" style={{ marginBottom: 28 }}>
          {trace ? (
            <>
              Showing trace{" "}
              <span style={{ color: "var(--t2)" }}>{trace.id}</span> · {trace.createdAt} · model:{" "}
              {trace.model} · {trace.latencyMs}ms
            </>
          ) : (
            "No active trace."
          )}{" "}
          · Recorded: {input.promptTraceCount}.
          {trace?.prefill && (
            <div
              style={{
                marginTop: 6,
                padding: "6px 10px",
                background: "var(--s2)",
                borderRadius: 6,
                border: "1px solid var(--border2)",
                fontSize: 12,
                fontFamily: "var(--font-body)",
              }}
            >
              <strong style={{ color: "var(--t2)" }}>Prefill:</strong>{" "}
              <span style={{ color: "var(--t3)", whiteSpace: "pre-wrap" }}>{trace.prefill}</span>
            </div>
          )}
        </div>

        {trace ? (
          <div className="flex flex-col gap-2">
            {trace.layers.map((layer, index) => (
              <div key={layer.id} className="overflow-hidden rounded-md border border-border bg-s2">
                <div
                  className={cn(
                    "flex cursor-pointer items-center justify-between bg-surface font-ui text-xs text-t2 transition-colors hover:bg-s2 hover:text-t1",
                    layer.sourceType === "prompt_preset" && "border-l-2 border-l-info",
                    (layer.sourceType.includes("memory") || layer.sourceType === "lore_entry") && "border-l-2 border-l-success",
                    !layer.sourceType.includes("memory") && layer.sourceType !== "lore_entry" && layer.sourceType !== "prompt_preset" && "border-l-2 border-l-danger",
                  )}
                  style={{ padding: "10px 14px" }}
                  onClick={(e) => {
                    const next = e.currentTarget.nextElementSibling as HTMLElement;
                    if (next) next.style.display = next.style.display === "none" ? "block" : "none";
                  }}
                >
                  <div>
                    <strong>
                      {index + 1}. {layer.sourceType}
                    </strong>
                    <span style={{ color: "var(--t3)", marginLeft: 6 }}>{layer.sourceId}</span>
                  </div>
                  <div className="flex gap-2 text-t3">
                    <span style={{ fontSize: 12, color: "var(--t2)" }}>{layer.tokenCount} tokens</span>
                  </div>
                </div>
                <div
                  className="border-t border-border bg-bg whitespace-pre-wrap font-mono text-[11px] text-t1"
                  style={{ display: "none", padding: 12 }}
                >
                  {layer.text}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 20 }}>
              <button
                className="inline-flex cursor-pointer items-center rounded-md border-0 bg-s3 font-ui text-xs font-medium text-t2 transition-colors hover:bg-border2 hover:text-t1"
                style={{ padding: "8px 16px" }}
                onClick={() => alert(input.promptPayloadText)}
              >
                View Raw JSON Payload
              </button>
            </div>
          </div>
        ) : (
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
            No traces recorded yet. Send a message to generate one.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Nav sidebar */}
      <div
        className="flex min-w-[200px] flex-col border-r border-border bg-surface"
        style={{ width: 200, padding: "8px 0" }}
      >
        <div
          className={cn("font-ui text-[calc(var(--ui-fs)-5px)] font-medium uppercase tracking-[0.08em] text-t3")}
          style={{ padding: "9px 15px 7px" }}
        >
          Editor
        </div>
        {navItems.map((n) => (
          <div
            key={n.id}
            className={cn(
              "flex items-center gap-2.5 cursor-pointer rounded mx-1 font-ui text-[calc(var(--ui-fs)-1px)] text-t2 transition-all hover:bg-s2 hover:text-t1",
              active === n.id && "bg-accent-dim text-accent-t",
            )}
            style={{ padding: "8px 14px" }}
            onClick={() => setActive(n.id)}
          >
            {n.icon}
            <span>{n.label}</span>
          </div>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto" style={{ padding: "32px 40px" }}>
        {active === "char" && (
          <CharacterForm
            draft={draft}
            patchDraft={patchDraft}
            setDraft={setDraft}
            isDirty={isDirty}
            isSaving={input.isSaving}
            saveNotice={input.saveNotice}
            avatarUrl={avatarUrl}
            onSave={handleSave}
            onReset={resetDraft}
            onAvatarUpload={handleAvatarUpload}
          />
        )}
        {active === "trace" && renderTraceContent()}
      </div>
    </div>
  );
}
