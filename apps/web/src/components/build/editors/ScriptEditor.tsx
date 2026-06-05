import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { fetchProviderModelsAction } from "../../../stores/api-actions/provider-actions.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useActiveCharacter, useActivePersona, useAllCharacters } from "../../../stores/snapshot-store.js";
import { Ic } from "../../shared/icons.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { SCRIPT_TEMPLATES } from "./scriptTemplates.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import {
  listScripts,
  createScript,
  updateScript,
  deleteScript,
  testScript,
  importScript,
  streamAiAssistant,
  updateUiSettings,
  type ScriptRecord,
} from "../../../app-client.js";


// ── Types ──────────────────────────────────────────────────────────────

type Scope = "global" | "character" | "persona" | "chat";

interface ScriptPanelProps {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
  scope: string;
  onOpenEditor?: () => void;
  onBackToList?: () => void;
}

// ── Component ──────────────────────────────────────────────────────────
// ScriptPanel is a content-only component — no layout/scope/header.
// LorebookEditor manages tab, view, scope and renders these panels.

// Templates are imported from scriptTemplates.ts

/** Strip markdown code fences that AI models sometimes wrap their output in */
function cleanAiCode(raw: string): string {
  let code = raw.trim();
  // Remove opening fence: ```js, ```javascript, ```
  code = code.replace(/^```(?:js|javascript)?\s*\n?/i, '');
  // Remove closing fence
  code = code.replace(/\n?```\s*$/,'');
  return code.trim();
}

type DiffLineKind = "same" | "add" | "remove";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

interface DiffSummary {
  lines: DiffLine[];
  added: number;
  removed: number;
  tooLarge: boolean;
}

const MAX_INLINE_DIFF_LINES = 1600;

function buildLineDiff(oldCode: string, newCode: string): DiffSummary {
  const oldLines = oldCode.split("\n");
  const newLines = newCode.split("\n");
  if (oldLines.length + newLines.length > MAX_INLINE_DIFF_LINES) {
    return {
      lines: [],
      added: Math.max(0, newLines.length - oldLines.length),
      removed: Math.max(0, oldLines.length - newLines.length),
      tooLarge: true,
    };
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: "remove", text: oldLines[i++] });
      removed++;
    } else {
      lines.push({ kind: "add", text: newLines[j++] });
      added++;
    }
  }
  while (i < oldLines.length) {
    lines.push({ kind: "remove", text: oldLines[i++] });
    removed++;
  }
  while (j < newLines.length) {
    lines.push({ kind: "add", text: newLines[j++] });
    added++;
  }

  return { lines, added, removed, tooLarge: false };
}

