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
import { serializeStPreset, type VibeTavernPresetExtension } from "@vibe-tavern/import-export";
import { CustomTooltip } from "../shared/Tooltip.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import {
  loadPromptCanvasLoreEntries,
  type CanvasLoreEntrySummary,
  type PromptCanvasLoreContext,
} from "../../lib/prompt-canvas-lore.js";
import {
  loadPromptCanvasSummaries,
  type CanvasSummaryEntry,
} from "../../lib/prompt-canvas-summary.js";
import { RegexPresetList } from "../settings/prompt/RegexPresetList.js";
import { RegexPresetEditor, regexDraftFromRecord, emptyRegexDraft, type RegexPresetDraft } from "../settings/prompt/RegexPresetEditor.js";
import {
  listAllRegexPresets,
  createRegexPreset,
  updateRegexPreset,
  deleteRegexPreset,
} from "../../api/regex-api.js";
import type { RegexPresetRecord } from "../../api/types.js";
import { applyTargetFlags, type RegexPlacement, type RegexSubstituteMode } from "@vibe-tavern/domain";

type SaveState = "idle" | "saving" | "saved" | "error";

type PromptManagerTab = "presets" | "regex";

export type DraftData = {
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
  mergeConsecutiveRoles: boolean;
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
  onReorder: (updates: Array<{ id: string; sortOrder: number }>) => Promise<boolean>;
  providerProfiles?: Array<{ id: string; name: string }>;
  prefillSupported?: boolean;
  characterFields?: {
    systemPrompt: string | null;
    postHistoryInstructions: string | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
    description: string;
    personalitySummary: string | null;
    scenario: string;
    mesExample: string | null;
  } | null;
  onCharacterFieldUpdate?: (key: keyof CharacterCanvasDraft, value: string | number) => void;
  personaDescription?: string | null;
  onPersonaDescriptionUpdate?: (value: string) => void;
  /** Per-chat dynamic prompt — content edited via the canvas card. */
  chatDynamicPrompt?: string | null;
  onChatDynamicPromptUpdate?: (value: string) => Promise<void>;
  loreContext?: PromptCanvasLoreContext | null;
  /** Active chat branch — summaries are branch-scoped. */
  chatBranchId?: string | null;
  /** Legacy flat `chat.summary` field — canvas fallback when no summary
   *  memory records exist (mirrors the prompt pipeline). */
  legacyChatSummary?: string | null;
}

function toCharacterCanvasDraft(
  fields: PromptManagerModalProps["characterFields"],
): CharacterCanvasDraft | null {
  return fields ? {
    charSystemPrompt: fields.systemPrompt ?? "",
    charPostHistory: fields.postHistoryInstructions ?? "",
    charDepthPrompt: fields.depthPrompt ?? "",
    charDepthPromptDepth: fields.depthPromptDepth ?? 4,
    charDepthPromptRole: fields.depthPromptRole ?? "system",
    charDescription: fields.description,
    charPersonality: fields.personalitySummary ?? "",
    scenario: fields.scenario,
    dialogueExamples: fields.mesExample ?? "",
  } : null;
}

const emptyDraft: DraftData = {
  name: "", system: "", jailbreak: "",
  prefill: "", authorsNote: "", authorsNoteDepth: 4, authorsNotePosition: "in_chat", authorsNoteRole: "system", summary: "", tools: "", nsfw: "", enhanceDefinitions: "", scriptAiSystemPrompt: "",
  aiAssistantPrompts: {},
  customInjections: [],
  promptOrder: [],
  advancedMode: false,
  mergeConsecutiveRoles: false,
};

/**
 * Build the create-preset payload for "Duplicate" — a DEEP copy of the live
 * draft so the new preset's payload shares no mutable array/object references
 * (`promptOrder`, `customInjections`, `aiAssistantPrompts`) with the source. A
 * former shallow `{...draft}` spread aliased those nested values and let edits
 * to the copy leak back into the source's in-memory state. `aiAssistantPrompts`
 * is stringified to the JSON the DTO/API store expects (matches handleSave).
 * Pure/exported so the no-aliasing invariant has a characterization test
 * (PRESET_COPY_DELETE_CORRUPTION bug 1). */
