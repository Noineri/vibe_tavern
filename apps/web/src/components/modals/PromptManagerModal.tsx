import { useEffect, useState } from "react";
import type { PromptOrderEntry, PromptPresetDto } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { Modal } from "../shared/Modal.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Icons } from "../shared/icons.js";
import { SaveButton } from "../shared/SaveBar.js";
import { useModalStore } from "../../stores/modal-store.js";
import { PresetList, PromptFields } from "../settings/prompt/index.js";
import { PromptOrderCanvas, type InjectionRow } from "../settings/prompt/InjectionTable.js";
import { PresetImportModal, type PresetImportResult } from "./PresetImportModal.js";
import { CustomTooltip } from "../shared/Tooltip.js";

type SaveState = "idle" | "saving" | "saved" | "error";

type DraftData = {
  name: string;
  bindModel: string;
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
  customInjections: InjectionRow[];
  promptOrder: PromptOrderEntry[];
  advancedMode: boolean;
};

interface PromptManagerModalProps {
  presets: PromptPresetDto[];
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
  onCreate: (input: {
    name: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    prefill?: string;
    authorsNote?: string;
    authorsNoteDepth?: number;
    authorsNotePosition?: "in_prompt" | "in_chat" | "after_chat";
    authorsNoteRole?: "system" | "user" | "assistant";
    summary?: string;
    tools?: string;
    nsfw?: string;
    enhanceDefinitions?: string;
    scriptAiSystemPrompt?: string;
    customInjections?: InjectionRow[];
    promptOrder?: PromptOrderEntry[];
    advancedMode?: boolean;
  }) => Promise<{ id: string } | null>;
  onUpdate: (
    presetId: string,
    patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>
  ) => Promise<boolean>;
  onDelete: (presetId: string) => Promise<boolean>;
  providerProfiles?: Array<{ id: string; name: string }>;
  prefillSupported?: boolean;
}

const emptyDraft: DraftData = {
  name: "", bindModel: "", system: "", jailbreak: "",
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
  const [importModalOpen, setImportModalOpen] = useState(false);
  const isMobile = useIsMobile();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const activePreset = input.presets.find((p) => p.id === input.activePresetId) ?? null;

  useEffect(() => {
    if (activePreset) {
      setDraft({
        name: activePreset.name,
        bindModel: activePreset.bindModel,
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
      setDirty(false);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    });
  };

  const handleDuplicate = () => {
    void input.onCreate({ ...draft, name: `${draft.name || t("presets")} (copy)` }).then((created) => {
      if (created?.id) input.setActivePresetId(created.id);
    });
  };

  const handleAdd = (name: string) => {
    void input.onCreate({
      name,
      bindModel: "",
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
    setMobileDetailOpen(false);
    void input.onDelete(deleteId);
  };

  const handleImportPreset = (result: PresetImportResult) => {
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
    <Modal open={true} onClose={handleClose}>
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

      <div
        className={cn("flex flex-col overflow-hidden bg-surface", isMobile ? "w-full h-full" : "max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] w-[880px] h-[840px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={cn("shrink-0 items-start justify-between border-b border-border", isMobile ? "flex pt-4 px-4 pb-3" : "flex pt-[18px] px-5 pb-[14px]")}>
          <div className="flex items-center gap-2">
            {isMobile && mobileDetailOpen && (
              <button type="button" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-t3 active:bg-s2" onClick={() => setMobileDetailOpen(false)}>
                <Icons.Caret direction="l" />
              </button>
            )}
            <div>
              <div className={cn("font-body font-medium text-t1", isMobile ? "text-base" : "text-[calc(var(--ui-fs)+4px)] mb-0.5")}>
                {t("prompt_manager_title")}
                {dirty && (
                  <CustomTooltip content={t("unsaved_changes_title")}>
                  <span
                    className="ml-1.5 inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-accent align-middle"
                  />
                  </CustomTooltip>
                )}
              </div>
              {!isMobile && (
              <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
                {t("prompt_manager_sub")}
              </div>
              )}
            </div>
          </div>
          <div
            className={cn("shrink-0 cursor-pointer items-center justify-center text-t3 transition-all hover:bg-s2 hover:text-t1", isMobile ? "flex h-10 w-10 rounded-lg active:bg-s2" : "flex h-[32px] w-[32px] rounded-[5px]")}
            onClick={handleClose}
          >
            <Icons.Close />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {(!isMobile || !mobileDetailOpen) && (
          <PresetList
            presets={input.presets.map((p) => ({ id: p.id, name: p.name }))}
            activePresetId={input.activePresetId}
            onSelect={(id) => { input.setActivePresetId(id); }}
            onDrillDown={(id) => { input.setActivePresetId(id); if (isMobile) setMobileDetailOpen(true); }}
            onAdd={handleAdd}
            onRename={handleRename}
            onImportPreset={() => setImportModalOpen(true)}
          />
          )}
          {(!isMobile || mobileDetailOpen) && (
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
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
          </div>
          )}
        </div>

        {(!isMobile || mobileDetailOpen) && (
        <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "flex-wrap px-3 py-2.5" : "py-3.5 px-5")}>
          {activePreset && (
          <span
            className={cn("flex cursor-pointer items-center gap-1 font-ui text-t3 transition-all hover:text-t1", isMobile ? "text-[12px]" : "text-[calc(var(--ui-fs)-2px)]")}
            onClick={handleDuplicate}
          >
            <Icons.Copy /> {t("duplicate_preset_btn")}
          </span>
          )}
          {activePreset && input.presets.length > 1 && (
            <span
              className={cn("flex cursor-pointer items-center gap-1 font-ui text-t3 transition-all hover:text-t1", isMobile ? "text-[12px]" : "text-[calc(var(--ui-fs)-2px)]")}
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
        )}
      </div>
    </Modal>
  );
}
