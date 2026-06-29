import { useEffect, useState } from "react";
import type { CustomInjection, PromptOrderEntry, PromptPresetDto } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Icons } from "../shared/icons.js";
import { SaveButton } from "../shared/SaveBar.js";
import { useModalStore } from "../../stores/modal-store.js";
import { PresetList, PromptFields } from "../settings/prompt/index.js";
import { PromptOrderCanvas, type CharacterCanvasDraft } from "../settings/prompt/InjectionTable.js";
import { PresetImportModal, type PresetImportResult } from "./PresetImportModal.js";
import { serializeStPreset, type VibeTavernPresetExtension } from "../../lib/st-preset-parser.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";

type SaveState = "idle" | "saving" | "saved" | "error";

type DraftData = {
  name: string;
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: "in_prompt" | "in_chat" | "after_chat";
  authorsNoteRole: "system" | "user" | "assistant";
  summary: string;
  tools: string;
  nsfw: string;
  enhanceDefinitions: string;
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: Record<string, string>;
  customInjections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  advancedMode: boolean;
};

interface PromptManagerModalProps {
  presets: PromptPresetDto[];
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
  onCreate: (input: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">> & { name: string }) => Promise<{ id: string } | null>;
  onUpdate: (
    presetId: string,
    patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>
  ) => Promise<boolean>;
  onDelete: (presetId: string) => Promise<boolean>;
  providerProfiles?: Array<{ id: string; name: string }>;
  prefillSupported?: boolean;
  characterFields?: {
    systemPrompt: string | null;
    postHistoryInstructions: string | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
  } | null;
  onCharacterFieldUpdate?: (key: string, value: string | number) => void;
}

const emptyDraft: DraftData = {
  name: "", system: "", jailbreak: "",
  prefill: "", authorsNote: "", authorsNoteDepth: 4, authorsNotePosition: "in_chat", authorsNoteRole: "system", summary: "", tools: "", nsfw: "", enhanceDefinitions: "", scriptAiSystemPrompt: "",
  aiAssistantPrompts: {},
  customInjections: [],
  promptOrder: [],
  advancedMode: false,
};

function mergePromptOrder(current: PromptOrderEntry[], imported: PromptOrderEntry[]): PromptOrderEntry[] {
  const map = new Map(current.map((entry) => [entry.identifier, entry]));
  for (const entry of imported) {
    map.set(entry.identifier, { ...map.get(entry.identifier), ...entry });
  }
  return Array.from(map.values()).sort((a, b) => (a.order ?? 10_000) - (b.order ?? 10_000));
}

function parseAiAssistantPrompts(raw: string | undefined | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>;
    }
  } catch { /* ignore */ }
  return {};
}

