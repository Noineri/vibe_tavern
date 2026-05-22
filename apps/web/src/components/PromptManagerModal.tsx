import { useEffect, useState } from "react";
import type { PromptPresetDto } from "@rp-platform/domain";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";
import { ConfirmCloseModal } from "./shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { Icons } from "./shared/icons.js";
import { SaveButton } from "./shared/SaveBar.js";
import { useModalStore } from "../stores/modal-store.js";
import { PresetList, PromptFields } from "./prompt/index.js";

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

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
    >
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
        className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] w-[880px] h-[760px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between border-b border-border pt-[18px] px-5 pb-[14px]">
          <div>
            <div className="font-body mb-0.5 text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
              {t("prompt_manager_title")}
              {dirty && (
                <span
                  className="ml-1.5 inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-accent align-middle"
                  title={t("unsaved_changes_title")}
                />
              )}
            </div>
            <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
              {t("prompt_manager_sub")}
            </div>
          </div>
          <div
            className="flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1"
            onClick={handleClose}
          >
            <Icons.Close />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <PresetList
            presets={input.presets.map((p) => ({ id: p.id, name: p.name }))}
            activePresetId={input.activePresetId}
            onSelect={(id) => input.setActivePresetId(id)}
            onAdd={handleAdd}
            onRename={handleRename}
          />
          <PromptFields
            draft={activePreset ? draft : null}
            onUpdateField={updateDraft}
            prefillSupported={input.prefillSupported}
            resetKey={activePreset?.id ?? null}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2.5 border-t border-border py-3.5 px-5">
          <span
            className={cn(
              "flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1",
              !activePreset && "pointer-events-none opacity-45"
            )}
            onClick={activePreset ? handleDuplicate : undefined}
          >
            <Icons.Copy /> {t("duplicate_preset")}
          </span>
          {activePreset && input.presets.length > 1 && (
            <span
              className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
              onClick={() => setConfirmDeleteOpen(true)}
            >
              <Icons.Trash /> {t("delete_preset")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <button
              className="h-[37px] cursor-pointer rounded-md border border-border bg-surface py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={handleClose}
            >
              {t("close")}
            </button>
            <SaveButton
              dirty={dirty}
              saveState={saveState}
              onClick={handleSave}
              label={t("save")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
