import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ic } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import {
  listScripts,
  createScript,
  updateScript,
  deleteScript,
  testScript,
  importScript,
  streamScriptAiAssistant,
  type ScriptRecord,
} from "../../app-client.js";
import { scriptKeys } from "../../queries/query-keys.js";
import { useProviderProfilesQuery, useProviderModelsQuery } from "../../queries/provider-queries.js";

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

// ── Script templates ───────────────────────────────────────────────────

const SCRIPT_TEMPLATES: Record<string, { name: string; code: string }> = {
  mana: { name: "Mana Tracker", code: "// Mana Tracker\nvar msg = (context.chat.lastMessage || \"\").toLowerCase();\nvar mana = context.state.get('mana', 100);\nvar cost = 0;\nif (msg.includes('fireball')) cost = 30;\nelse if (msg.includes('heal')) cost = 20;\nmana = mana - cost + (cost === 0 ? 10 : 0);\nif (mana > 100) mana = 100;\nif (mana < 0) mana = 0;\ncontext.state.set('mana', mana);\nif (cost > 0 || mana < 100) {\n  context.character.personality += \"\\n\\n[MANA] \" + mana + \"/100\";\n}" },
  dice: { name: "Dice Roller", code: "// Dice Roller\nvar msg = (context.chat.lastMessage || \"\").toLowerCase();\nvar m = msg.match(/\\/roll\\s*(\\d+)d(\\d+)/);\nif (m) {\n  var n = parseInt(m[1]), s = parseInt(m[2]), t = 0, r = [];\n  for (var i = 0; i < n; i++) { var v = Math.floor(Math.random()*s)+1; r.push(v); t += v; }\n  context.character.personality += \"\\n\\n[DICE] \" + n + \"d\" + s + \": [\" + r.join(\", \") + \"] = \" + t;\n}" },
  gacha: { name: "Gacha Summon", code: "// Gacha Summon\nvar msg = (context.chat.lastMessage || \"\").toLowerCase();\nif (msg.includes('summon') || msg.includes('roll')) {\n  var r = Math.random() * 100;\n  var rarity = r < 3 ? 'UR' : r < 15 ? 'SSR' : r < 45 ? 'SR' : 'R';\n  context.character.personality += \"\\n\\n[SUMMON] Rarity: \" + rarity;\n}" },
  weather: { name: "Weather Cycle", code: "// Weather Cycle\nvar c = (context.chat.messageCount || 0);\nvar w = ['clear','rain','storm','fog','snow','sunshine'];\ncontext.character.scenario += \"\\n\\n[WEATHER] \" + w[Math.floor(c/3) % w.length];" },
  hp: { name: "HP Tracker", code: "// HP Tracker\nvar msg = (context.chat.lastMessage || \"\").toLowerCase();\nvar hp = context.state.get('hp', 100);\nif (msg.includes('hit') || msg.includes('attack')) hp -= 15;\nif (msg.includes('heal') || msg.includes('potion')) hp += 20;\nif (hp > 100) hp = 100;\nif (hp < 0) hp = 0;\ncontext.state.set('hp', hp);\ncontext.character.personality += \"\\n\\n[HP] \" + hp + \"/100\";\nif (hp <= 20) context.character.personality += ' ⚠ Critical!';" },
  random: { name: "Random Event", code: "// Random Event (5% chance)\nif (Math.random() < 0.05) {\n  var events = ['A sudden gust of wind scatters papers.', 'A distant bell chimes.', 'The ground trembles briefly.', 'A strange aroma drifts in.'];\n  context.character.scenario += \"\\n\\n[EVENT] \" + events[Math.floor(Math.random() * events.length)];\n}" },
};

// ── Component ──────────────────────────────────────────────────────────
// ScriptPanel is a content-only component — no layout/scope/header.
// LorebookEditor manages tab, view, scope and renders these panels.

