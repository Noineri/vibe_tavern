import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ic } from "../shared/icons.js";
import { CodeEditor } from "../shared/CodeEditor.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
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
  relationship: { name: "Relationship Progression", code: "/**\n * Dynamic Relationship Progression\n * Character's behavior evolves based on conversation length\n */\nconst count = context.chat.messageCount;\nif (count < 5) {\n  context.character.personality += ', polite but maintains professional distance';\n  context.character.scenario += ' This is their first meeting, so they are careful and observant.';\n} else if (count < 15) {\n  context.character.personality += ', becoming more comfortable and casual';\n  context.character.scenario += ' They are warming up and becoming more relaxed in conversation.';\n} else if (count < 30) {\n  context.character.personality += ', friendly and open';\n  context.character.scenario += ' They feel comfortable and speak openly as friends.';\n} else {\n  context.character.personality += ', trusting and deeply connected';\n  context.character.scenario += ' They share a deep friendship and trust completely.';\n}" },
  events: { name: "Scenario Events", code: "/**\n * Dynamic Scenario Events\n * Triggers changes based on keywords in the last message\n */\nconst last = context.chat.lastMessage.toLowerCase();\n\n// Location-based events\nif (last.includes('restaurant') || last.includes('cafe')) {\n  context.character.scenario += ' The cozy establishment has ambient sounds of clinking dishes and soft music.';\n  context.character.personality += ', notices and comments on the atmosphere around them';\n}\nif (last.includes('park') || last.includes('outside')) {\n  context.character.scenario += ' They are outdoors with natural surroundings and fresh air.';\n  context.character.personality += ', observant of nature and weather';\n}\n\n// Milestone events\nif (context.chat.messageCount === 10) {\n  context.character.scenario += ' Suddenly, their phone rings with an unexpected call.';\n}\n\n// Keyword-triggered\nif (last.includes('secret')) {\n  context.character.personality += ', becomes mysterious when secrets are mentioned';\n  context.character.scenario += ' {{char}} becomes slightly more thoughtful.';\n}" },
  memory: { name: "Conversation Memory", code: "/**\n * Conversation Memory System\n * Character remembers interests mentioned earlier\n */\nif (context.chat.messageCount < 10) return;\n\nconst last = context.chat.lastMessage.toLowerCase();\n\n// Detect hobbies mentioned\nconst hobbies = ['reading', 'gaming', 'cooking', 'sports', 'art', 'music'];\nconst mentioned = hobbies.filter(h => last.includes(h));\n\nif (mentioned.length > 0) {\n  context.character.personality += ', remembers {{user}}\\'s interest in ' + mentioned.join(' and ');\n  context.character.scenario += ' {{char}} shows interest in ' + mentioned.join(' and ') + ' topics.';\n}\n\n// Detect preference expressions\nif (last.includes('favorite') || last.includes('love') || last.includes('like')) {\n  context.character.personality += ', attentive to {{user}}\\'s preferences and opinions';\n}\n" },
  lorebook: { name: "Dynamic Lorebook", code: "/**\n * Dynamic Lorebook System\n * Character reveals backstory based on keywords\n */\nconst last = context.chat.lastMessage.toLowerCase();\n\n// Fantasy/Magic lore\nif (last.includes('magic') || last.includes('spell') || last.includes('wizard')) {\n  context.character.personality += ', knowledgeable about magical arts and ancient spells';\n  context.character.scenario += ' {{char}} has studied magic for years and can sense magical energies.';\n}\n\n// Historical lore\nif (last.includes('war') || last.includes('battle') || last.includes('soldier')) {\n  context.character.personality += ', haunted by memories of past conflicts';\n  context.character.scenario += ' {{char}} served in the Great War and bears visible and invisible scars.';\n}\n\n// Location lore\nif (last.includes('forest') || last.includes('woods')) {\n  context.character.personality += ', deeply connected to nature and forest spirits';\n  context.character.scenario += ' {{char}} spent their youth in the Whispering Woods, learning druidic ways.';\n}\n\n// Secret lore — only after some trust is built\nif (context.chat.messageCount > 15) {\n  if (last.includes('secret') || last.includes('hidden') || last.includes('truth')) {\n    context.character.personality += ', keeper of ancient secrets that could change everything';\n    context.character.scenario += ' {{char}} knows the truth about the Sundering, but speaks of it only in whispers.';\n  }\n}" },
  hp: { name: "HP Tracker", code: "/**\n * HP Tracker\n * Persistent health system with damage/healing\n */\nconst hp = context.state.get('hp', 100);\nconst last = context.chat.lastMessage.toLowerCase();\nlet newHp = hp;\n\n// Take damage\nif (last.includes('hit') || last.includes('attack')) {\n  const dmg = Math.floor(Math.random() * 15) + 5;\n  newHp = Math.max(0, hp - dmg);\n  context.state.set('hp', newHp);\n  context.character.personality += '\\n[HP] ' + newHp + '/100 (took ' + dmg + ' damage)';\n}\n\n// Heal\nif (last.includes('heal') || last.includes('potion')) {\n  const heal = Math.floor(Math.random() * 20) + 10;\n  newHp = Math.min(100, hp + heal);\n  context.state.set('hp', newHp);\n  context.character.personality += '\\n[HP] ' + newHp + '/100 (healed ' + heal + ')';\n}\n\n// Critical state\nif (newHp <= 20 && newHp > 0) {\n  context.character.scenario += ' {{char}} is badly wounded and struggling to stay standing.';\n}\nif (newHp === 0) {\n  context.character.scenario += ' {{char}} has collapsed from their injuries.';\n}\n" },
  random: { name: "Random Event", code: "/**\n * Random Event (5% chance each turn)\n * Adds ambient flavor to the scene\n */\nif (Math.random() < 0.05) {\n  const events = [\n    'A sudden gust of wind scatters papers nearby.',\n    'A distant bell chimes echoes through the air.',\n    'The ground trembles briefly beneath their feet.',\n    'A strange aroma drifts in from somewhere unseen.',\n    'A bird lands nearby and watches curiously.',\n    'The lights flicker for a moment.'\n  ];\n  const event = events[Math.floor(Math.random() * events.length)];\n  context.character.scenario += '\\n[EVENT] ' + event;\n}" },
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
                      <DropdownSelect
                        value={aiProviderId}
                        options={providerProfiles.map(p => ({ id: p.id, label: p.name }))}
                        placeholder={t("script_ai_select_provider")}
                        searchPlaceholder={t("script_ai_search_provider")}
                        onChange={id => { setAiProviderId(id); setAiModelName(""); }}
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
                        onChange={id => setAiModelName(id)}
                        disabled={!aiProviderId}
                      />
                    </div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_prompt")}</label>
                    <textarea className="w-full min-h-[100px] rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none" placeholder={t("script_ai_prompt")} value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} />
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
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_api_context")}</div>
          <div className="grid gap-3 text-[12px]">
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_chat")}</div>
              <div className="grid gap-1">
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.lastMessage</code><span className="text-t3">— {t("script_api_chat_lastMessage")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.messages</code><span className="text-t3">— {t("script_api_chat_messages")}</span></div>
                <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.chat.messageCount</code><span className="text-t3">— {t("script_api_chat_messageCount")}</span></div>
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
          <CodeEditor value={activeScript.code ?? ""} onChange={v => updateField("code", v)} minHeight="300px" />
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