export function buildDuplicatePayload(draft: DraftData, fallbackName: string) {
  const copy = structuredClone(draft);
  return {
    ...copy,
    aiAssistantPrompts: JSON.stringify(copy.aiAssistantPrompts),
    name: `${draft.name || fallbackName} (copy)`,
  };
}

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

  // Active-character fields → one canvas draft (mutable state).
  const [characterDraft, setCharacterDraft] = useState<CharacterCanvasDraft | null>(() =>
    toCharacterCanvasDraft(input.characterFields)
  );
  const [personaDescriptionDraft, setPersonaDescriptionDraft] = useState<string | null>(
    () => input.personaDescription ?? null,
  );
  const [chatDynamicPromptDraft, setChatDynamicPromptDraft] = useState<string>(
    () => input.chatDynamicPrompt ?? "",
  );
  const [loreAnchorEntries, setLoreAnchorEntries] = useState<CanvasLoreEntrySummary[]>([]);
  const [loreAnchorLoadState, setLoreAnchorLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [summaryEntries, setSummaryEntries] = useState<CanvasSummaryEntry[]>([]);
  const [summaryLoadState, setSummaryLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  // Sync entity drafts when the active character/persona snapshot changes.
  useEffect(() => {
    setCharacterDraft(toCharacterCanvasDraft(input.characterFields));
  }, [
    input.characterFields?.systemPrompt,
    input.characterFields?.postHistoryInstructions,
    input.characterFields?.depthPrompt,
    input.characterFields?.depthPromptDepth,
    input.characterFields?.depthPromptRole,
    input.characterFields?.description,
    input.characterFields?.personalitySummary,
    input.characterFields?.scenario,
    input.characterFields?.mesExample,
  ]);
  useEffect(() => {
    setPersonaDescriptionDraft(input.personaDescription ?? null);
  }, [input.personaDescription]);
  useEffect(() => {
    setChatDynamicPromptDraft(input.chatDynamicPrompt ?? "");
  }, [input.chatDynamicPrompt]);

  useEffect(() => {
    const context = input.loreContext;
    if (!isOpen || !context) {
      setLoreAnchorEntries([]);
      setLoreAnchorLoadState("idle");
      return;
    }

    let cancelled = false;
    setLoreAnchorEntries([]);
    setLoreAnchorLoadState("loading");
    void loadPromptCanvasLoreEntries(context)
      .then((entries) => {
        if (cancelled) return;
        setLoreAnchorEntries(entries);
        setLoreAnchorLoadState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setLoreAnchorEntries([]);
        setLoreAnchorLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    input.loreContext?.chatId,
    input.loreContext?.characterId,
    input.loreContext?.personaId,
  ]);

  // Load the chat-summary memory blocks for the active chat branch. Mirrors
  // the pipeline: includable branch-scoped records, falling back to the legacy
  // `chat.summary` field. Reloads on chat/branch change while the modal is open.
  useEffect(() => {
    const chatId = input.loreContext?.chatId;
    if (!isOpen || !chatId) {
      setSummaryEntries([]);
      setSummaryLoadState("idle");
      return;
    }

    let cancelled = false;
    setSummaryEntries([]);
    setSummaryLoadState("loading");
    void loadPromptCanvasSummaries({
      chatId,
      branchId: input.chatBranchId ?? null,
      legacySummary: input.legacyChatSummary ?? null,
    })
      .then((entries) => {
        if (cancelled) return;
        setSummaryEntries(entries);
        setSummaryLoadState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSummaryEntries([]);
        setSummaryLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    input.loreContext?.chatId,
    input.chatBranchId,
    input.legacyChatSummary,
  ]);

  function updateCharacterDraft(key: keyof CharacterCanvasDraft, value: string | number) {
    setCharacterDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: value };
    });
    setDirty(true);
    setSaveState("idle");
  }

  function updatePersonaDescriptionDraft(value: string) {
    setPersonaDescriptionDraft((prev) => prev == null ? prev : value);
    setDirty(true);
    setSaveState("idle");
  }
  const [importModalOpen, setImportModalOpen] = useState(false);
  const isMobile = useIsMobile();
  const activePreset = input.presets.find((p) => p.id === input.activePresetId) ?? null;

  // ─── Regex Presets tab (RX-11) ────────────────────────────────────────────
  // Local state only — no Zustand store in this unit. Presets load lazily on
  // first Regex-tab activation.
  const [activeTab, setActiveTab] = useState<PromptManagerTab>("presets");
  const [regexPresets, setRegexPresets] = useState<RegexPresetRecord[]>([]);
  const [regexLoadState, setRegexLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeRegexPresetId, setActiveRegexPresetId] = useState<string | null>(null);
  const [regexDraft, setRegexDraft] = useState<RegexPresetDraft>(emptyRegexDraft);
  const [regexDirty, setRegexDirty] = useState(false);
  const [regexSaveState, setRegexSaveState] = useState<SaveState>("idle");
  const [regexConfirmDeleteOpen, setRegexConfirmDeleteOpen] = useState(false);

  const activeRegexPreset = regexPresets.find((p) => p.id === activeRegexPresetId) ?? null;

  // Lazy-load regex presets on first tab activation.
  useEffect(() => {
    if (activeTab !== "regex" || regexLoadState !== "idle") return;
    let cancelled = false;
    setRegexLoadState("loading");
    void listAllRegexPresets()
      .then((list) => {
        if (cancelled) return;
        setRegexPresets(list);
        setRegexLoadState("ready");
        if (list.length > 0 && activeRegexPresetId === null) {
          setActiveRegexPresetId(list[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setRegexLoadState("error");
      });
    return () => { cancelled = true; };
  }, [activeTab, regexLoadState]);

  // Sync the editor draft when the selected regex preset changes.
  useEffect(() => {
    if (activeRegexPreset) {
      setRegexDraft(regexDraftFromRecord(activeRegexPreset));
    } else {
      setRegexDraft(emptyRegexDraft());
    }
    setRegexDirty(false);
    setRegexSaveState("idle");
  }, [activeRegexPresetId]);

  function handleRegexDraftChange(next: RegexPresetDraft) {
    setRegexDraft(next);
    setRegexDirty(true);
    setRegexSaveState("idle");
  }

  function handleRegexSelect(id: string) {
    setActiveRegexPresetId(id);
  }

  function handleRegexAdd(name: string) {
    const flags = applyTargetFlags("persist");
    void createRegexPreset({
      name,
      findRegex: "/.*/g",
      replaceString: "",
      markdownOnly: flags.markdownOnly,
      promptOnly: flags.promptOnly,
    }).then((created) => {
      setRegexPresets((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
      setActiveRegexPresetId(created.id);
    });
  }

  function handleRegexRename(id: string, newName: string) {
    void updateRegexPreset(id, { name: newName }).then((updated) => {
      if (updated) {
        setRegexPresets((prev) => prev.map((p) => (p.id === id ? updated : p)));
      }
    });
  }

  function handleRegexReorder(updates: Array<{ id: string; sortOrder: number }>) {
    for (const u of updates) {
      void updateRegexPreset(u.id, { sortOrder: u.sortOrder }).then((updated) => {
        if (updated) {
          setRegexPresets((prev) =>
            prev.map((p) => (p.id === updated.id ? updated : p)).sort((a, b) => a.sortOrder - b.sortOrder),
          );
        }
      });
    }
  }

  function handleRegexDelete() {
    if (!activeRegexPresetId) return;
    const deleteId = activeRegexPresetId;
    const remaining = regexPresets.filter((p) => p.id !== deleteId);
    const fallbackId = remaining.length > 0 ? remaining[0].id : null;
    setActiveRegexPresetId(fallbackId);
    setRegexConfirmDeleteOpen(false);
    setRegexDirty(false);
    setRegexSaveState("idle");
    void deleteRegexPreset(deleteId).then(() => {
      setRegexPresets((prev) => prev.filter((p) => p.id !== deleteId));
    });
  }

  function handleRegexSave() {
    if (!activeRegexPresetId || !regexDirty) return;
    setRegexSaveState("saving");
    const flags = applyTargetFlags(regexDraft.applyTarget);
    const trimStrings = regexDraft.trimStrings.split("\n").filter((s) => s.length > 0);
    const minDepth = regexDraft.minDepth === "" ? null : Number(regexDraft.minDepth);
    const maxDepth = regexDraft.maxDepth === "" ? null : Number(regexDraft.maxDepth);
    void updateRegexPreset(activeRegexPresetId, {
      name: regexDraft.name,
      findRegex: regexDraft.findRegex,
      replaceString: regexDraft.replaceString,
      trimStrings,
      substituteRegex: regexDraft.substituteRegex,
      disabled: regexDraft.disabled,
      isGlobal: regexDraft.isGlobal,
      placement: regexDraft.placement,
      minDepth: Number.isNaN(minDepth) ? null : minDepth,
      maxDepth: Number.isNaN(maxDepth) ? null : maxDepth,
      markdownOnly: flags.markdownOnly,
      promptOnly: flags.promptOnly,
      applyTarget: regexDraft.applyTarget,
    }).then((updated) => {
      if (!updated) {
        setRegexSaveState("error");
        return;
      }
      setRegexPresets((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setRegexDirty(false);
      setRegexSaveState("saved");
      setTimeout(() => setRegexSaveState("idle"), 2200);
    });
  }

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
        mergeConsecutiveRoles: activePreset.mergeConsecutiveRoles ?? false,
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
    if (dirty || regexDirty) {
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
    void input.onUpdate(input.activePresetId, patch).then(async (ok) => {
      if (!ok) {
        setSaveState("error");
        return;
      }
      // Persist character field changes via API (fire-and-forget — existing behavior preserved).
      if (characterDraft && input.onCharacterFieldUpdate) {
        const orig = input.characterFields;
        if (orig) {
          if (characterDraft.charSystemPrompt !== (orig.systemPrompt ?? "")) input.onCharacterFieldUpdate("charSystemPrompt", characterDraft.charSystemPrompt);
          if (characterDraft.charPostHistory !== (orig.postHistoryInstructions ?? "")) input.onCharacterFieldUpdate("charPostHistory", characterDraft.charPostHistory);
          if (characterDraft.charDepthPrompt !== (orig.depthPrompt ?? "")) input.onCharacterFieldUpdate("charDepthPrompt", characterDraft.charDepthPrompt);
          if (characterDraft.charDepthPromptDepth !== (orig.depthPromptDepth ?? 4)) input.onCharacterFieldUpdate("charDepthPromptDepth", characterDraft.charDepthPromptDepth);
          if (characterDraft.charDepthPromptRole !== (orig.depthPromptRole ?? "system")) input.onCharacterFieldUpdate("charDepthPromptRole", characterDraft.charDepthPromptRole);
          if (characterDraft.charDescription !== orig.description) input.onCharacterFieldUpdate("charDescription", characterDraft.charDescription);
          if (characterDraft.charPersonality !== (orig.personalitySummary ?? "")) input.onCharacterFieldUpdate("charPersonality", characterDraft.charPersonality);
          if (characterDraft.scenario !== orig.scenario) input.onCharacterFieldUpdate("scenario", characterDraft.scenario);
          if (characterDraft.dialogueExamples !== (orig.mesExample ?? "")) input.onCharacterFieldUpdate("dialogueExamples", characterDraft.dialogueExamples);
        }
      }
      if (
        personaDescriptionDraft != null
        && input.personaDescription != null
        && personaDescriptionDraft !== input.personaDescription
      ) {
        input.onPersonaDescriptionUpdate?.(personaDescriptionDraft);
      }
      // Persist chat dynamic prompt via API — awaited so a rejected PATCH
      // does not leave dirty cleared or show a false "saved" state.
      if (chatDynamicPromptDraft !== (input.chatDynamicPrompt ?? "")) {
        try {
          await input.onChatDynamicPromptUpdate?.(chatDynamicPromptDraft);
        } catch {
          setSaveState("error");
          return;
        }
      }
      setDirty(false);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    });
  };

  const handleDuplicate = () => {
    void input.onCreate(buildDuplicatePayload(draft, t("presets"))).then((created) => {
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
      mergeConsecutiveRoles: false,
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
          mergeConsecutiveRoles: ext.mergeConsecutiveRoles ?? false,
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
            setRegexDirty(false);
            setSaveState("idle");
            setRegexSaveState("idle");
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
              {t("delete_preset_body", { name: activePreset?.name || t("unnamed") })}
            </>
          }
          confirmLabel={t("delete_preset")}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
      {regexConfirmDeleteOpen && (
        <DestructiveConfirmModal
          title={t("promptManager.regex.deleteTitle")}
          body={<>{t("promptManager.regex.deleteBody", { name: activeRegexPreset?.name || t("unnamed") })}</>}
          confirmLabel={t("promptManager.regex.deleteConfirm")}
          onConfirm={handleRegexDelete}
          onCancel={() => setRegexConfirmDeleteOpen(false)}
        />
      )}

      <MasterDetailModal
        isOpen={true}
        onClose={handleClose}
        title={t("prompt_manager_title")}
        subtitle={t("prompt_manager_sub")}
        detailTitle={activeTab === "regex" ? t("promptManager.regex.tabLabel") : t("prompt_manager_title")}
        dirty={activeTab === "regex" ? regexDirty : dirty}
        containerClassName="max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] w-[920px] h-[880px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        masterClassName="flex w-[240px] shrink-0 flex-col border-r border-border"
        detailClassName="p-0"
        mobileDetailClassName="p-2 scrollbar-hide"
        headerClassName={isMobile ? "px-4 pt-4 pb-3" : "px-5 pt-[18px] pb-[14px]"}
        headerBottom={
          <div className="mt-3">
            <SegmentedControl
              value={activeTab}
              onChange={(v) => setActiveTab(v as PromptManagerTab)}
              options={[
                { value: "presets", label: t("promptManager.tabPresets") },
                { value: "regex", label: t("promptManager.regex.tabLabel") },
              ]}
            />
          </div>
        }
        masterContent={
          activeTab === "regex"
            ? () => (
                <RegexPresetList
                  presets={regexPresets.map((p) => ({ id: p.id, name: p.name, disabled: p.disabled }))}
                  activePresetId={activeRegexPresetId}
                  onSelect={handleRegexSelect}
                  onAdd={handleRegexAdd}
                  onRename={handleRegexRename}
                  onReorder={handleRegexReorder}
                />
              )
            : () => (
                <PresetList
                  presets={input.presets.map((p) => ({ id: p.id, name: p.name }))}
                  activePresetId={input.activePresetId}
                  onSelect={(id) => { input.setActivePresetId(id); }}
                  onAdd={handleAdd}
                  onRename={handleRename}
                  onImportPreset={() => setImportModalOpen(true)}
                  onReorder={input.onReorder}
                />
              )
        }
        detailContent={
          activeTab === "regex" ? (
            activeRegexPreset ? (
              <RegexPresetEditor
                preset={activeRegexPreset}
                draft={regexDraft}
                onDraftChange={handleRegexDraftChange}
              />
            ) : regexLoadState === "loading" ? (
              <div className="flex h-full items-center justify-center p-5">
                <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t4">{t("loading")}</span>
              </div>
            ) : null
          ) : (
          <>
            <div className={cn("mt-4 flex shrink-0 gap-3", isMobile ? "flex-col px-2" : "mx-5 flex-row items-center justify-between")}>
              <div>
                <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">
                  {advancedMode ? t("preset_advanced_mode") : t("preset_simple_mode")}
                </div>
                <div className="mt-0.5 font-ui text-[11px] text-t4">
                  {advancedMode ? t("preset_advanced_mode_hint") : t("preset_simple_mode_hint")}
                </div>
              </div>
              <div className={cn("inline-flex shrink-0 gap-0 rounded-md border border-border bg-s3 p-0.5", isMobile && "self-start")} role="radiogroup" aria-label={t("preset_editor_mode")}>
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
              <div className={cn("mt-3 rounded-md border border-border2 py-3", isMobile ? "px-0" : "mx-5 px-4")}>
                <PromptOrderCanvas
                  injections={draft.customInjections}
                  onChange={(injections) => { setDraft((d) => ({ ...d, customInjections: injections })); setDirty(true); setSaveState("idle"); }}
                  promptOrder={draft.promptOrder}
                  onPromptOrderChange={(promptOrder) => { setDraft((d) => ({ ...d, promptOrder })); setDirty(true); setSaveState("idle"); }}
                  draft={activePreset ? draft : null}
                  onUpdateField={(key, value) => updateDraft(key, value as never)}
                  characterDraft={characterDraft}
                  onCharacterFieldUpdate={updateCharacterDraft}
                  personaDescription={personaDescriptionDraft}
                  onPersonaDescriptionUpdate={updatePersonaDescriptionDraft}
                  chatDynamicPrompt={chatDynamicPromptDraft}
                  onChatDynamicPromptUpdate={(v) => { setChatDynamicPromptDraft(v); setDirty(true); setSaveState("idle"); }}
                  loreAnchorEntries={loreAnchorEntries}
                  loreAnchorLoadState={loreAnchorLoadState}
                  summaryEntries={summaryEntries}
                  summaryLoadState={summaryLoadState}
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
          )
        }
        footer={
          activeTab === "regex" ? (
            <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-border", isMobile ? "flex-wrap px-3 py-2.5" : "py-3.5 px-5")}>
              {activeRegexPreset && (
                <span
                  className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
                  onClick={() => setRegexConfirmDeleteOpen(true)}
                >
                  <Icons.Trash /> {t("promptManager.regex.deleteConfirm")}
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
                  dirty={regexDirty}
                  saveState={regexSaveState}
                  resetKey={activeRegexPresetId}
                  onClick={handleRegexSave}
                  label={t("save")}
                />
              </div>
            </div>
          ) : (
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
                resetKey={input.activePresetId}
                onClick={handleSave}
                label={t("save")}
              />
            </div>
          </div>
          )
        }
      />
    </>
  );
}