export function PromptManagerModal(input: PromptManagerModalProps) {
  const isOpen = useModalStore((s) => s.isPromptManagerOpen);
  const setIsOpen = useModalStore((s) => s.setIsPromptManagerOpen);
  const onClose = () => setIsOpen(false);
  const { t } = useT();
  const [draft, setDraft] = useState<DraftData>({ ...emptyDraft });
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // Character V3 fields → canvas draft (mutable state)
  const [characterDraft, setCharacterDraft] = useState<CharacterCanvasDraft | null>(() =>
    input.characterFields ? {
      charSystemPrompt: input.characterFields.systemPrompt ?? "",
      charPostHistory: input.characterFields.postHistoryInstructions ?? "",
      charDepthPrompt: input.characterFields.depthPrompt ?? "",
      charDepthPromptDepth: input.characterFields.depthPromptDepth ?? 4,
      charDepthPromptRole: input.characterFields.depthPromptRole ?? "system",
    } : null
  );

  // Sync character draft when characterFields prop changes (different character selected)
  useEffect(() => {
    setCharacterDraft(input.characterFields ? {
      charSystemPrompt: input.characterFields.systemPrompt ?? "",
      charPostHistory: input.characterFields.postHistoryInstructions ?? "",
      charDepthPrompt: input.characterFields.depthPrompt ?? "",
      charDepthPromptDepth: input.characterFields.depthPromptDepth ?? 4,
      charDepthPromptRole: input.characterFields.depthPromptRole ?? "system",
    } : null);
  }, [input.characterFields?.systemPrompt, input.characterFields?.postHistoryInstructions, input.characterFields?.depthPrompt, input.characterFields?.depthPromptDepth, input.characterFields?.depthPromptRole]);

  function updateCharacterDraft(key: string, value: string | number) {
    setCharacterDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: value };
    });
    setDirty(true);
    setSaveState("idle");
  }
  const [importModalOpen, setImportModalOpen] = useState(false);
  const isMobile = useIsMobile();
  const activePreset = input.presets.find((p) => p.id === input.activePresetId) ?? null;

  useEffect(() => {
    if (activePreset) {
      setDraft({
        name: activePreset.name,
        system: activePreset.system,
        jailbreak: activePreset.jailbreak,
        prefill: activePreset.prefill ?? "",
        authorsNote: activePreset.authorsNote ?? "",
        authorsNoteDepth: activePreset.authorsNoteDepth ?? 4,
        authorsNotePosition: activePreset.authorsNotePosition ?? "in_chat",
        authorsNoteRole: activePreset.authorsNoteRole ?? "system",
        summary: activePreset.summary,
        tools: activePreset.tools,
        nsfw: activePreset.nsfw ?? "",
        enhanceDefinitions: activePreset.enhanceDefinitions ?? "",
        scriptAiSystemPrompt: activePreset.scriptAiSystemPrompt ?? "",
        aiAssistantPrompts: parseAiAssistantPrompts(activePreset.aiAssistantPrompts),
        customInjections: (activePreset as PromptPresetDto).customInjections ?? [],
        promptOrder: activePreset.promptOrder ?? [],
        advancedMode: activePreset.advancedMode ?? false,
      });
    } else {
      setDraft({ ...emptyDraft });
    }
    setDirty(false);
    setSaveState("idle");
  }, [activePreset?.id]);

  function updateDraft<K extends keyof DraftData>(key: K, value: DraftData[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaveState("idle");
  }

  if (!isOpen) return null;

  const handleClose = () => {
    if (dirty) {
      setConfirmCloseOpen(true);
    } else {
      onClose();
    }
  };

  const handleSave = () => {
    if (!input.activePresetId || !dirty) return;
    setSaveState("saving");
    const patch = {
      ...draft,
      aiAssistantPrompts: JSON.stringify(draft.aiAssistantPrompts),
    };
    void input.onUpdate(input.activePresetId, patch).then((ok) => {
      if (!ok) {
        setSaveState("error");
        return;
      }
      // Persist character field changes via API
      if (characterDraft && input.onCharacterFieldUpdate) {
        const orig = input.characterFields;
        if (orig) {
          if (characterDraft.charSystemPrompt !== (orig.systemPrompt ?? "")) input.onCharacterFieldUpdate("charSystemPrompt", characterDraft.charSystemPrompt);
          if (characterDraft.charPostHistory !== (orig.postHistoryInstructions ?? "")) input.onCharacterFieldUpdate("charPostHistory", characterDraft.charPostHistory);
          if (characterDraft.charDepthPrompt !== (orig.depthPrompt ?? "")) input.onCharacterFieldUpdate("charDepthPrompt", characterDraft.charDepthPrompt);
          if (characterDraft.charDepthPromptDepth !== (orig.depthPromptDepth ?? 4)) input.onCharacterFieldUpdate("charDepthPromptDepth", characterDraft.charDepthPromptDepth);
          if (characterDraft.charDepthPromptRole !== (orig.depthPromptRole ?? "system")) input.onCharacterFieldUpdate("charDepthPromptRole", characterDraft.charDepthPromptRole);
        }
      }
      setDirty(false);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    });
  };

  const handleDuplicate = () => {
    // draft.aiAssistantPrompts is a parsed Record; onCreate expects the JSON
    // string the DTO/API store (matches handleSave's stringification).
    void input.onCreate({ ...draft, aiAssistantPrompts: JSON.stringify(draft.aiAssistantPrompts), name: `${draft.name || t("presets")} (copy)` }).then((created) => {
      if (created?.id) input.setActivePresetId(created.id);
    });
  };

  const handleExportPreset = () => {
    if (!activePreset) return;
    // Export the SAVED preset (full DTO), not the possibly-dirty draft — a
    // shareable file should represent persisted state. Users save first to
    // export edits (Save sits right next to this action).
    const json = serializeStPreset(activePreset);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activePreset.name || "preset").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAdd = (name: string) => {
    void input.onCreate({
      name,
      system: "",
      jailbreak: "",
      prefill: "",
      authorsNote: "",
      authorsNoteDepth: 4,
      authorsNotePosition: "in_chat",
      authorsNoteRole: "system",
      summary: "",
      tools: "",
      scriptAiSystemPrompt: "",
      promptOrder: [],
      advancedMode: false,
    }).then((created) => {
      if (created?.id) input.setActivePresetId(created.id);
    });
  };

  const handleRename = (presetId: string, newName: string) => {
    void input.onUpdate(presetId, { name: newName }).then((ok) => {
      if (ok && presetId === input.activePresetId) {
        setDraft((current) => ({ ...current, name: newName }));
      }
    });
  };

  const handleConfirmDelete = () => {
    if (!input.activePresetId) return;
    const deleteId = input.activePresetId;
    const remaining = input.presets.filter((p) => p.id !== deleteId);
    const fallbackId = remaining.length > 0 ? remaining[0].id : null;
    input.setActivePresetId(fallbackId);
    setConfirmDeleteOpen(false);
    setDirty(false);
    setSaveState("idle");
    void input.onDelete(deleteId);
  };

  const handleImportPreset = (result: PresetImportResult) => {
    // Lossless path: the file was exported by Vibe Tavern and carries the full
    // DTO under _vibe_tavern. Restore every field directly (no block projection,
    // no merge) — this is the only path that preserves VT-only fields
    // (aiAssistantPrompts, scriptAiSystemPrompt, tools, summary, prefill) and
    // exact canvas positions for built-in slots.
    if (result.vibeTavern) {
      const ext = result.vibeTavern;
      if (result.target === 'new') {
        void input.onCreate({
          ...ext,
          name: result.newPresetName || ext.name,
        }).then((created) => {
          if (created?.id) input.setActivePresetId(created.id);
        });
      } else {
        // Replace the current preset's editable fields wholesale (reviewed via
        // the draft; user clicks Save to commit, so it is not immediately
        // destructive). aiAssistantPrompts is a JSON string in the DTO but a
        // parsed Record in the draft — convert via the same helper the load
        // path uses.
        setDraft({
          name: ext.name,
          system: ext.system,
          jailbreak: ext.jailbreak,
          prefill: ext.prefill,
          authorsNote: ext.authorsNote,
          authorsNoteDepth: ext.authorsNoteDepth,
          authorsNotePosition: ext.authorsNotePosition,
          authorsNoteRole: ext.authorsNoteRole,
          summary: ext.summary,
          tools: ext.tools,
          nsfw: ext.nsfw,
          enhanceDefinitions: ext.enhanceDefinitions,
          scriptAiSystemPrompt: ext.scriptAiSystemPrompt,
          aiAssistantPrompts: parseAiAssistantPrompts(ext.aiAssistantPrompts),
          customInjections: ext.customInjections,
          promptOrder: ext.promptOrder,
          advancedMode: ext.advancedMode,
        });
        setDirty(true);
        setSaveState("idle");
      }
      setImportModalOpen(false);
      return;
    }
    if (result.target === 'new') {
      const name = result.newPresetName || `${t('imported_preset')} ${new Date().toLocaleDateString()}`;
      void input.onCreate({
        name,
        system: result.system.join("\n\n"),
        jailbreak: result.post.join("\n\n"),
        authorsNote: result.authors.join("\n\n"),
        nsfw: result.nsfw.join("\n\n"),
        enhanceDefinitions: result.enhanceDefinitions.join("\n\n"),
        prefill: "",
        authorsNoteDepth: 4,
        authorsNotePosition: "in_chat",
        authorsNoteRole: result.authorsRole ?? "system",
        summary: "",
        tools: "",
        scriptAiSystemPrompt: "",
        customInjections: result.injections,
        promptOrder: result.promptOrder,
        advancedMode: true,
      }).then((created) => {
        if (created?.id) input.setActivePresetId(created.id);
      });
    } else {
      setDraft((d) => {
        const next = { ...d };
        if (result.system.length) next.system = d.system + (d.system ? "\n\n" : "") + result.system.join("\n\n");
        if (result.post.length) next.jailbreak = d.jailbreak + (d.jailbreak ? "\n\n" : "") + result.post.join("\n\n");
        if (result.authors.length) {
          next.authorsNote = d.authorsNote + (d.authorsNote ? "\n\n" : "") + result.authors.join("\n\n");
          next.authorsNoteRole = result.authorsRole ?? d.authorsNoteRole;
        }
        if (result.nsfw.length) next.nsfw = d.nsfw + (d.nsfw ? "\n\n" : "") + result.nsfw.join("\n\n");
        if (result.enhanceDefinitions.length) next.enhanceDefinitions = d.enhanceDefinitions + (d.enhanceDefinitions ? "\n\n" : "") + result.enhanceDefinitions.join("\n\n");
        if (result.injections.length) next.customInjections = [...d.customInjections, ...result.injections];
        if (result.promptOrder.length) next.promptOrder = mergePromptOrder(d.promptOrder, result.promptOrder);
        if (result.injections.length || result.promptOrder.length) next.advancedMode = true;
        return next;
      });
      setDirty(true);
      setSaveState("idle");
    }
    setImportModalOpen(false);
  };

  const advancedMode = draft.advancedMode;

  return (
    <>
      {importModalOpen && (
        <PresetImportModal
          onClose={() => setImportModalOpen(false)}
          onImport={handleImportPreset}
        />
      )}

      {confirmCloseOpen && (
        <ConfirmCloseModal
          onCancel={() => setConfirmCloseOpen(false)}
          onConfirm={() => {
            setDirty(false);
            setSaveState("idle");
            setConfirmCloseOpen(false);
            onClose();
          }}
        />
      )}
      {confirmDeleteOpen && (
        <DestructiveConfirmModal
          title={t("delete_preset_title")}
          body={
            <>
              {t("delete_preset_body").replace("{name}", activePreset?.name || t("unnamed"))}
            </>
          }
          confirmLabel={t("delete_preset")}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}

      <MasterDetailModal
        isOpen={true}
        onClose={handleClose}
        title={t("prompt_manager_title")}
        subtitle={t("prompt_manager_sub")}
        detailTitle={t("prompt_manager_title")}
        dirty={dirty}
        containerClassName="max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] w-[920px] h-[880px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        masterClassName="flex w-[240px] shrink-0 flex-col border-r border-border bg-s1"
        detailClassName="p-0"
        headerClassName={isMobile ? "px-4 pt-4 pb-3" : "px-5 pt-[18px] pb-[14px]"}
        masterContent={() => (
          <PresetList
            presets={input.presets.map((p) => ({ id: p.id, name: p.name }))}
            activePresetId={input.activePresetId}
            onSelect={(id) => { input.setActivePresetId(id); }}
            onAdd={handleAdd}
            onRename={handleRename}
            onImportPreset={() => setImportModalOpen(true)}
          />
        )}
        detailContent={
          <>
            <div className={cn("mt-4 flex shrink-0 items-center justify-between gap-3", isMobile ? "mx-3" : "mx-5")}>
              <div>
                <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">
                  {advancedMode ? t("preset_advanced_mode") : t("preset_simple_mode")}
                </div>
                <div className="mt-0.5 font-ui text-[11px] text-t4">
                  {advancedMode ? t("preset_advanced_mode_hint") : t("preset_simple_mode_hint")}
                </div>
              </div>
              <div className="inline-flex shrink-0 gap-0 rounded-md border border-border bg-s3 p-0.5" role="radiogroup" aria-label={t("preset_editor_mode")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!advancedMode}
                  className={cn(
                    "cursor-pointer select-none rounded-[5px] px-2.5 py-1 font-ui text-[11px] transition-all duration-150",
                    !advancedMode ? "bg-s2 font-medium text-accent shadow-sm" : "text-t2 hover:text-t1",
                  )}
                  onClick={() => { if (advancedMode) updateDraft("advancedMode", false); }}
                >
                  {t("preset_simple_mode_short")}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={advancedMode}
                  className={cn(
                    "cursor-pointer select-none rounded-[5px] px-2.5 py-1 font-ui text-[11px] transition-all duration-150",
                    advancedMode ? "bg-s2 font-medium text-accent shadow-sm" : "text-t2 hover:text-t1",
                  )}
                  onClick={() => { if (!advancedMode) updateDraft("advancedMode", true); }}
                >
                  {t("preset_advanced_mode_short")}
                </button>
              </div>
            </div>

            {advancedMode && (
              <div className={cn("mt-3 rounded-md border border-border2 bg-s1 py-3", isMobile ? "mx-3 px-2.5" : "mx-5 px-4")}>
                <PromptOrderCanvas
                  injections={draft.customInjections}
                  onChange={(injections) => { setDraft((d) => ({ ...d, customInjections: injections })); setDirty(true); setSaveState("idle"); }}
                  promptOrder={draft.promptOrder}
                  onPromptOrderChange={(promptOrder) => { setDraft((d) => ({ ...d, promptOrder })); setDirty(true); setSaveState("idle"); }}
                  draft={activePreset ? draft : null}
                  onUpdateField={(key, value) => updateDraft(key, value as never)}
                  characterDraft={characterDraft}
                  onCharacterFieldUpdate={(key, value) => updateCharacterDraft(key, value)}
                />
              </div>
            )}

            <PromptFields
              draft={activePreset ? draft : null}
              onUpdateField={updateDraft}
              prefillSupported={input.prefillSupported}
              resetKey={activePreset?.id ?? null}
              hideChatPrompts={advancedMode}
            />
          </>
        }
        footer={
          <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "flex-wrap px-3 py-2.5" : "py-3.5 px-5")}>
            {activePreset && isMobile && (
            <button type="button"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-t3 active:bg-s2"
              onClick={handleDuplicate}
              aria-label={t("duplicate_preset_btn")}
            >
              <Icons.Copy />
            </button>
            )}
            {activePreset && !isMobile && (
            <span
              className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
              onClick={handleDuplicate}
            >
              <Icons.Copy /> {t("duplicate_preset_btn")}
            </span>
            )}
            {activePreset && isMobile && (
            <button type="button"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-t3 active:bg-s2"
              onClick={handleExportPreset}
              aria-label={t("export_preset_btn")}
            >
              <Icons.Download />
            </button>
            )}
            {activePreset && !isMobile && (
            <span
              className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
              onClick={handleExportPreset}
            >
              <Icons.Download /> {t("export_preset_btn")}
            </span>
            )}
            {activePreset && input.presets.length > 1 && isMobile && (
            <button type="button"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-t3 active:bg-s2"
              onClick={() => setConfirmDeleteOpen(true)}
              aria-label={t("delete_preset")}
            >
              <Icons.Trash />
            </button>
            )}
            {activePreset && input.presets.length > 1 && !isMobile && (
              <span
                className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
                onClick={() => setConfirmDeleteOpen(true)}
              >
                <Icons.Trash /> {t("delete_preset")}
              </span>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-2.5">
              {!isMobile && (
              <button type="button"
                className="h-[37px] cursor-pointer rounded-md border border-border bg-surface py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1"
                onClick={handleClose}
              >
                {t("close")}
              </button>
              )}
              <SaveButton
                dirty={dirty}
                saveState={saveState}
                onClick={handleSave}
                label={t("save")}
              />
            </div>
          </div>
        }
      />
    </>
  );
}
