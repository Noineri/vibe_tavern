import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PromptTraceRecordDto } from "@rp-platform/domain";
import type { AppSnapshot } from "../app-client.js";
import { Ic } from "./shared/icons";
import { cn } from "../lib/cn";
import { CharacterForm } from "./build/CharacterForm.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { useT } from "../i18n/context.js";
import { useChatStore } from "../stores/chat-store.js";
import { useCharacterStore } from "../stores/character-store.js";
import { useAppActions } from "./AppShell.js";

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

export function BuildMode() {
  const { t } = useT();
  const app = useAppActions();

  const snapshot = useChatStore((s) => s.snapshot);
  const character = snapshot?.character;
  const isSaving = useCharacterStore((s) => s.isSavingCharacter);
  const saveNotice = useCharacterStore((s) => s.characterSaveNotice);
  const buildTab = useCharacterStore((s) => s.buildTab);

  const activeTrace = app.activePromptTrace;
  const promptPayloadText = app.promptPayloadText;
  const promptTraceCount = snapshot?.promptTraceHistory.length ?? 0;

  if (!snapshot || !character) return null;

  return <BuildModeInner
    character={character}
    isSaving={isSaving}
    saveNotice={saveNotice}
    buildTab={buildTab}
    activeTrace={activeTrace}
    promptPayloadText={promptPayloadText}
    promptTraceCount={promptTraceCount}
    onSave={app.handleSaveCharacter}
    onAvatarUpload={app.handleAvatarUpload}
    t={t}
  />;
}

interface BuildModeInnerProps {
  character: AppSnapshot["character"];
  isSaving: boolean;
  saveNotice: string;
  buildTab: BuildTab;
  activeTrace: PromptTraceRecordDto | null;
  promptPayloadText: string;
  promptTraceCount: number;
  onSave: (draft: BuildCharacterDraft) => void;
  onAvatarUpload: (file: File) => void;
  t: (key: string) => string;
}

