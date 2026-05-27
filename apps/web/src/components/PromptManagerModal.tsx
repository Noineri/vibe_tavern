import { useEffect, useState } from "react";
import type { PromptPresetDto } from "@vibe-tavern/domain";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";
import { Modal } from "./shared/Modal.js";
import { ConfirmCloseModal } from "./shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { useIsMobile } from "../hooks/use-mobile.js";
import { Icons } from "./shared/icons.js";
import { SaveButton } from "./shared/SaveBar.js";
import { useModalStore } from "../stores/modal-store.js";
import { PresetList, PromptFields } from "./prompt/index.js";
import { InjectionTable } from "./prompt/InjectionTable.js";
import { Toggle } from "./shared/Toggle.js";
import { PresetImportModal, type PresetImportResult } from "./PresetImportModal.js";
import { CustomTooltip } from "./shared/Tooltip.js";

type SaveState = "idle" | "saving" | "saved" | "error";

type DraftData = {
  name: string;
  bindModel: string;
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  summary: string;
  tools: string;
  scriptAiSystemPrompt: string;
  customInjections: Array<{ name: string; content: string; depth: number; role: 'system' | 'user' | 'assistant'; enabled: boolean }>;
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
    summary?: string;
    tools?: string;
    scriptAiSystemPrompt?: string;
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
  prefill: "", authorsNote: "", authorsNoteDepth: 4, summary: "", tools: "", scriptAiSystemPrompt: "",
  customInjections: [],
};

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
  const [advancedMode, setAdvancedMode] = useState(false);
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
        summary: activePreset.summary,
        tools: activePreset.tools,
        scriptAiSystemPrompt: activePreset.scriptAiSystemPrompt ?? "",
        customInjections: (activePreset as PromptPresetDto).customInjections ?? [],
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
    void input.onUpdate(input.activePresetId, draft).then((ok) => {
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
      summary: "",
      tools: "",
      scriptAiSystemPrompt: "",
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
    setDraft((d) => {
      const next = { ...d };
      if (result.system.length) next.system = d.system + (d.system ? "\n\n" : "") + result.system.join("\n\n");
      if (result.post.length) next.jailbreak = d.jailbreak + (d.jailbreak ? "\n\n" : "") + result.post.join("\n\n");
      if (result.authors.length) next.authorsNote = d.authorsNote + (d.authorsNote ? "\n\n" : "") + result.authors.join("\n\n");
      if (result.injections.length) next.customInjections = [...d.customInjections, ...result.injections];
      return next;
    });
    setDirty(true);
    setSaveState("idle");
    setImportModalOpen(false);
  };

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
        className={cn("flex flex-col overflow-hidden bg-surface", isMobile ? "w-full h-full" : "max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] w-[880px] h-[760px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={cn("shrink-0 items-start justify-between border-b border-border", isMobile ? "flex pt-4 px-4 pb-3" : "flex pt-[18px] px-5 pb-[14px]")}>
          <div className="flex items-center gap-2">
            {isMobile && mobileDetailOpen && (
              <button className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-t3 active:bg-s2" onClick={() => setMobileDetailOpen(false)}>
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
            {/* Advanced mode accordion */}
            <details open={advancedMode} onToggle={(e) => setAdvancedMode((e.target as HTMLDetailsElement).open)} className="mx-5 mt-4">
              <summary className="flex cursor-pointer items-center gap-3 rounded-md border border-border2 bg-s2 px-4 py-3 select-none">
                <Toggle checked={advancedMode} onChange={setAdvancedMode} />
                <div>
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t2">{t("preset_advanced_mode")}</span>
                  <span className="ml-2 font-ui text-[11px] text-t4">{t("preset_advanced_mode_hint")}</span>
                </div>
              </summary>
              <div className="rounded-b-md border-x border-b border-border2 bg-s1 px-4 py-3">
                <InjectionTable
                  injections={draft.customInjections}
                  onChange={(injections) => { setDraft((d) => ({ ...d, customInjections: injections })); setDirty(true); setSaveState("idle"); }}
                />
              </div>
            </details>

            <PromptFields
              draft={activePreset ? draft : null}
              onUpdateField={updateDraft}
              prefillSupported={input.prefillSupported}
              resetKey={activePreset?.id ?? null}
            />
          </div>
          )}
        </div>

        {(!isMobile || mobileDetailOpen) && (
        <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "py-2.5 px-3" : "py-3.5 px-5")}>
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
          <div className="ml-auto flex items-center gap-2.5">
            {!isMobile && (
            <button
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