export function DiffPreview({ summary, labels }: { summary: DiffSummary; labels: { title: string; tooLarge: string; noChanges: string } }) {
  if (summary.tooLarge) {
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="font-ui text-[12px] leading-relaxed text-t3">{labels.tooLarge}</div>
      </div>
    );
  }

  if (summary.added === 0 && summary.removed === 0) {
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
        <div className="font-ui text-[12px] text-t3">{labels.noChanges}</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="font-mono text-[11px] tabular-nums"><span className="text-success-text">+{summary.added}</span> <span className="text-danger-text">-{summary.removed}</span></div>
      </div>
      <pre className="max-h-[280px] overflow-y-auto overflow-x-hidden rounded border border-border/60 bg-surface p-2 font-mono text-[11px] leading-[1.45]">
        {summary.lines.map((line, idx) => (
          <div
            key={idx}
            className={cn(
              "min-w-0 whitespace-pre-wrap break-words px-2 [overflow-wrap:anywhere]",
              line.kind === "add" && "bg-success-dim text-success-text",
              line.kind === "remove" && "bg-danger-dim text-danger-text",
              line.kind === "same" && "text-t3/65",
            )}
          >
            <span className="select-none pr-2 text-t3/50">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>{line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function useScriptPanel({ characterId, chatId, personaId, scope, onOpenEditor, onBackToList }: ScriptPanelProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  const [activeScriptId, setActiveScriptIdRaw] = useState<string | null>(null);
  const setActiveScriptId = (id: string | null) => {
    setActiveScriptIdRaw(id);
    if (id && onOpenEditor) onOpenEditor();
  };
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<{ personality: string; scenario: string; state: Record<string, unknown>; errors: Array<{ scriptId: string; scriptName: string; error: string; line?: number } | string> } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCode, setImportCode] = useState("");
  const [apiRefOpen, setApiRefOpen] = useState(false);
  const [aiHelperOpen, setAiHelperOpen] = useState(false);
  const [aiProviderId, setAiProviderId] = useState("");
  const [aiModelName, setAiModelName] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiIncludeCharacter, setAiIncludeCharacter] = useState(true);
  const [aiIncludePersona, setAiIncludePersona] = useState(true);
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiStreamedCode, setAiStreamedCode] = useState("");
  const [aiStreamedReasoning, setAiStreamedReasoning] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);

  const aiAbortRef = useRef<AbortController | null>(null);

  // ── Queries (replaced with local state + async fetch) ────
  const scopeId = (() => {
    if (scope === "character") return characterId;
    if (scope === "persona") return personaId ?? undefined;
    if (scope === "chat") return chatId ?? undefined;
    return undefined;
  })();

  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const activeCharacter = useActiveCharacter();
  const activePersona = useActivePersona();
  const allCharacters = useAllCharacters();
  const selectedProfile = providerProfiles.find(p => p.id === aiProviderId);
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label?: string }>>([]);
  const characterContextName = activeCharacter?.id === characterId
    ? activeCharacter.name
    : allCharacters.find(c => c.id === characterId)?.name ?? "Character";
  const personaContextName = activePersona?.id === personaId
    ? activePersona.name
    : personas.find(p => p.id === personaId)?.name ?? "Persona";
  const canIncludePersona = Boolean(personaId);

  const refreshScripts = useCallback(async () => {
    setScripts(await listScripts(scope, scopeId));
  }, [scope, scopeId]);

  useEffect(() => { void refreshScripts(); }, [refreshScripts]);

  useEffect(() => {
    if (!bootstrapUiSettings || aiProviderId) return;
    if (bootstrapUiSettings.aiAssistantProviderId) setAiProviderId(bootstrapUiSettings.aiAssistantProviderId);
    if (bootstrapUiSettings.aiAssistantModelName) setAiModelName(bootstrapUiSettings.aiAssistantModelName);
  }, [aiProviderId, bootstrapUiSettings]);

  useEffect(() => {
    if (!personaId) setAiIncludePersona(false);
  }, [personaId]);

  useEffect(() => {
    if (!aiProviderId) { setProviderModels([]); return; }
    let cancelled = false;
    void fetchProviderModelsAction(aiProviderId).then(response => {
      if (!cancelled) {
        const models = (response && "models" in response ? response.models : []) as Array<{ id: string; label?: string }>;
        setProviderModels(models);
      }
    });
    return () => { cancelled = true; };
  }, [aiProviderId]);

  const activeScript = scripts.find(s => s.id === activeScriptId) ?? null;
  const cleanedAiCode = useMemo(() => cleanAiCode(aiStreamedCode), [aiStreamedCode]);
  const isAiEditMode = Boolean(activeScript?.code?.trim());
  const aiDiffSummary = useMemo(
    () => (!aiStreaming && aiStreamedCode && isAiEditMode ? buildLineDiff(activeScript?.code ?? "", cleanedAiCode) : null),
    [activeScript?.code, aiStreaming, aiStreamedCode, isAiEditMode, cleanedAiCode],
  );

  // ── Mutations (replaced with async handlers) ─────────────
  const [creatingScript, setCreatingScript] = useState(false);
  const [updatingScript, setUpdatingScript] = useState(false);
  const [deletingScript, setDeletingScript] = useState(false);
  const [testingScript, setTestingScript] = useState(false);
  const [importingScript, setImportingScript] = useState(false);

  const handleCreateScript = async (body: Parameters<typeof createScript>[0]) => {
    setCreatingScript(true);
    try {
      const s = await createScript(body);
      await refreshScripts();
      setActiveScriptId(s.id);
    } finally { setCreatingScript(false); }
  };

  const handleUpdateScript = async (id: string, body: Parameters<typeof updateScript>[1]) => {
    setUpdatingScript(true);
    try {
      await updateScript(id, body);
      await refreshScripts();
    } finally { setUpdatingScript(false); }
  };

  const handleDeleteScript = async (id: string) => {
    setDeletingScript(true);
    try {
      await deleteScript(id);
      await refreshScripts();
      if (activeScriptId === confirmDeleteId) setActiveScriptIdRaw(null);
      setConfirmDeleteId(null);
      onBackToList?.();
    } finally { setDeletingScript(false); }
  };

  const handleTestScript = async (id: string, input: string) => {
    setTestingScript(true);
    try {
      const r = await testScript(id, { lastMessage: input });
      setTestResult(r);
    } finally { setTestingScript(false); }
  };

  const handleImportScript = async (code: string) => {
    setImportingScript(true);
    try {
      const s = await importScript({ format: "js", code, scopeType: scope, characterId: scope === "character" ? characterId : undefined, personaId: scope === "persona" ? personaId ?? undefined : undefined, chatId: scope === "chat" ? chatId ?? undefined : undefined });
      await refreshScripts();
      setActiveScriptId(s.id);
      setImportOpen(false);
      setImportCode("");
    } finally { setImportingScript(false); }
  };

  // ── Scope-aware body helper ──────────────────────────────
  const scopeBody = () => {
    const base: Record<string, string | undefined> = { scopeType: scope };
    if (scope === "character") base.characterId = characterId;
    if (scope === "persona") base.personaId = personaId ?? undefined;
    if (scope === "chat") base.chatId = chatId ?? undefined;
    return base;
  };

  // ── Handlers ─────────────────────────────────────────────
  const handleAdd = () => {
    const body = { name: "New Script", code: "", ...scopeBody() } as Parameters<typeof createScript>[0];
    handleCreateScript(body);
  };

  const handleAddFromTemplate = (key: string) => {
    const tpl = SCRIPT_TEMPLATES[key];
    if (!tpl) return;
    if (activeScriptId && activeScript) {
      handleUpdateScript(activeScriptId, { code: activeScript.code ? activeScript.code + "\n\n" + tpl.code : tpl.code });
    } else {
      handleCreateScript({ name: tpl.name, code: tpl.code, ...scopeBody() } as Parameters<typeof createScript>[0]);
    }
  };

  const codeSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const updateField = (field: string, value: unknown) => {
    if (!activeScriptId) return;
    if (field === "code") {
      clearTimeout(codeSaveTimer.current);
      codeSaveTimer.current = setTimeout(() => {
        void handleUpdateScript(activeScriptId, { code: value as string });
      }, 600);
    } else {
      void handleUpdateScript(activeScriptId, { [field]: value } as Parameters<typeof updateScript>[1]);
    }
  };

  const runTest = () => {
    if (!activeScriptId || !testInput.trim()) return;
    handleTestScript(activeScriptId, testInput);
  };

  const persistAiModelSelection = (providerId: string, modelName: string | null) => {
    void updateUiSettings({ aiAssistantProviderId: providerId || null, aiAssistantModelName: modelName || null }).catch(() => {});
  };

  const handleAiProviderChange = (id: string) => {
    setAiProviderId(id);
    setAiModelName("");
    persistAiModelSelection(id, null);
  };

  const handleAiModelChange = (id: string) => {
    setAiModelName(id);
    persistAiModelSelection(aiProviderId, id || null);
  };

  const handleAiGenerate = async () => {
    if (!aiProviderId || !aiPrompt) return;
    persistAiModelSelection(aiProviderId, aiModelName || null);
    setAiStreaming(true);
    setAiError(null);
    setAiStreamedCode("");
    setAiStreamedReasoning("");
    const ac = new AbortController();
    aiAbortRef.current = ac;
    try {
      const enabledLayers = [
        ...(aiIncludeCharacter ? ["character_base"] : []),
        ...(aiIncludePersona && personaId ? ["persona"] : []),
      ];
      for await (const chunk of streamAiAssistant({
        mode: "script",
        instruction: aiPrompt,
        existingContent: activeScript?.code || undefined,
        providerProfileId: aiProviderId,
        model: aiModelName || undefined,
        enabledLayers,
        characterIds: aiIncludeCharacter && characterId ? [characterId] : [],
        personaIds: aiIncludePersona && personaId ? [personaId] : [],
      }, { signal: ac.signal })) {
        if (chunk.type === "reasoning" && chunk.text) {
          setAiStreamedReasoning(prev => prev + chunk.text);
        }
        if (chunk.type === "text" && chunk.text) {
          setAiStreamedCode(prev => prev + chunk.text);
        }
        if (chunk.type === "error" && chunk.error) { setAiError(chunk.error); setAiStreaming(false); return; }
        if (chunk.type === "done") { setAiStreaming(false); return; }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") setAiError(String(err));
      setAiStreaming(false);
    }
  };

  const resetAiHelper = () => {
    setAiHelperOpen(false);
    setAiStreamedCode("");
    setAiStreamedReasoning("");
    setAiPrompt("");
  };
  const handleAiStop = () => { aiAbortRef.current?.abort(); setAiStreaming(false); };
  const handleAiInsert = () => { if (!activeScriptId || !aiStreamedCode) return; handleUpdateScript(activeScriptId, { code: (activeScript?.code || "") + "\n\n" + cleanedAiCode }); resetAiHelper(); };
  const handleAiReplace = () => { if (!activeScriptId || !aiStreamedCode) return; handleUpdateScript(activeScriptId, { code: cleanedAiCode }); resetAiHelper(); };
  const handleAiApplyChanges = () => { if (!activeScriptId || !aiStreamedCode) return; handleUpdateScript(activeScriptId, { code: cleanedAiCode }); resetAiHelper(); };

  // ── Modals ───────────────────────────────────────────────
  const modals = (
    <>
      {confirmDeleteId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => setConfirmDeleteId(null)}>
          <div className="flex w-[400px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border" style={{ padding: "16px 20px" }}>
              <span className="text-sm font-semibold text-t1">{t("delete_script_confirm")}</span>
              <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => setConfirmDeleteId(null)}><Ic.close /></div>
            </div>
            <div className="p-5 text-[13px] text-t2">{t("delete_script_msg")}</div>
            <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={() => handleDeleteScript(confirmDeleteId)}>{t("delete_script_confirm")}</button>
            </div>
          </div>
        </div>
      )}
      {importOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => { setImportOpen(false); setImportCode(""); }}>
          <div className="flex w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" style={{ maxHeight: "80vh" }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border" style={{ padding: "16px 20px" }}>
              <span className="text-sm font-semibold text-t1">{t("script_import_title")}</span>
              <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => { setImportOpen(false); setImportCode(""); }}><Ic.close /></div>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
              <div className="mb-3 text-[13px] text-t2">{t("script_import_paste")}</div>
              <MobileExpandTextarea value={importCode} onChange={setImportCode} label={t("script_import_import")}>
                <textarea className="w-full min-h-[200px] rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent" placeholder={t("script_import_placeholder")} value={importCode} onChange={e => setImportCode(e.target.value)} />
              </MobileExpandTextarea>
              {importCode.trim() && (
                <div className="mt-2 text-[11px] text-accent-t">
                  {(importCode.trim().startsWith("{") || importCode.trim().startsWith("[")) ? t("script_import_detect_json") : t("script_import_detect_js")}
                </div>
              )}
              <div className="mt-3 text-[11px] text-t3">{t("script_templates")}:</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(SCRIPT_TEMPLATES).map(([key, tpl]) => (
                  <button type="button" key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => { handleAddFromTemplate(key); setImportOpen(false); setImportCode(""); }}>{t("script_template_" + key) || tpl.name}</button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => { setImportOpen(false); setImportCode(""); }}>Cancel</button>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={() => handleImportScript(importCode)} disabled={!importCode.trim()}>{t("script_import_import")}</button>
            </div>
          </div>
        </div>
      )}
      {aiHelperOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
          <div className="flex w-[560px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" style={{ maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border" style={{ padding: "16px 20px" }}>
              <span className="text-sm font-semibold text-t1">{t("script_ai_helper")}</span>
              <div className={cn("flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1", aiStreaming && "pointer-events-none opacity-30")} onClick={() => setAiHelperOpen(false)}><Ic.close /></div>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
              {providerProfiles.length === 0 ? (
                <div className="py-6 text-center font-ui text-[13px] text-t3">{t("script_ai_no_providers")}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 16 }}>
                    <div>
                      <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_connection")}</label>
                      <DropdownSelect
                        value={aiProviderId}
                        options={providerProfiles.map(p => ({ id: p.id, label: p.name }))}
                        placeholder={t("script_ai_select_provider")}
                        searchPlaceholder={t("script_ai_search_provider")}
                        onChange={handleAiProviderChange}
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_model")}</label>
                      <DropdownSelect
                        value={aiModelName}
                        options={providerModels.map(m => ({ id: m.id, label: m.label || m.id }))}
                        placeholder={selectedProfile?.defaultModel || "Default"}
                        searchPlaceholder={t("script_ai_search_model")}
                        defaultOption={selectedProfile?.defaultModel || "Default"}
                        onChange={handleAiModelChange}
                        disabled={!aiProviderId}
                      />
                    </div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_context")}</label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={cn(
                          "flex h-7 items-center gap-1.5 rounded-full border px-3 font-ui text-[11px] transition-all",
                          aiIncludeCharacter ? "border-accent bg-accent-dim text-accent-t" : "border-border bg-s3 text-t3 hover:text-t1",
                        )}
                        onClick={() => setAiIncludeCharacter(v => !v)}
                      >
                        <Ic.user /> {t("script_ai_context_character")}: {characterContextName}
                      </button>
                      {canIncludePersona && (
                        <button
                          type="button"
                          className={cn(
                            "flex h-7 items-center gap-1.5 rounded-full border px-3 font-ui text-[11px] transition-all",
                            aiIncludePersona ? "border-accent bg-accent-dim text-accent-t" : "border-border bg-s3 text-t3 hover:text-t1",
                          )}
                          onClick={() => setAiIncludePersona(v => !v)}
                        >
                          <Ic.user /> {t("script_ai_context_persona")}: {personaContextName}
                        </button>
                      )}
                    </div>
                    <div className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t("script_ai_context_hint")}</div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_prompt")}</label>
                    <MobileExpandTextarea value={aiPrompt} onChange={setAiPrompt} label={t("script_ai_helper")}>
                      <textarea className="w-full min-h-[100px] rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none" placeholder={t("script_ai_prompt")} value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} />
                    </MobileExpandTextarea>
                    <div className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t("script_ai_prompt_hint")}</div>
                  </div>
                  {aiStreamedReasoning && (
                    <div className="mb-3">
                      <MessageReasoning reasoning={aiStreamedReasoning} />
                    </div>
                  )}
                  {aiStreamedCode && (aiDiffSummary ? (
                    <>
                      <DiffPreview
                        summary={aiDiffSummary}
                        labels={{
                          title: t("script_ai_changes"),
                          tooLarge: t("script_ai_diff_too_large"),
                          noChanges: t("script_ai_no_changes"),
                        }}
                      />
                      {aiDiffSummary.tooLarge && (
                        <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_ai_generated")}</div>
                          <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">{cleanedAiCode}</pre>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_ai_generated")}</div>
                      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">{aiStreamedCode}{aiStreaming && <span className="animate-pulse text-accent">▌</span>}</pre>
                    </div>
                  ))}
                  {aiError && (
                    <div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10, marginBottom: 12 }}>
                      <div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_ai_error")}</div>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{aiError}</pre>
                    </div>
                  )}
                </>
              )}
            </div>
            {providerProfiles.length > 0 && (
              <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
                {aiStreamedCode && !aiStreaming && (
                  isAiEditMode ? (
                    <>
                      <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleAiReplace}>{t("script_ai_replace")}</button>
                      <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleAiApplyChanges}>{t("script_ai_apply")}</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleAiInsert}>{t("script_ai_insert")}</button>
                      <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleAiReplace}>{t("script_ai_replace")}</button>
                    </>
                  )
                )}
                {aiStreaming ? (
                  <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={handleAiStop}>{t("script_ai_stop")}</button>
                ) : (
                  <button type="button" className={cn("h-9 cursor-pointer rounded-md border-0 px-4 font-ui text-xs font-medium transition-all", aiProviderId && aiPrompt ? "bg-accent text-on-accent" : "bg-s3 text-t3 cursor-not-allowed")} onClick={handleAiGenerate} disabled={!aiProviderId || !aiPrompt}>{t("script_ai_generate")}</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );

  // ── Script list (for LorebookEditor list view) ────────────
  const scriptListContent = (
    <div className="flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]" style={{ padding: isMobile ? "12px" : "20px 24px" }}>
      {scripts.length === 0 ? (
        <div className="py-10 text-center">
          <div className="mb-2 text-[13px] text-t3">{t("script_no_scripts")}</div>
          <div className="flex justify-center gap-2">
            <button type="button" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={handleAdd}>
              <Ic.plus /> {t("new_script")}
            </button>
            <button type="button" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={() => setImportOpen(true)}>
              <Ic.import /> {t("script_import")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {scripts.map(s => (
            <div key={s.id} className={cn("mb-3 cursor-pointer rounded-xl border transition-all", s.id === activeScriptId ? "border-accent bg-accent-dim" : "border-border bg-surface hover:bg-s2")} onClick={() => setActiveScriptId(s.id)}>
              <div className="flex items-center gap-2 px-4 pt-3 pb-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></div>
                <span className="flex-1 truncate text-[14px] font-semibold text-t1">{s.name}</span>
                <div className={cn("shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase", s.enabled ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>
                  {s.enabled ? "ON" : "OFF"}
                </div>
              </div>
              {s.description && <div className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2 px-4 pb-3 pt-0">{s.description}</div>}
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={handleAdd}><Ic.plus /> {t("new_script")}</button>
            <button type="button" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={() => setImportOpen(true)}><Ic.import /> {t("script_import")}</button>
          </div>
        </>
      )}
    </div>
  );

  // ── Script editor panel (for LorebookEditor editor view) ──
  const scriptEditorPanel = activeScript ? (
    <div className={cn("mx-auto max-w-[860px]", isMobile && "pb-[calc(4rem+env(safe-area-inset-bottom,0px))] [&_button]:min-h-[40px] [&_input]:text-base")}>
      {/* Header: name + toggle + delete */}
      <div className="flex items-center gap-3" style={{ marginBottom: 16 }}>
        <div className="flex-1"><input className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[15px] font-semibold text-t1 outline-none focus:border-accent" type="text" value={activeScript.name} onChange={e => updateField("name", e.target.value)} placeholder={t("script_name")} /></div>
        <div
          className="shrink-0 cursor-pointer rounded-full transition-all"
          style={{ width: 36, height: 20, backgroundColor: activeScript.enabled ? "var(--accent)" : "var(--s3)", position: "relative" }}
          onClick={() => updateField("enabled", !activeScript.enabled)}
        >
          <div className="rounded-full transition-all" style={{ position: "absolute", top: 3, left: activeScript.enabled ? 19 : 3, width: 14, height: 14, backgroundColor: activeScript.enabled ? "#fff" : "var(--t3)" }} />
        </div>
        <CustomTooltip content={t("delete_script_confirm")}>
        <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2" onClick={() => setConfirmDeleteId(activeScript.id)}><Ic.del /></div>
        </CustomTooltip>
      </div>

      {/* Description */}
      <div style={{ marginBottom: 16 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_desc_label")}</label>
        <input className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent" value={activeScript.description ?? ""} onChange={e => updateField("description", e.target.value)} placeholder={t("script_desc_placeholder")} />
      </div>

      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")} onClick={() => setApiRefOpen(v => !v)}><Ic.book /> {t("script_api_reference")}</button>
        <button type="button" className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => setAiHelperOpen(true)}><Ic.brain /> {t("script_ai_helper")}</button>
      </div>

      {/* API Reference */}
      {apiRefOpen && (
        <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_api_context")}</div>
          <div className="grid gap-3 text-[12px]">
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_chat")}</div>
              <div className="grid gap-1">
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.lastMessage</code><span className="text-t3">— {t("script_api_chat_lastMessage")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.messages</code><span className="text-t3">— {t("script_api_chat_messages")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.messageCount</code><span className="text-t3">— {t("script_api_chat_messageCount")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.injectMessage(content, role?)</code><span className="text-t3">— {t("script_api_chat_injectMessage")}</span></div>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_character")}</div>
              <div className="grid gap-1">
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.character.name</code><span className="text-t3">— {t("script_api_char_name")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.character.personality</code><span className="text-t3">— {t("script_api_char_personality")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.character.scenario</code><span className="text-t3">— {t("script_api_char_scenario")}</span></div>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_state")}</div>
              <div className="grid gap-1">
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.state.get(key, default)</code><span className="text-t3">— {t("script_api_state_get")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.state.set(key, value)</code><span className="text-t3">— {t("script_api_state_set")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.state.increment(key, n)</code><span className="text-t3">— {t("script_api_state_increment")}</span></div>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_lore")}</div>
              <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.lore.activeEntries</code><span className="text-t3">— {t("script_api_lore_entries")}</span></div>
            </div>
          </div>
        </div>
      )}

      {/* Code editor */}
      <div style={{ marginBottom: 20 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_code_label")}</label>
        <div className="relative rounded-md border border-border bg-bg">
          <CodeEditor
            value={activeScript.code ?? ""}
            onChange={v => updateField("code", v)}
            minHeight={isMobile ? "220px" : "300px"}
            scrollMode={isMobile ? "page" : "inner"}
          />
        </div>
      </div>

      {/* Templates */}
      <div className="mb-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_templates")}</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SCRIPT_TEMPLATES).map(([key, tpl]) => (
            <button type="button" key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => handleAddFromTemplate(key)}>{t("script_template_" + key) || tpl.name}</button>
          ))}
        </div>
      </div>

      {/* Test panel */}
      <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
        <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_test_panel")}</div>
        <div className={cn("flex gap-2.5", isMobile && "flex-col")}>
          <input className={cn("h-9 flex-1 rounded-md border border-border bg-bg px-3 font-ui text-t1 outline-none", isMobile && "min-h-[44px]")} value={testInput} onChange={e => setTestInput(e.target.value)} onKeyDown={e => e.key === "Enter" && runTest()} placeholder={t("script_test_input_placeholder")} />
          <button type="button" className={cn("h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all", isMobile && "min-h-[44px]")} onClick={runTest}>{t("script_test_run")}</button>
        </div>
        {testResult && (
          <div className="mt-3 space-y-2">
            {testResult.errors.length > 0 && (
              <div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
                <div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_test_error")}</div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{testResult.errors.map(e => typeof e === 'string' ? e : `${e.scriptName ?? 'Script'}: ${e.error}${e.line ? ` (line ${e.line})` : ''}`).join("\n")}</pre>
              </div>
            )}
            {testResult.errors.length === 0 && (
              <>
                <div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_personality")}</div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{testResult.personality || <span className="italic text-t3">({t("script_test_no_result")})</span>}</pre>
                </div>
                <div className="rounded-md border border-border bg-bg" style={{ padding: 10 }}>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("script_test_scenario")}</div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{testResult.scenario || <span className="italic text-t3">({t("script_test_no_result")})</span>}</pre>
                </div>
              </>
            )}
          </div>
        )}
        {testingScript && <div className="mt-3 text-center font-ui text-[12px] text-t3">Running...</div>}
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center text-t3 font-ui text-[13px] italic">
      {t("script_test_no_result")}
    </div>
  );

  return { modals, scriptListContent, scriptEditorPanel, activeScriptId, setActiveScriptId, handleAdd, handleImportOpen: () => setImportOpen(true) };
}