function BuildModeInner({ character, isSaving, saveNotice, buildTab, activeTrace, promptPayloadText, promptTraceCount, onSave, onAvatarUpload, t }: BuildModeInnerProps) {
  const [active, setActive] = useState<InternalBuildTab>(buildTab === "trace" ? "trace" : "char");

  useEffect(() => {
    if (buildTab === "trace") setActive("trace");
    if (buildTab === "character") setActive("char");
  }, [buildTab]);

  const [draft, setDraft] = useState<Record<string, any>>({
    name: character.name,
    description: character.description,
    firstMessage: character.firstMessage || "",
    mesExample: character.mesExample || "",
    scenario: character.scenario,
    personalitySummary: character.subtitle || "",
    systemPrompt: character.systemPrompt,
    alternateGreetings: character.alternateGreetings || [],
    postHistoryInstructions: character.postHistoryInstructions || "",
    creatorNotes: character.creatorNotes || "",
    characterBook: character.characterBook || "",
    depthPrompt: character.depthPrompt || "",
    depthPromptDepth: character.depthPromptDepth ?? 4,
    depthPromptRole: character.depthPromptRole || "system",
    extensions: character.extensions || "",
    tags: character.tags || [],
    _avatarPreview: null as string | null,
  });

  const prevCharIdRef = useRef(character.id);
  useEffect(() => {
    if (prevCharIdRef.current !== character.id) {
      prevCharIdRef.current = character.id;
      setDraft({
        name: character.name,
        description: character.description,
        firstMessage: character.firstMessage || "",
        mesExample: character.mesExample || "",
        scenario: character.scenario,
        personalitySummary: character.subtitle || "",
        systemPrompt: character.systemPrompt,
        alternateGreetings: character.alternateGreetings || [],
        postHistoryInstructions: character.postHistoryInstructions || "",
        creatorNotes: character.creatorNotes || "",
        characterBook: character.characterBook || "",
        depthPrompt: character.depthPrompt || "",
        depthPromptDepth: character.depthPromptDepth ?? 4,
        depthPromptRole: character.depthPromptRole || "system",
        extensions: character.extensions || "",
        tags: character.tags || [],
        _avatarPreview: null,
      });
    }
  }, [character.id]);

  const isDirty = useMemo(() => {
    return (
      draft.name !== character.name ||
      draft.description !== character.description ||
      draft.firstMessage !== (character.firstMessage || "") ||
      draft.mesExample !== (character.mesExample || "") ||
      draft.scenario !== character.scenario ||
      draft.personalitySummary !== (character.subtitle || "") ||
      draft.systemPrompt !== character.systemPrompt ||
      draft.alternateGreetings?.join("\n---\n") !== (character.alternateGreetings || []).join("\n---\n") ||
      draft.postHistoryInstructions !== (character.postHistoryInstructions || "") ||
      draft.creatorNotes !== (character.creatorNotes || "") ||
      draft.characterBook !== (character.characterBook || "") ||
      draft.depthPrompt !== (character.depthPrompt || "") ||
      draft.depthPromptDepth !== (character.depthPromptDepth ?? 4) ||
      draft.depthPromptRole !== (character.depthPromptRole || "system") ||
      draft.extensions !== (character.extensions || "") ||
      draft.tags?.join("\n") !== (character.tags || []).join("\n") ||
      !!draft._avatarPreview
    );
  }, [
    draft, character.name, character.description, character.firstMessage,
    character.scenario, character.subtitle, character.systemPrompt, character.mesExample,
    character.alternateGreetings, character.postHistoryInstructions, character.creatorNotes,
    character.characterBook, character.depthPrompt, character.depthPromptDepth,
    character.depthPromptRole, character.extensions, character.tags,
  ]);

  function patchDraft(key: string, value: any): void {
    setDraft((current: Record<string, any>) => ({ ...current, [key]: value }));
  }

  function resetDraft(): void {
    setDraft({
      name: character.name,
      description: character.description,
      firstMessage: character.firstMessage || "",
      mesExample: character.mesExample || "",
      scenario: character.scenario,
      personalitySummary: character.subtitle || "",
      systemPrompt: character.systemPrompt,
      alternateGreetings: character.alternateGreetings || [],
      postHistoryInstructions: character.postHistoryInstructions || "",
      creatorNotes: character.creatorNotes || "",
      characterBook: character.characterBook || "",
      depthPrompt: character.depthPrompt || "",
      depthPromptDepth: character.depthPromptDepth ?? 4,
      depthPromptRole: character.depthPromptRole || "system",
      extensions: character.extensions || "",
      tags: character.tags || [],
      _avatarPreview: null,
    });
  }

  function handleSave(): void {
    onSave({
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

  const prevNoticeRef = useRef(saveNotice);
  useEffect(() => {
    if (prevNoticeRef.current !== saveNotice && saveNotice === "Character card saved.") {
      prevNoticeRef.current = saveNotice;
      setDraft({
        name: character.name,
        description: character.description,
        firstMessage: character.firstMessage || "",
        mesExample: character.mesExample || "",
        scenario: character.scenario,
        personalitySummary: character.subtitle || "",
        systemPrompt: character.systemPrompt,
        alternateGreetings: character.alternateGreetings || [],
        postHistoryInstructions: character.postHistoryInstructions || "",
        creatorNotes: character.creatorNotes || "",
        characterBook: character.characterBook || "",
        depthPrompt: character.depthPrompt || "",
        depthPromptDepth: character.depthPromptDepth ?? 4,
        depthPromptRole: character.depthPromptRole || "system",
        extensions: character.extensions || "",
        tags: character.tags || [],
        _avatarPreview: null,
      });
    } else {
      prevNoticeRef.current = saveNotice;
    }
  }, [saveNotice]);

  function handleAvatarUpload(file: File): void {
    onAvatarUpload(file);
  }

  const avatarUrl = character.avatarAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${character.avatarAssetId}`
    : undefined;

  // Nav items — Phase 1: only Character + Trace
  const navItems: Array<{ id: InternalBuildTab; icon: ReactNode; label: string }> = [
    { id: "char", icon: <Ic.wrench />, label: t("build_char_card") },
    { id: "trace", icon: <Ic.trace />, label: t("build_prompt_trace") },
    // Phase 2: uncomment when Lorebook/Retrieval/MCP are implemented
    // { id: "lore", icon: <Ic.book />, label: "Lorebook" },
    // { id: "retrieval", icon: <Ic.search />, label: "Retrieval" },
    // { id: "mcp", icon: <Ic.tool />, label: "MCP Servers" },
  ];

  function renderTraceContent(): ReactNode {
    const trace = activeTrace;
    const totalTokens = trace ? (trace.tokenAccounting?.total ?? trace.layers.reduce((sum, l) => sum + l.tokenCount, 0)) : 0;
    return (
      <div className="max-w-[800px]">
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <div className="font-body text-[22px] font-medium text-t1" style={{ marginBottom: 6 }}>
            {t("build_prompt_trace")}
          </div>
          {trace && (
            <div
              className="rounded-full bg-s2 font-ui text-[13px] text-t2"
              style={{ padding: "4px 10px" }}
            >
              {t("trace_total_tokens").replace("{n}", String(totalTokens))}
            </div>
          )}
        </div>
        <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t3 leading-[1.55]" style={{ marginBottom: 28 }}>
          {trace ? (
            <>
              {t("trace_showing").replace("{n}", String(trace.id))}{" "}
              <span style={{ color: "var(--t2)" }}>{trace.id}</span> · {trace.createdAt} · model:{" "}
              {trace.model} · {trace.latencyMs}ms
            </>
          ) : (
            t("trace_no_active")
          )}{" "}
          · {t("trace_recorded_count").replace("{n}", String(promptTraceCount))}.
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
              <strong style={{ color: "var(--t2)" }}>{t("trace_prefill_label")}</strong>{" "}
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
                    <span style={{ fontSize: 12, color: "var(--t2)" }}>{layer.tokenCount} {t("tokens_label")}</span>
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
                onClick={() => alert(promptPayloadText)}
              >
                {t("view_raw_json")}
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
          {t("trace_no_traces_yet")}
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
          {t("editor")}
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
            isSaving={isSaving}
            saveNotice={saveNotice}
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
