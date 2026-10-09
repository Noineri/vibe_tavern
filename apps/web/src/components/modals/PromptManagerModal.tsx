import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerationFormat, PromptPresetDto } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Icons } from "../shared/icons.js";
import { SaveButton } from "../shared/SaveBar.js";
import { useModalStore } from "../../stores/modal-store.js";
import { PresetList, PromptFields } from "../settings/prompt/index.js";
import { PromptOrderCanvas, type CharacterCanvasDraft } from "../settings/prompt/InjectionTable.js";
import type { PresetImportResult } from "./preset-import-flow.js";
import {
  buildStPresetCreatePayload,
  createPresetRegexProfile,
  createPresetWithRegexProfile,
  mergeStImportIntoDraft,
  parseAiAssistantPrompts,
  presetRegexImportPlan,
  vtImportDraft,
  type DraftData,
  type PresetCreateWithRegexOutcome,
  type PresetRegexImportPlan,
} from "./preset-import-flow.js";
import { PresetImportModalHost } from "./PresetImportModalHost.js";
import { RegexImportModal } from "./RegexImportModal.js";
import { serializeStPreset, serializeStandaloneRegexJson } from "@vibe-tavern/import-export";
import { CustomTooltip } from "../shared/Tooltip.js";
import { MasterDetailModal, MasterDetailMobileDrillDown, MasterDetailFooter } from "../shared/MasterDetailModal.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { ServicePromptsPane } from "../settings/prompt/ServicePromptsPane.js";
import { ImagePromptTemplatesPane } from "../settings/prompt/ImagePromptTemplatesPane.js";
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
import { RegexPresetEditor } from "../settings/prompt/RegexPresetEditor.js";
import { regexDraftFromRecord, useRegexRuleDraft, emptyRegexDraft, type RegexPresetDraft } from "../settings/prompt/regex-rule-draft.js";
import { RegexProfileEditor } from "../settings/prompt/RegexProfileEditor.js";
import { ProfileAutosaveFooter, useProfileAutosave } from "../settings/prompt/profile-autosave.js";
import { makeRegexProfileAttachmentHandler } from "../settings/prompt/profile-member-workflows.js";
import { makeRegexProfileAssignmentHandler } from "../settings/prompt/regex-profile-assignment.js";
import {
  listAllRegexPresets,
  createRegexPreset,
  createRegexProfileBundle,
  updateRegexPreset,
  deleteRegexPreset,
  getRegexLinks,
  listAllRegexProfiles,
  createRegexProfile,
  updateRegexProfile,
  deleteRegexProfile,
  attachRegexRule,
  detachRegexRule,
  getRegexProfileLinks,
  setRegexProfileLinks,
} from "../../api/regex-api.js";
import { invalidateActiveRegexPresets } from "../../hooks/use-active-regex-presets.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../../api/types.js";
import { downloadTextFile } from "../../lib/download.js";
import { applyTargetFlags, type RegexPlacement, type RegexSubstituteMode } from "@vibe-tavern/domain";
import { toast } from "sonner";

type SaveState = "idle" | "saving" | "saved" | "error";

type PromptManagerTab = "presets" | "regex" | "service" | "images";

