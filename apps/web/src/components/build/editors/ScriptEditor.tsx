import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { Ic } from "../../shared/icons.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { SCRIPT_TEMPLATES } from "./scriptTemplates.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { AiAssistantModal } from "../../shared/AiAssistantModal.js";
import {
  listAllScripts,
  listScripts,
  createScript,
  updateScript,
  deleteScript,
  testScript,
  importScript,
  type ScriptRecord,
} from "../../../app-client.js";
// ── Types ──────────────────────────────────────────────────────────────

import { LoreEntryList } from "./LoreEntryList.js";

// ── Types ──────────────────────────────────────────────────────────────

import type { Scope } from "./LorebookAccordion.js";

interface ScriptPanelProps {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
  scope: Scope;
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

  // ── Queries (replaced with local state + async fetch) ────
  const scopeId = (() => {
    if (scope === "character") return characterId;
    if (scope === "persona") return personaId ?? undefined;
    if (scope === "chat") return chatId ?? undefined;
    return undefined;
  })();

  const [scripts, setScripts] = useState<ScriptRecord[]>([]);

  const refreshScripts = useCallback(async () => {
    // "all" — обзорный режим (только чтение), отдаёт все скрипты без фильтра
    // по скоупу. Иначе — по скоупу + владельцу.
    setScripts(scope === "all" ? await listAllScripts() : await listScripts(scope, scopeId));
  }, [scope, scopeId]);

  useEffect(() => { void refreshScripts(); }, [refreshScripts]);

  const activeScript = scripts.find(s => s.id === activeScriptId) ?? null;

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
  // "all" — обзорный режим без конкретного владельца; создание/импорт скриптов
  // в нём запрещены (CTA скрыты в LorebookEditor), fallback чисто оборонительный.
  const scopeBody = () => {
    const effectiveScope: Exclude<Scope, "all"> = scope === "all" ? "character" : scope;
    const base: Record<string, string | undefined> = { scopeType: effectiveScope };
    if (effectiveScope === "character") base.characterId = characterId;
    if (effectiveScope === "persona") base.personaId = personaId ?? undefined;
    if (effectiveScope === "chat") base.chatId = chatId ?? undefined;
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
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setConfirmDeleteId(null)}>{t("cancel")}</button>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-on-danger transition-all" onClick={() => handleDeleteScript(confirmDeleteId)}>{t("delete_script_confirm")}</button>
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
                <AutoTextarea className="w-full min-h-[200px] rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent" style={{}} maxHeight={500} placeholder={t("script_import_placeholder")} value={importCode} onChange={e => setImportCode(e.target.value)} />
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
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => { setImportOpen(false); setImportCode(""); }}>{t("cancel")}</button>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={() => handleImportScript(importCode)} disabled={!importCode.trim()}>{t("script_import_import")}</button>
            </div>
          </div>
        </div>
      )}
      <AiAssistantModal
        mode="full"
        apiMode="script"
        isOpen={aiHelperOpen}
        onClose={() => setAiHelperOpen(false)}
        existingContent={activeScript?.code ?? ""}
        onInsert={(text) => {
          if (!activeScriptId) return;
          void handleUpdateScript(activeScriptId, { code: text });
        }}
        onReplace={(text) => {
          if (!activeScriptId) return;
          void handleUpdateScript(activeScriptId, { code: text });
        }}
        scopeContext={{
          characterId: characterId,
          personaId: personaId ?? undefined,
        }}
      />
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
        {testingScript && <div className="mt-3 text-center font-ui text-[12px] text-t3">{t("script_running")}</div>}
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center text-t3 font-ui text-[13px] italic">
      {t("script_test_no_result")}
    </div>
  );

  return { modals, scriptListContent, scriptEditorPanel, activeScriptId, setActiveScriptId, handleAdd, handleImportOpen: () => setImportOpen(true) };
}