export function useScriptPanel({ characterId, chatId, personaId, scope, onOpenEditor, onBackToList }: ScriptPanelProps) {
  const { t } = useT();
  const qc = useQueryClient();

  const [activeScriptId, setActiveScriptIdRaw] = useState<string | null>(null);
  const setActiveScriptId = (id: string | null) => {
    setActiveScriptIdRaw(id);
    if (id && onOpenEditor) onOpenEditor();
  };
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<{ personality: string; scenario: string; state: Record<string, unknown>; errors: string[] } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCode, setImportCode] = useState("");
  const [apiRefOpen, setApiRefOpen] = useState(false);
  const [aiHelperOpen, setAiHelperOpen] = useState(false);
  const [aiProviderId, setAiProviderId] = useState("");
  const [aiModelName, setAiModelName] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiStreamedCode, setAiStreamedCode] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  // ── Queries ──────────────────────────────────────────────
  const scopeId = (() => {
    if (scope === "character") return characterId;
    if (scope === "persona") return personaId ?? undefined;
    if (scope === "chat") return chatId ?? undefined;
    return undefined;
  })();

  const scriptsQuery = useQuery({
    queryKey: scriptKeys.byScope(scope, scopeId),
    queryFn: () => listScripts(scope, scopeId),
  });
  const scripts = scriptsQuery.data ?? [];
  const activeScript = scripts.find(s => s.id === activeScriptId) ?? null;

  const { data: providerProfiles = [] } = useProviderProfilesQuery();
  const selectedProfile = providerProfiles.find(p => p.id === aiProviderId);
  const { data: providerModelsRaw } = useProviderModelsQuery(aiProviderId);
  const providerModels = (providerModelsRaw && "models" in providerModelsRaw ? providerModelsRaw.models : []) as Array<{ id: string; label?: string }>;

  // ── Mutations ────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (body: Parameters<typeof createScript>[0]) => createScript(body),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: scriptKeys.all() }); setActiveScriptId(s.id); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof updateScript>[1] }) => updateScript(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: scriptKeys.all() }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteScript(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: scriptKeys.all() }); if (activeScriptId === confirmDeleteId) setActiveScriptIdRaw(null); setConfirmDeleteId(null); onBackToList?.(); },
  });

  const testMut = useMutation({
    mutationFn: ({ id, input }: { id: string; input: string }) => testScript(id, { lastMessage: input }),
    onSuccess: (r) => setTestResult(r),
  });

  const importMut = useMutation({
    mutationFn: (code: string) => importScript({ format: "js", code, scopeType: scope, characterId: scope === "character" ? characterId : undefined, personaId: scope === "persona" ? personaId ?? undefined : undefined, chatId: scope === "chat" ? chatId ?? undefined : undefined }),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: scriptKeys.all() }); setActiveScriptId(s.id); setImportOpen(false); setImportCode(""); },
  });

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
    createMut.mutate(body);
  };

  const handleAddFromTemplate = (key: string) => {
    const tpl = SCRIPT_TEMPLATES[key];
    if (!tpl) return;
    if (activeScriptId && activeScript) {
      updateMut.mutate({ id: activeScriptId, body: { code: activeScript.code ? activeScript.code + "\n\n" + tpl.code : tpl.code } });
    } else {
      createMut.mutate({ name: tpl.name, code: tpl.code, ...scopeBody() } as Parameters<typeof createScript>[0]);
    }
  };

  const updateField = (field: string, value: unknown) => {
    if (!activeScriptId) return;
    updateMut.mutate({ id: activeScriptId, body: { [field]: value } as Parameters<typeof updateScript>[1] });
  };

  const runTest = () => {
    if (!activeScriptId || !testInput.trim()) return;
    testMut.mutate({ id: activeScriptId, input: testInput });
  };

  const handleAiGenerate = async () => {
    if (!aiProviderId || !aiPrompt) return;
    setAiStreaming(true);
    setAiError(null);
    setAiStreamedCode("");
    const ac = new AbortController();
    aiAbortRef.current = ac;
    try {
      for await (const chunk of streamScriptAiAssistant({ prompt: aiPrompt, existingCode: activeScript?.code || undefined, providerProfileId: aiProviderId, model: aiModelName || undefined })) {
        if (chunk.type === "text" && chunk.text) setAiStreamedCode(prev => prev + chunk.text);
        if (chunk.type === "error" && chunk.error) { setAiError(chunk.error); setAiStreaming(false); return; }
        if (chunk.type === "done") { setAiStreaming(false); return; }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") setAiError(String(err));
      setAiStreaming(false);
    }
  };

  const handleAiStop = () => { aiAbortRef.current?.abort(); setAiStreaming(false); };
  const handleAiInsert = () => { if (!activeScriptId || !aiStreamedCode) return; updateMut.mutate({ id: activeScriptId, body: { code: (activeScript?.code || "") + "\n\n" + aiStreamedCode } }); setAiHelperOpen(false); setAiStreamedCode(""); setAiPrompt(""); };
  const handleAiReplace = () => { if (!activeScriptId || !aiStreamedCode) return; updateMut.mutate({ id: activeScriptId, body: { code: aiStreamedCode } }); setAiHelperOpen(false); setAiStreamedCode(""); setAiPrompt(""); };

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
              <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={() => deleteMut.mutate(confirmDeleteId)}>{t("delete_script_confirm")}</button>
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
              <textarea className="w-full min-h-[200px] rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent" placeholder={t("script_import_placeholder")} value={importCode} onChange={e => setImportCode(e.target.value)} />
              {importCode.trim() && (
                <div className="mt-2 text-[11px] text-accent-t">
                  {(importCode.trim().startsWith("{") || importCode.trim().startsWith("[")) ? t("script_import_detect_json") : t("script_import_detect_js")}
                </div>
              )}
              <div className="mt-3 text-[11px] text-t3">{t("script_templates")}:</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(SCRIPT_TEMPLATES).map(([key, tpl]) => (
                  <button key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => { handleAddFromTemplate(key); setImportOpen(false); setImportCode(""); }}>{t("script_template_" + key) || tpl.name}</button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
              <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => { setImportOpen(false); setImportCode(""); }}>Cancel</button>
              <button className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={() => importMut.mutate(importCode)} disabled={!importCode.trim()}>{t("script_import_import")}</button>
            </div>
          </div>
        </div>
      )}
      {aiHelperOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => { if (!aiStreaming) setAiHelperOpen(false); }}>
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
                      <select className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none" value={aiProviderId} onChange={e => { setAiProviderId(e.target.value); setAiModelName(""); }}>
                        <option value="">Select provider...</option>
                        {providerProfiles.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_model")}</label>
                      <select className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none" value={aiModelName} onChange={e => setAiModelName(e.target.value)}>
                        <option value="">{selectedProfile?.defaultModel || "Default"}</option>
                        {providerModels.map(m => (
                          <option key={m.id} value={m.id}>{m.label || m.id}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_prompt")}</label>
                    <textarea className="w-full min-h-[100px] rounded-md border border-border bg-bg px-3 py-2 font-ui text-t1 outline-none focus:border-accent" placeholder={t("script_ai_prompt")} value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} />
                  </div>
                  {aiStreamedCode && (
                    <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Generated code</div>
                      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">{aiStreamedCode}{aiStreaming && <span className="animate-pulse text-accent">▌</span>}</pre>
                    </div>
                  )}
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
                  <>
                    <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleAiInsert}>{t("script_ai_insert")}</button>
                    <button className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleAiReplace}>{t("script_ai_replace")}</button>
                  </>
                )}
                {aiStreaming ? (
                  <button className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={handleAiStop}>{t("script_ai_stop")}</button>
                ) : (
                  <button className={cn("h-9 cursor-pointer rounded-md border-0 px-4 font-ui text-xs font-medium transition-all", aiProviderId && aiPrompt ? "bg-accent text-on-accent" : "bg-s3 text-t3 cursor-not-allowed")} onClick={handleAiGenerate} disabled={!aiProviderId || !aiPrompt}>{t("script_ai_generate")}</button>
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
    <div className="flex-1 overflow-y-auto" style={{ padding: "20px 24px" }}>
      {scripts.length === 0 ? (
        <div className="py-10 text-center">
          <div className="mb-2 text-[13px] text-t3">{t("script_no_scripts")}</div>
          <div className="flex justify-center gap-2">
            <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={handleAdd}>
              <Ic.plus /> {t("new_script")}
            </button>
            <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={() => setImportOpen(true)}>
              <Ic.import /> {t("script_import")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {scripts.map(s => (
            <div key={s.id} className={cn("mb-3 cursor-pointer rounded-xl border transition-all", s.id === activeScriptId ? "border-accent bg-accent-dim" : "border-border bg-surface hover:bg-s2")} onClick={() => setActiveScriptId(s.id)}>
              <div className="flex items-center gap-2" style={{ padding: "14px 16px" }}>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></div>
                <span className="flex-1 truncate text-[14px] font-semibold text-t1">{s.name}</span>
                <div className={cn("shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase", s.enabled ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>
                  {s.enabled ? "ON" : "OFF"}
                </div>
              </div>
              {s.description && <div className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2" style={{ padding: "2px 16px 0" }}>{s.description}</div>}
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={handleAdd}><Ic.plus /> {t("new_script")}</button>
            <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={() => setImportOpen(true)}><Ic.import /> {t("script_import")}</button>
          </div>
        </>
      )}
    </div>
  );

  // ── Script editor panel (for LorebookEditor editor view) ──
  const scriptEditorPanel = activeScript ? (
    <div className="mx-auto max-w-[860px]">
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
        <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2" title={t("delete_script_confirm")} onClick={() => setConfirmDeleteId(activeScript.id)}><Ic.del /></div>
      </div>

      {/* Description */}
      <div style={{ marginBottom: 16 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_desc_label")}</label>
        <input className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent" value={activeScript.description ?? ""} onChange={e => updateField("description", e.target.value)} placeholder={t("script_desc_placeholder")} />
      </div>

      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap gap-2">
        <button className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")} onClick={() => setApiRefOpen(v => !v)}><Ic.book /> {t("script_api_reference")}</button>
        <button className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => setAiHelperOpen(true)}><Ic.brain /> {t("script_ai_helper")}</button>
      </div>

      {/* API Reference */}
      {apiRefOpen && (
        <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_api_context")}</div>
          <div className="grid gap-2 text-[12px]">
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.chat.lastMessage</code><span className="text-t3">string</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.chat.messages</code><span className="text-t3">Array of &#123; role, message &#125;</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.chat.messageCount</code><span className="text-t3">number</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.character.name</code><span className="text-t3">string</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.character.personality</code><span className="text-t3">string, MUTABLE</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.character.scenario</code><span className="text-t3">string, MUTABLE</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.state.get/set/increment</code><span className="text-t3">persistent state</span></div>
            <div className="flex gap-2"><code className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-accent-t">context.lore.activeEntries</code><span className="text-t3">read-only lore entries</span></div>
          </div>
        </div>
      )}

      {/* Code editor */}
      <div style={{ marginBottom: 20 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_code_label")}</label>
        <div className="relative rounded-md border border-border bg-bg">
          <textarea className="w-full min-h-[300px] resize-y bg-transparent px-3 py-2 font-mono text-[calc(var(--ui-fs)-1px)] leading-[1.6] text-t1 outline-none" value={activeScript.code ?? ""} onChange={e => updateField("code", e.target.value)} placeholder={t("script_code_placeholder")} spellCheck={false} />
        </div>
      </div>

      {/* Templates */}
      <div className="mb-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_templates")}</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SCRIPT_TEMPLATES).map(([key, tpl]) => (
            <button key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => handleAddFromTemplate(key)}>{t("script_template_" + key) || tpl.name}</button>
          ))}
        </div>
      </div>

      {/* Test panel */}
      <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
        <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_test_panel")}</div>
        <div className="flex gap-2.5">
          <input className="h-9 flex-1 rounded-md border border-border bg-bg px-3 font-ui text-t1 outline-none" value={testInput} onChange={e => setTestInput(e.target.value)} onKeyDown={e => e.key === "Enter" && runTest()} placeholder={t("script_test_input_placeholder")} />
          <button className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={runTest}>{t("script_test_run")}</button>
        </div>
        {testResult && (
          <div className="mt-3 space-y-2">
            {testResult.errors.length > 0 && (
              <div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
                <div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_test_error")}</div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{testResult.errors.join("\n")}</pre>
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
        {testMut.isPending && <div className="mt-3 text-center font-ui text-[12px] text-t3">Running...</div>}
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center text-t3 font-ui text-[13px] italic">
      {t("script_test_no_result")}
    </div>
  );

  return { modals, scriptListContent, scriptEditorPanel, activeScriptId, setActiveScriptId, handleAdd, handleImportOpen: () => setImportOpen(true) };
}