// The draft shape moved to preset-import-flow.ts with its import-path
// builders (RXU-21 extraction); re-exported for existing importers/tests.
export type { DraftData } from "./preset-import-flow.js";

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
  perSendPrefillEnabled: false,
  generationFormat: null,
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
  // A null format (= auto) is absent on the wire — strip it from the clone.
  const { generationFormat, ...copyFields } = copy;
  return {
    ...copyFields,
    aiAssistantPrompts: JSON.stringify(copy.aiAssistantPrompts),
    ...(generationFormat ? { generationFormat } : {}),
    name: `${draft.name || fallbackName} (copy)`,
  };
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
  const [presetImportFile, setPresetImportFile] = useState<File | null | undefined>(undefined);
  const [regexImportFile, setRegexImportFile] = useState<File | undefined>(undefined);
  const isMobile = useIsMobile();
  const activePreset = input.presets.find((p) => p.id === input.activePresetId) ?? null;

  // ─── Regex Presets tab (RX-11) ────────────────────────────────────────────
  // Local state only — no Zustand store in this unit. Presets load lazily on
  // first Regex-tab activation.
  const [activeTab, setActiveTab] = useState<PromptManagerTab>("presets");
  const [serviceDirty, setServiceDirty] = useState(false);
  const [imagesDirty, setImagesDirty] = useState(false);
  const [regexPresets, setRegexPresets] = useState<RegexPresetRecord[]>([]);
  const [regexLoadState, setRegexLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeRegexPresetId, setActiveRegexPresetId] = useState<string | null>(null);
  const [activeRegexProfileId, setActiveRegexProfileId] = useState<string | null>(null);
  const [regexDraft, setRegexDraft] = useState<RegexPresetDraft>(emptyRegexDraft);
  const [regexDirty, setRegexDirty] = useState(false);
  const [regexSaveState, setRegexSaveState] = useState<SaveState>("idle");
  const [regexConfirmDeleteOpen, setRegexConfirmDeleteOpen] = useState(false);
  const [profileConfirmDeleteId, setProfileConfirmDeleteId] = useState<string | null>(null);
  const regexImportInputRef = useRef<HTMLInputElement>(null);
  // Per-Rule reachability counts for the centralized availability model.
  // They load lazily after the Regex tab opens; undefined means not loaded.
  const [regexLinkCounts, setRegexLinkCounts] = useState<Record<string, number | undefined>>({});
  const [regexProfiles, setRegexProfiles] = useState<RegexProfileRecord[]>([]);
  const [expandedProfileIds, setExpandedProfileIds] = useState<Set<string>>(new Set());
  const [regexProfileLinkCounts, setRegexProfileLinkCounts] = useState<Record<string, number | undefined>>({});
  const profileAutosave = useProfileAutosave({
    update: updateRegexProfile,
    setProfiles: setRegexProfiles,
    onRollback: (id, previous) => setRegexProfiles((profiles) =>
      profiles.map((profile) => profile.id === id ? previous : profile),
    ),
    onSaved: invalidateActiveRegexPresets,
  });

  // RXU-14: manual Rule creation is a LOCAL draft — no placeholder is
  // persisted and no list row exists until the first valid Save.
  const regexRuleDraft = useRegexRuleDraft({
    isOpen,
    setRegexDraft, setRegexDirty, setRegexSaveState,
    setActiveRegexPresetId, setActiveRegexProfileId,
    setRegexPresets, setExpandedProfileIds,
  });

  const activeRegexPreset = regexPresets.find((p) => p.id === activeRegexPresetId) ?? null;
  const activeRegexProfile = regexProfiles.find((p) => p.id === activeRegexProfileId) ?? null;

  // Lazy-load regex presets on first tab activation (R-1 fix).
  // NOTE: `regexLoadState` must NOT be in the deps — the effect itself writes
  // it ("loading"), so a state dep re-triggers the effect's cleanup and kills
  // the only in-flight fetch (the original bug: the list stayed empty forever).
  // Once-guard is a ref; re-running the fetch (StrictMode double-invoke, tab
  // re-entry) is harmless — the apply is idempotent.
  const regexLoadStartedRef = useRef(false);
  useEffect(() => {
    if (activeTab !== "regex" || regexLoadStartedRef.current) return;
    regexLoadStartedRef.current = true;
    setRegexLoadState("loading");
    void listAllRegexPresets()
      .then((list) => {
        setRegexPresets(list);
        setRegexLoadState("ready");
        if (list.length > 0 && activeRegexPresetId === null) {
          setActiveRegexPresetId(list[0].id);
        }
      })
      .catch(() => {
        setRegexLoadState("error");
      });
    void listAllRegexProfiles()
      .then((list) => setRegexProfiles(list.sort((a, b) => a.sortOrder - b.sortOrder)))
      .catch(() => {});
  }, [activeTab, activeRegexPresetId, listAllRegexPresets]);

  // Sync the editor draft when the selected regex preset changes. An open
  // new-rule draft (RXU-14) owns the editor state — the draft opens with
  // `activeRegexPresetId` cleared, which is exactly what re-triggers this
  // effect, so it must not clobber the seeded fields.
  useEffect(() => {
    if (regexRuleDraft.draft) return;
    if (activeRegexPreset) {
      setRegexDraft(regexDraftFromRecord(activeRegexPreset));
    } else {
      setRegexDraft(emptyRegexDraft());
    }
    setRegexDirty(false);
    setRegexSaveState("idle");
  }, [activeRegexPresetId]);

  // R-7: fetch link counts for non-global, enabled presets whose count is not
  // known yet (disabled/global rows get their badge reason for free). Runs on
  // list changes (load / create / active-toggle patch); the editor reports
  // binding edits directly via onLinksChanged. Failures leave the id unknown —
  // no badge (and a retry on the next list change) rather than a false «unbound».
  useEffect(() => {
    for (const p of regexPresets) {
      if (p.isGlobal || p.disabled) continue;
      if (regexLinkCounts[p.id] !== undefined) continue;
      getRegexLinks(p.id)
        .then((rows) => setRegexLinkCounts((prev) => ({ ...prev, [p.id]: rows.length })))
        .catch(() => {});
    }
  }, [regexPresets, regexLinkCounts]);

  // R-13: profile link counts for triad dots
  useEffect(() => {
    for (const pr of regexProfiles) {
      if (pr.isGlobal || pr.disabled) continue;
      if (regexProfileLinkCounts[pr.id] !== undefined) continue;
      getRegexProfileLinks(pr.id)
        .then((rows) => setRegexProfileLinkCounts((prev) => ({ ...prev, [pr.id]: rows.length })))
        .catch(() => {});
    }
  }, [regexProfiles, regexProfileLinkCounts]);

  /** R-7 "Active" instant toggle: patch ONLY `disabled` server-side right
   *  away — never blocked by a dirty draft (the unsaved-changes indicator
   *  keeps carrying the draft≠saved story). List row and draft follow the
   *  patch optimistically; a failure reverts both and toasts. */
  function handleRegexActiveToggle(nextActive: boolean) {
    if (!activeRegexPreset) return;
    const id = activeRegexPreset.id;
    const prevDisabled = activeRegexPreset.disabled;
    setRegexPresets((prev) => prev.map((p) => (p.id === id ? { ...p, disabled: !nextActive } : p)));
    // Direct set, NOT handleRegexDraftChange: the toggle is already persisted,
    // so it must not mark the draft dirty.
    setRegexDraft((cur) => ({ ...cur, disabled: !nextActive }));
    void updateRegexPreset(id, { disabled: !nextActive })
      .then((updated) => {
        if (updated) setRegexPresets((prev) => prev.map((p) => (p.id === id ? updated : p)));
        invalidateActiveRegexPresets();
      })
      .catch(() => {
        setRegexPresets((prev) => prev.map((p) => (p.id === id ? { ...p, disabled: prevDisabled } : p)));
        setRegexDraft((cur) => ({ ...cur, disabled: prevDisabled }));
        toast.error(t("promptManager.regex.toggleFailed"));
      });
  }

  function handleRegexDraftChange(next: RegexPresetDraft) {
    setRegexDraft(next);
    setRegexDirty(true);
    setRegexSaveState("idle");
  }

  function afterProfileAutosave(next: () => void) {
    void profileAutosave.flush().then(next);
  }

  function handleRegexSelect(id: string) {
    afterProfileAutosave(() => {
      regexRuleDraft.discard();
      setActiveRegexPresetId(id);
      setActiveRegexProfileId(null);
      profileAutosave.resetStatus();
    });
  }

  function handleRegexProfileSelect(id: string) {
    afterProfileAutosave(() => {
      regexRuleDraft.discard();
      setActiveRegexProfileId(id);
      setActiveRegexPresetId(null);
      setRegexDirty(false);
      setRegexSaveState("idle");
      profileAutosave.resetStatus();
    });
  }

  function queueProfileSave(patch: { name?: string; disabled?: boolean; isGlobal?: boolean }, immediate: boolean) {
    if (activeRegexProfile) profileAutosave.queue(activeRegexProfile, patch, immediate);
  }

  function handleRegexProfileActiveToggle(nextActive: boolean) {
    queueProfileSave({ disabled: !nextActive }, true);
  }

  function handleRegexProfileScopeToggle(nextIsGlobal: boolean) {
    queueProfileSave({ isGlobal: nextIsGlobal }, true);
  }

  const handleProfileExport = useCallback(() => {
    if (!activeRegexProfileId) return;
    const profile = regexProfiles.find((p) => p.id === activeRegexProfileId);
    if (!profile) return;
    const members = regexPresets.filter((r) => r.profileId === activeRegexProfileId);
    if (members.length === 0) {
      toast.error(t("promptManager.regex.profileExportFailed"));
      return;
    }
    try {
      const json = serializeStandaloneRegexJson(
        members.map((m) => ({
          name: m.name,
          findRegex: m.findRegex,
          replaceString: m.replaceString,
          trimStrings: [...m.trimStrings],
          substituteRegex: m.substituteRegex as RegexSubstituteMode,
          disabled: m.disabled,
          markdownOnly: m.markdownOnly,
          promptOnly: m.promptOnly,
          runOnEdit: m.runOnEdit,
          minDepth: m.minDepth,
          maxDepth: m.maxDepth,
          placement: [...m.placement] as RegexPlacement[],
          isGlobal: m.isGlobal,
          sortOrder: m.sortOrder,
          profileId: null,
        })),
      );
      const safeName = profile.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`regex-profile-${safeName}.json`, json, "application/json");
      toast.success(t("promptManager.regex.profileExported"));
    } catch {
      toast.error(t("promptManager.regex.profileExportFailed"));
    }
  }, [activeRegexProfileId, regexPresets, regexProfiles, t]);

  function handleProfileDelete(mode: "keep" | "cascade") {
    if (!profileConfirmDeleteId) return;
    const id = profileConfirmDeleteId;
    const wasActive = activeRegexProfileId === id;
    setProfileConfirmDeleteId(null);
    if (wasActive) {
      setActiveRegexProfileId(null);
    }
    void deleteRegexProfile(id, mode)
      .then(async () => {
        const [presets, profiles] = await Promise.all([listAllRegexPresets(), listAllRegexProfiles()]);
        setRegexPresets(presets);
        setRegexProfiles(profiles.sort((a, b) => a.sortOrder - b.sortOrder));
        // Clear active preset if it was deleted via cascade
        if (activeRegexPresetId && presets.every((p) => p.id !== activeRegexPresetId)) {
          setActiveRegexPresetId(presets.length > 0 ? presets[0].id : null);
        }
        invalidateActiveRegexPresets();
        toast.success(t("promptManager.regex.profileDelete"));
      })
      .catch(() => {
        toast.error(t("promptManager.regex.profileDeleteFailed"));
      });
  }

  /** A successful standalone import returns the complete atomic bundle, so
   *  local lists and the selected Profile update without a follow-up fetch. */
  function handleStandaloneRegexImported(result: { profile: RegexProfileRecord; rules: RegexPresetRecord[] }) {
    setRegexPresets((previous) => [...previous, ...result.rules].sort((a, b) => a.sortOrder - b.sortOrder));
    setRegexProfiles((previous) => [...previous, result.profile].sort((a, b) => a.sortOrder - b.sortOrder));
    setActiveRegexPresetId(null);
    setActiveRegexProfileId(result.profile.id);
    setExpandedProfileIds((previous) => new Set(previous).add(result.profile.id));
    invalidateActiveRegexPresets();
    toast.success(t("promptManager.regex.imported", { n: String(result.rules.length) }));
  }

  function handleRegexRename(id: string, newName: string) {
    void updateRegexPreset(id, { name: newName }).then((updated) => {
      if (updated) {
        setRegexPresets((prev) => prev.map((p) => (p.id === id ? updated : p)));
        invalidateActiveRegexPresets();
      }
    });
  }

  // R-12: duplicate + export. Both read the latest preset list through a ref
  // (the row is memoized and ignores callback identity), so the clone/export
  // always sees current fields even if the row never re-rendered.
  const regexPresetsRef = useRef(regexPresets);
  regexPresetsRef.current = regexPresets;

  // R-12→footer: copy/export act on the SELECTED rule, exactly like the
  // presets tab's duplicate/export footer actions (owner correction — the
  // per-row buttons were a pattern deviation).
  const handleRegexCopy = useCallback(() => {
    const source = regexPresetsRef.current.find((p) => p.id === activeRegexPresetId);
    if (!source) return;
    void createRegexPreset({
      name: `${source.name}${t("promptManager.regex.copySuffix")}`,
      findRegex: source.findRegex,
      replaceString: source.replaceString,
      trimStrings: [...source.trimStrings],
      substituteRegex: source.substituteRegex as RegexSubstituteMode,
      // Import-parity security gate: a duplicate starts disabled for review.
      disabled: true,
      markdownOnly: source.markdownOnly,
      promptOnly: source.promptOnly,
      runOnEdit: source.runOnEdit,
      minDepth: source.minDepth,
      maxDepth: source.maxDepth,
      placement: [...source.placement] as RegexPlacement[],
      isGlobal: source.isGlobal,
    })
      .then((created) => {
        setRegexPresets((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
        setActiveRegexPresetId(created.id);
        invalidateActiveRegexPresets();
        toast.success(t("promptManager.regex.copied"));
      })
      .catch(() => toast.error(t("promptManager.regex.copyFailed")));
  }, [t, activeRegexPresetId]);

  const handleRegexExport = useCallback(() => {
    const source = regexPresetsRef.current.find((p) => p.id === activeRegexPresetId);
    if (!source) return;
    try {
      // ST-compatible standalone export: an array-of-one RegexScriptData
      // (the ST bulk shape; the RX-16 import accepts arrays too).
      const json = serializeStandaloneRegexJson([{
        name: source.name,
        findRegex: source.findRegex,
        replaceString: source.replaceString,
        trimStrings: [...source.trimStrings],
        substituteRegex: source.substituteRegex as RegexSubstituteMode,
        disabled: source.disabled,
        markdownOnly: source.markdownOnly,
        promptOnly: source.promptOnly,
        runOnEdit: source.runOnEdit,
        minDepth: source.minDepth,
        maxDepth: source.maxDepth,
        placement: [...source.placement] as RegexPlacement[],
        isGlobal: source.isGlobal,
        sortOrder: source.sortOrder,
        // Standalone export: ST has no profiles; the rule leaves the bundle.
        profileId: null,
      }]);
      const safeName = source.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`regex-${safeName}.json`, json, "application/json");
      toast.success(t("promptManager.regex.exported"));
    } catch {
      toast.error(t("promptManager.regex.exportFailed"));
    }
  }, [t, activeRegexPresetId]);

  // R-13 profile handlers
  function handleRegexProfileAdd(name: string) {
    void createRegexProfile({ name }).then((created) => {
      setRegexProfiles((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
      setExpandedProfileIds((prev) => new Set([...prev, created.id]));
      setActiveRegexProfileId(created.id);
      setActiveRegexPresetId(null);
    });
  }
  function handleRegexProfileRename(id: string, newName: string) {
    void updateRegexProfile(id, { name: newName }).then((updated) => {
      if (updated) setRegexProfiles((prev) => prev.map((p) => (p.id === id ? updated : p)));
    });
  }
  const handleRegexToggleProfile = useCallback((id: string) => {
    setExpandedProfileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleRegexAttach = makeRegexProfileAttachmentHandler({ attach: attachRegexRule, setRules: setRegexPresets, setExpandedProfileIds, onAttached: invalidateActiveRegexPresets });
  const regexProfileAssignment = makeRegexProfileAssignmentHandler({
    attach: attachRegexRule, detach: detachRegexRule, setRules: setRegexPresets, setExpandedProfileIds,
    onConfirmed: invalidateActiveRegexPresets,
    onFailed: () => toast.error(t("promptManager.regex.profileAssignmentFailed")),
  });
  function handleRegexProfileReorder(updates: Array<{ id: string; sortOrder: number }>) {
    for (const u of updates) {
      void updateRegexProfile(u.id, { sortOrder: u.sortOrder }).then((updated) => {
        if (updated) setRegexProfiles((prev) => prev.map((p) => p.id === updated.id ? updated : p).sort((a, b) => a.sortOrder - b.sortOrder));
      });
    }
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
      invalidateActiveRegexPresets();
    });
  }

  function handleRegexSave() {
    // RXU-14: a new-rule draft's first Save is ONE create (directly in its
    // intended Profile); the saved-record update flow follows below.
    if (regexRuleDraft.draft) {
      regexRuleDraft.save(regexDraft);
      return;
    }
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
      invalidateActiveRegexPresets();
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
        perSendPrefillEnabled: activePreset.perSendPrefillEnabled ?? false,
        generationFormat: activePreset.generationFormat ?? null,
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
    afterProfileAutosave(() => {
      if (dirty || regexDirty || serviceDirty || imagesDirty) {
        setConfirmCloseOpen(true);
      } else {
        onClose();
      }
    });
  };

  const handleSave = () => {
    if (!input.activePresetId || !dirty) return;
    setSaveState("saving");
    const { generationFormat, ...draftFields } = draft;
    const patch = {
      ...draftFields,
      aiAssistantPrompts: JSON.stringify(draft.aiAssistantPrompts),
      // LS-3a: null = the preset has no stored format — omit (absent = auto);
      // a stored {mode:"auto"} object persists the explicit auto choice while
      // keeping the manual fields for a future switch-back.
      ...(generationFormat ? { generationFormat } : {}),
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

  // ─── RXU-21: embedded-Regex Profile for preset imports ──────────────────

  /** Refresh the Regex tab's local lists after a bundle lands. The lazy
   *  loader re-fetches on first tab activation anyway (idempotent) — this
   *  keeps an already-open tab from showing a stale list, and invalidates
   *  the display-regex cache so the new rules apply immediately. */
  async function refreshRegexListsAfterImport() {
    try {
      const [rules, profiles] = await Promise.all([listAllRegexPresets(), listAllRegexProfiles()]);
      setRegexPresets(rules.sort((a, b) => a.sortOrder - b.sortOrder));
      setRegexProfiles(profiles.sort((a, b) => a.sortOrder - b.sortOrder));
      invalidateActiveRegexPresets();
    } catch {
      // Non-fatal: the next Regex tab entry reloads both lists.
    }
  }

  /** Import target "current": the preset already exists, so the ONE Regex
   *  Profile binds straight to it. No compensation applies (the preset is
   *  not this import's to delete) — a bundle failure only surfaces. */
  function importRegexIntoExistingPreset(plan: PresetRegexImportPlan | null, presetId: string | null) {
    if (!plan || !presetId) return;
    void createPresetRegexProfile(plan, presetId, createRegexProfileBundle)
      .then(() => refreshRegexListsAfterImport())
      .catch(() => toast.error(t("regexImport.bundleFailed")));
  }

  /** Import target "new" outcome: select the new preset on success (plus a
   *  Regex list refresh when a bundle landed); surface bundle failures (the
   *  preset itself is already gone — compensated in the flow module). */
  function handlePresetCreateOutcome(outcome: PresetCreateWithRegexOutcome, plan: PresetRegexImportPlan | null) {
    if (outcome.ok) {
      input.setActivePresetId(outcome.presetId);
      if (plan) void refreshRegexListsAfterImport();
    } else if (outcome.reason === "regexBundleFailed") {
      // Preset-create failures are already toasted by the preset controller.
      toast.error(t("regexImport.bundleFailedRolledBack"));
    }
  }

  const handleImportPreset = (result: PresetImportResult) => {
    const plan = presetRegexImportPlan(result);
    // Lossless path: the file was exported by Vibe Tavern and carries the full
    // DTO under _vibe_tavern. Restore every field directly (no block projection,
    // no merge) — this is the only path that preserves VT-only fields
    // (aiAssistantPrompts, scriptAiSystemPrompt, tools, summary, prefill) and
    // exact canvas positions for built-in slots.
    if (result.vibeTavern) {
      const ext = result.vibeTavern;
      if (result.target === 'new') {
        // RXU-21: preset FIRST, then the Regex Profile bundle bound to it —
        // a bundle failure removes the preset again (compensation).
        void createPresetWithRegexProfile({
          createPreset: () => input.onCreate({ ...ext, name: result.newPresetName || ext.name }),
          deletePreset: (presetId) => input.onDelete(presetId),
          plan,
          createBundle: createRegexProfileBundle,
        }).then((outcome) => handlePresetCreateOutcome(outcome, plan));
      } else {
        // Replace the current preset's editable fields wholesale (reviewed via
        // the draft; user clicks Save to commit, so it is not immediately
        // destructive) — the draft shape comes from the flow module now.
        setDraft(vtImportDraft(ext));
        setDirty(true);
        setSaveState("idle");
        importRegexIntoExistingPreset(plan, input.activePresetId);
      }
      setPresetImportFile(undefined);
      return;
    }
    if (result.target === 'new') {
      const name = result.newPresetName || `${t('imported_preset')} ${new Date().toLocaleDateString()}`;
      // RXU-21: preset FIRST, then bundle (see the VT branch above).
      void createPresetWithRegexProfile({
        createPreset: () => input.onCreate(buildStPresetCreatePayload(result, name)),
        deletePreset: (presetId) => input.onDelete(presetId),
        plan,
        createBundle: createRegexProfileBundle,
      }).then((outcome) => handlePresetCreateOutcome(outcome, plan));
    } else {
      setDraft((d) => mergeStImportIntoDraft(d, result));
      setDirty(true);
      setSaveState("idle");
      importRegexIntoExistingPreset(plan, input.activePresetId);
    }
    setPresetImportFile(undefined);
  };

  const advancedMode = draft.advancedMode;

  return (
    <>
      {regexImportFile && (
        <RegexImportModal
          file={regexImportFile}
          currentPresetId={input.activePresetId}
          currentCharacterId={input.loreContext?.characterId ?? null}
          onClose={() => setRegexImportFile(undefined)}
          onImport={createRegexProfileBundle}
          onImported={handleStandaloneRegexImported}
        />
      )}
      <PresetImportModalHost
        file={presetImportFile}
        onClose={() => setPresetImportFile(undefined)}
        onImport={handleImportPreset}
      />

      {confirmCloseOpen && (
        <ConfirmCloseModal
          onCancel={() => setConfirmCloseOpen(false)}
          onConfirm={() => {
            setDirty(false);
            setRegexDirty(false);
            setServiceDirty(false);
            setImagesDirty(false);
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
      {profileConfirmDeleteId && (() => {
        const target = regexProfiles.find((p) => p.id === profileConfirmDeleteId);
        const count = regexPresets.filter((r) => r.profileId === profileConfirmDeleteId).length;
        return (
          <DestructiveConfirmModal
            title={t("promptManager.regex.profileDeleteTitle")}
            body={<>{t("promptManager.regex.profileDeleteBody", { name: target?.name || t("unnamed"), count })}</>}
            confirmLabel={t("promptManager.regex.profileDeleteCascade", { count })}
            secondaryLabel={t("promptManager.regex.profileDeleteKeep", { count })}
            onConfirm={() => handleProfileDelete("cascade")}
            onSecondary={() => handleProfileDelete("keep")}
            onCancel={() => setProfileConfirmDeleteId(null)}
          />
        );
      })()}

      {/* Standalone Regex import opens the Profile bundle preview. */}
      <input
        ref={regexImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) setRegexImportFile(file);
          e.target.value = "";
        }}
      />

      {/* LS-3d/e hidden file input removed with the format-tab import picker
          (owner 2026-09-09): instruct imports live in the provider format
          block; preset-side ST kinds await PresetImportModal compatibility. */}

      <ServicePromptsPane
        active={activeTab === "service"}
        renderRowDrillDown={(id, selectRow) => (
          <MasterDetailMobileDrillDown onSelect={selectRow} className="py-1" />
        )}
        onDirtyChange={setServiceDirty}
        onClose={handleClose}
      >
        {(slots) => (
          <ImagePromptTemplatesPane
            active={activeTab === "images"}
            renderRowDrillDown={(_rowId, selectRow) => (
              <MasterDetailMobileDrillDown onSelect={selectRow} className="py-1" />
            )}
            onDirtyChange={(nextDirty) => {
              if (nextDirty || activeTab === "images") setImagesDirty(nextDirty);
            }}
            onClose={handleClose}
          >
            {(imageSlots) => (
              <MasterDetailModal
            isOpen={true}
        onClose={handleClose}
        title={t("prompt_manager_title")}
        subtitle={t("prompt_manager_sub")}
        detailTitle={
          activeTab === "presets"
            ? t("prompt_manager_title")
            : activeTab === "regex"
              ? t("promptManager.regex.tabLabel")
              : activeTab === "images"
                ? t("promptManager.servicePrompts.tabLabelImages")
                : t("promptManager.servicePrompts.tabLabel")
        }
        dirty={
          activeTab === "service"
            ? slots.dirty
            : activeTab === "images"
              ? imageSlots.dirty
              : activeTab === "regex"
                ? regexDirty
                : dirty
        }
        masterClassName="flex w-[240px] shrink-0 flex-col border-r border-border"
        detailClassName="p-3 sm:p-5"
        mobileDetailClassName="p-3 scrollbar-hide"
        headerClassName={isMobile ? "px-4 pt-4 pb-3" : "px-5 pt-[18px] pb-[14px]"}
        tabs={{
          items: [
            { value: "presets", label: t("promptManager.tabPresets") },
            { value: "regex", label: t("promptManager.regex.tabLabel") },
            { value: "service", label: t("promptManager.servicePrompts.tabLabel") },
            { value: "images", label: t("promptManager.servicePrompts.tabLabelImages") },
          ],
          active: activeTab,
          onChange: (v) => setActiveTab(v),
        }}
        masterContent={
          activeTab === "images"
            ? imageSlots.master
            : activeTab === "service"
            ? slots.master
            : activeTab === "regex"
            ? () => (
                <RegexPresetList
                  presets={regexPresets}
                  profiles={regexProfiles}
                  regexLinkCounts={regexLinkCounts}
                  regexProfileLinkCounts={regexProfileLinkCounts}
                  activePresetId={activeRegexPresetId}
                  activeProfileId={activeRegexProfileId}
                  expandedProfileIds={[...expandedProfileIds]}
                  onToggleProfile={handleRegexToggleProfile}
                  onSelect={handleRegexSelect}
                  onSelectProfile={handleRegexProfileSelect}
                  onAdd={(name) => regexRuleDraft.open(name, null)}
                  onAddProfile={handleRegexProfileAdd}
                  onRename={handleRegexRename}
                  onRenameProfile={handleRegexProfileRename}
                  onReorder={handleRegexReorder}
                  onReorderProfiles={handleRegexProfileReorder}
                  onAttach={handleRegexAttach}
                  onDetach={regexProfileAssignment.detach}
                  onImportRegex={() => regexImportInputRef.current?.click()}
                />
              )
            : () => (
                <PresetList
                  presets={input.presets.map((p) => ({ id: p.id, name: p.name }))}
                  activePresetId={input.activePresetId}
                  onSelect={(id) => { input.setActivePresetId(id); }}
                  onAdd={handleAdd}
                  onRename={handleRename}
                  onImportPreset={(file) => setPresetImportFile(file ?? null)}
                  onReorder={input.onReorder}
                />
              )
        }
        detailContent={
          activeTab === "images"
            ? imageSlots.detail
            : activeTab === "service"
            ? slots.detail
            : activeTab === "regex"
              ? (
            activeRegexProfile ? (
              <RegexProfileEditor
                profile={activeRegexProfile}
                memberCount={regexPresets.filter((r) => r.profileId === activeRegexProfile.id).length}
                rules={regexPresets}
                onCreateRule={() => regexRuleDraft.open("", activeRegexProfile.id)}
                onAttachRules={(ruleIds) => handleRegexAttach(activeRegexProfile.id, ruleIds)}
                onNameChange={(name) => queueProfileSave({ name }, false)}
                onActiveToggle={handleRegexProfileActiveToggle}
                onScopeChange={handleRegexProfileScopeToggle}
                onLinksChanged={(pid, count) => setRegexProfileLinkCounts((prev) => ({ ...prev, [pid]: count }))}
              />
            ) : activeRegexPreset ? (
              <RegexPresetEditor
                preset={activeRegexPreset}
                draft={regexDraft}
                onDraftChange={handleRegexDraftChange}
                onActiveChange={handleRegexActiveToggle}
                onLinksChanged={(presetId, count) =>
                  setRegexLinkCounts((prev) => ({ ...prev, [presetId]: count }))
                }
                profiles={regexProfiles}
                profileLinkCounts={regexProfileLinkCounts}
                onProfileAssignment={(profileId) => regexProfileAssignment.assign(activeRegexPreset.id, profileId)}
              />
            ) : regexRuleDraft.draft ? (
              // RXU-14: an unsaved new-rule draft reuses the same editor with
              // no preset record — bindings are hidden (nothing to bind yet)
              // and the Active toggle edits the draft until first Save.
              <RegexPresetEditor
                preset={null}
                draft={regexDraft}
                onDraftChange={handleRegexDraftChange}
                draftProfileId={regexRuleDraft.draft.profileId}
                profiles={regexProfiles}
              />
            ) : regexLoadState === "loading" ? (
              <div className="flex h-full items-center justify-center p-5">
                <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t4">{t("loading")}</span>
              </div>
            ) : null
          ) : (
          <>
            {/* The accordion-era header block (mode title + hint lines +
                merge note — the shell of the old expandable accordion, kept
                alive by the 2026-06-02 segmented swap) is GONE by owner
                ruling 2026-09-19: the title duplicated the control's state,
                the advanced hint duplicated the canvas's own header, and the
                merge note described behavior the pane itself makes obvious.
                What remains is the canon SegmentedControl alone, right-
                aligned on desktop, full-width touch target on mobile. */}
            <div className={cn("mt-4 flex shrink-0", isMobile ? "px-2" : "mx-5 justify-end")}>
              <SegmentedControl
                value={advancedMode ? "advanced" : "simple"}
                options={[
                  { value: "simple", label: t("preset_simple_mode_short") },
                  { value: "advanced", label: t("preset_advanced_mode_short") },
                ]}
                onChange={(next) => {
                  if ((next === "advanced") !== advancedMode) updateDraft("advancedMode", next === "advanced");
                }}
                ariaLabel={t("preset_editor_mode")}
                mobileFill
              />
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
                  prefillSupported={input.prefillSupported}
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
          activeTab === "images"
            ? imageSlots.footer
            : activeTab === "service"
            ? slots.footer
            : activeTab === "regex"
              ? activeRegexProfile
                ? (
                  <ProfileAutosaveFooter
                    profile={activeRegexProfile}
                    rules={regexPresets}
                    status={profileAutosave.status}
                    onExport={handleProfileExport}
                    onDelete={() => setProfileConfirmDeleteId(activeRegexProfile.id)}
                    onClose={handleClose}
                  />
                ) : (
                  <MasterDetailFooter
                    actions={activeRegexPreset ? [
                      { icon: <Icons.Copy />, label: t("promptManager.regex.copy"), onClick: handleRegexCopy },
                      { icon: <Icons.Download />, label: t("promptManager.regex.export"), onClick: handleRegexExport },
                      { icon: <Icons.Trash />, label: t("promptManager.regex.deleteConfirm"), onClick: () => setRegexConfirmDeleteOpen(true), destructive: true },
                    ] : []}
                    onClose={handleClose}
                    right={<SaveButton
                      dirty={regexDirty}
                      saveState={regexSaveState}
                      resetKey={activeRegexPresetId}
                      onClick={handleRegexSave}
                      disabled={regexRuleDraft.draft ? regexRuleDraft.saveBlocked(regexDraft) : false}
                      label={t("save")}
                    />}
                  />
                ) : (
          <MasterDetailFooter
              actions={
                activePreset
                  ? [
                      { icon: <Icons.Copy />, label: t("duplicate_preset_btn"), onClick: handleDuplicate },
                      { icon: <Icons.Download />, label: t("export_preset_btn"), onClick: handleExportPreset },
                      ...(input.presets.length > 1
                        ? [{ icon: <Icons.Trash />, label: t("delete_preset"), onClick: () => setConfirmDeleteOpen(true) } as const]
                        : []),
                    ]
                  : []
              }
              onClose={handleClose}
              right={
                <SaveButton
                  dirty={dirty}
                  saveState={saveState}
                  resetKey={input.activePresetId}
                  onClick={handleSave}
                  label={t("save")}
                />
              }
            />
          )
        }
              />
            )}
          </ImagePromptTemplatesPane>
        )}
      </ServicePromptsPane>
    </>
  );
}
