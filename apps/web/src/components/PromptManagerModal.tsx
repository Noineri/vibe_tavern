import { useEffect, useState } from "react";
import type { PromptPresetDto } from "@rp-platform/domain";
import { cn } from "../lib/cn.js";
import { ConfirmCloseModal } from "./shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { Icons } from "./shared/icons.js";
import { SaveButton } from "./shared/SaveBar.js";
import { useDirtyState } from "./shared/use-dirty-state.js";
import { PresetList, PresetHeader, PromptTabs } from "./prompt/index.js";

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
};

interface PromptManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
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
  prefill: "", authorsNote: "", authorsNoteDepth: 4, summary: "", tools: "",
};

export function PromptManagerModal(input: PromptManagerModalProps) {
  const [activeTab, setActiveTab] = useState<"system" | "jailbreak" | "authorsNote" | "tools">("system");
  const [draft, setDraft] = useState<DraftData>({ ...emptyDraft });
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const dirtyState = useDirtyState();
  const activePreset = input.presets.find((p) => p.id === input.activePresetId) ?? null;

  // Resolve bindModel id → provider name for sidebar display
  const resolveBindName = (bindModel: string): string => {
    if (!bindModel) return "";
    const profile = input.providerProfiles?.find((p) => p.id === bindModel);
    return profile?.name ?? bindModel;
  };

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
      });
    } else {
      setDraft({ ...emptyDraft });
    }
    dirtyState.reset();
  }, [activePreset?.id]);

  function updateDraft<K extends keyof DraftData>(key: K, value: DraftData[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    dirtyState.markDirty();
  }

  if (!input.isOpen) return null;

  const handleClose = () => {
    if (dirtyState.dirty) {
      setConfirmCloseOpen(true);
    } else {
      input.onClose();
    }
  };

  const handleSave = () => {
    if (!input.activePresetId) return;
    dirtyState.triggerSave(() => {
      void input.onUpdate(input.activePresetId!, draft);
    });
  };

  const handleDuplicate = () => {
    void input.onCreate({ ...draft, name: `${draft.name} (copy)` });
  };

  const handleAdd = () => {
    void input.onCreate({ name: "New preset" });
  };

  const handleConfirmDelete = () => {
    if (!input.activePresetId) return;
    void input.onDelete(input.activePresetId);
    setConfirmDeleteOpen(false);
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
            dirtyState.reset();
            setConfirmCloseOpen(false);
            input.onClose();
          }}
        />
      )}
      {confirmDeleteOpen && (
        <DestructiveConfirmModal
          title="Delete preset"
          body={
            <>
              Are you sure? The preset <b>{activePreset?.name || "Unnamed"}</b> will be permanently deleted.
            </>
          }
          confirmLabel="Delete preset"
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}

      <div
        className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] w-[760px] h-[580px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-b border-border pt-[18px] px-5 pb-[14px]">
          <div>
            <div className="font-body mb-0.5 text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
              Prompt Manager
              {dirtyState.dirty && (
                <span
                  className="ml-1.5 inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-accent align-middle"
                  title="Unsaved changes"
                />
              )}
            </div>
            <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
              System, post-history, and summary/tools instructions per preset.
            </div>
          </div>
          <div
            className="flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1"
            onClick={handleClose}
          >
            <Icons.Close />
          </div>
        </div>

        {/* Body: sidebar + main */}
        <div className="flex min-h-0 flex-1">
          <PresetList
            presets={input.presets.map((p) => ({
              id: p.id,
              name: p.name,
              bindModel: resolveBindName(p.bindModel),
            }))}
            activePresetId={input.activePresetId}
            onSelect={(id) => input.setActivePresetId(id)}
            onAdd={handleAdd}
          />
          <div className="flex flex-1 flex-col overflow-y-auto p-5">
            <PresetHeader
              name={draft.name}
              bindModel={draft.bindModel}
              disabled={!activePreset}
              onUpdateField={(key, value) => updateDraft(key, value)}
              providerProfiles={input.providerProfiles}
            />
            <PromptTabs
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              draft={activePreset ? draft : null}
              onUpdateField={updateDraft}
              prefillSupported={input.prefillSupported}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border py-3.5 px-5">
          <span
            className={cn(
              "flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1",
              !activePreset && "pointer-events-none opacity-45"
            )}
            onClick={activePreset ? handleDuplicate : undefined}
          >
            <Icons.Copy /> Duplicate preset
          </span>
          {activePreset && input.presets.length > 1 && (
            <span
              className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
              onClick={() => setConfirmDeleteOpen(true)}
            >
              <Icons.Trash /> Delete preset
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <button
              className="h-[37px] cursor-pointer rounded-md border border-border bg-surface py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={handleClose}
            >
              Close
            </button>
            <SaveButton
              dirty={dirtyState.dirty}
              saveState={dirtyState.saveState}
              onClick={handleSave}
              label="Save"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
