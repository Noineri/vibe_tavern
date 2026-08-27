import { useEffect, useRef, useState } from "react";
import { devLog } from "../../lib/dev-log.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import type { FavoriteProviderModelRecord, ProviderProfileRecord, ProxyRecord } from "../../app-client.js";
import { PROVIDER_PRESET_GROUP, PROVIDER_TYPE, resolveLogitBiasSupport, resolveSamplerCapabilities } from "@vibe-tavern/domain";
import type { ProviderProbeResponse, ProviderProxyMode, SamplerCapabilityFlags } from "@vibe-tavern/domain";
import { saveProviderDraftSchema } from "@vibe-tavern/api-contracts";
import { computeSavePatch } from "../../hooks/save-provider-patch.js";
import { PROVIDER_PRESETS, getVisibleProviderPresets } from "../../provider-presets.js";
import { Icons } from "../shared/icons.js";
import {
  ProviderProfileList,
  ProviderEditHeader,
  ProviderViewHeader,
  ProviderModelSelector,
  ProviderCapabilityPanel,
  ProviderSamplerPanel,
  ProviderBindingPanel,
  ProviderQuotaPanel,
} from "../settings/provider/index.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { getProviderModelSettingsAction, reorderProviderProfilesAction } from "../../stores/api-actions/provider-actions.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { shouldUsePersistedProviderForTest } from "../../lib/provider-proxy-policy.js";
import { TtsSection } from "../settings/provider/tts/TtsSection.js";
import { TtsProfileEditor } from "../settings/provider/tts/TtsProfileEditor.js";
import { useTtsProfiles } from "../settings/provider/tts/use-tts-profiles.js";

export interface FormState {
  id: string;
  name: string;
  providerPreset: string;
  baseUrl: string;
  apiKey: string;
  hasStoredApiKey: boolean;
  model: string;
  visionModel: string;
  temperature: number;
  topP: number;
  minP: number;
  topK: number;
  topA: number;
  typicalP: number;
  tfsZ: number;
  repeatLastN: number;
  mirostat: number;
  mirostatTau: number;
  mirostatEta: number;
  dryMultiplier: number;
  dryBase: number;
  dryAllowedLength: number;
  drySequenceBreakers: string[];
  xtcThreshold: number;
  xtcProbability: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  maxTokens: number;
  contextBudget: number;
  pinContextBudget: boolean;
  /** Profile-level toggle: when true, the binding dropdown (Wave 5) is enabled
   *  and saves route sampler writes to the selected model's overlay instead of
   *  the profile base. Persisted on the profile (Wave 1 column). */
  bindPerModel: boolean;
  /** Model-list display prefs (MODEL_LIST_FILTERS) — persisted on the profile. */
  modelFreeOnly: boolean;
  modelGroupByOwner: boolean;
  /** The model currently selected in the binding dropdown, or null when no
   *  model is picked (or binding is OFF). Drives overlay save routing + the
   *  "Editing: <model>" badge. Not persisted on the profile — UI-only state. */
  editingModelId: string | null;
  stopSequences: string[];
  logitBias: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
  proxyMode: ProviderProxyMode;
  proxyId: string | null;
}

interface ModelOption {
  id: string;
  label: string;
  contextLength?: number;
  capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean; webSearch?: boolean; premium?: boolean };
  pricing?: { input?: number; output?: number };
  description?: string;
}

type HeaderMode = "edit" | "view";

export type ProviderCategoryTab = "llm" | "audio";

interface ProviderModalProps {
  providerProfiles: ProviderProfileRecord[];
  activeProviderProfileId: string | null;
  onCreateProfile: () => Promise<ProviderProfileRecord | null>;
  onDuplicateProfile: (id: string) => Promise<ProviderProfileRecord | null>;
  onDeleteProfile: (id: string) => Promise<void>;
  onActivateProfile: (id: string) => Promise<void>;
  onSaveProfile: (form: FormState) => Promise<ProviderProfileRecord | null>;
  onTestDraft: (endpoint: string, apiKey: string, providerType?: string, proxyMode?: ProviderProxyMode, proxyId?: string | null, providerProfileId?: string) => Promise<ProviderProbeResponse>;
  onTestProfile: (profileId: string) => Promise<ProviderProbeResponse>;
  onTestChat: (profileId: string | null, baseUrl: string, apiKey: string, model: string, providerType?: string, proxyMode?: ProviderProxyMode, proxyId?: string | null) => Promise<{ success: boolean; reply?: string; error?: string }>;
  onFetchModels: (baseUrl: string, apiKey?: string, useCache?: boolean, providerType?: string, proxyMode?: ProviderProxyMode, proxyId?: string | null) => Promise<ModelOption[]>;
  onFetchModelsForProfile: (profileId: string) => Promise<ModelOption[]>;
  favoriteModelsByProfile: Record<string, FavoriteProviderModelRecord[]>;
  onToggleFavoriteModel: (profileId: string, model: ModelOption) => Promise<void>;
  onRefreshProfiles: () => Promise<void>;
  proxies: ProxyRecord[];
  defaultProxyId: string | null;
  onSetDefaultProxy: (proxyId: string | null) => Promise<void>;
}

function profileToForm(p: ProviderProfileRecord): FormState {
  const preset = PROVIDER_PRESETS.find((f) => f.id === p.providerPreset)
    ?? PROVIDER_PRESETS.find((f) => f.type === p.providerPreset && f.baseUrl === p.endpoint);
  devLog('modal.profileToForm', { id: p.id, name: p.name, defaultModel: p.defaultModel, visionModel: p.visionModel });
  return {
    id: p.id, name: p.name, providerPreset: preset?.id ?? "",
    baseUrl: p.endpoint, apiKey: "", hasStoredApiKey: p.hasStoredApiKey,
    model: p.defaultModel ?? "", visionModel: p.visionModel ?? "", temperature: p.temperature, topP: p.topP,
    minP: p.minP, topK: p.topK, topA: p.topA,
    typicalP: p.typicalP ?? 1,
    tfsZ: p.tfsZ ?? 1,
    repeatLastN: p.repeatLastN ?? 0,
    mirostat: p.mirostat ?? 0,
    mirostatTau: p.mirostatTau ?? 5,
    mirostatEta: p.mirostatEta ?? 0.1,
    dryMultiplier: p.dryMultiplier ?? 0,
    dryBase: p.dryBase ?? 1.75,
    dryAllowedLength: p.dryAllowedLength ?? 2,
    drySequenceBreakers: p.drySequenceBreakers ?? [],
    xtcThreshold: p.xtcThreshold ?? 0.1,
    xtcProbability: p.xtcProbability ?? 0,
    frequencyPenalty: p.frequencyPenalty,
    presencePenalty: p.presencePenalty,
    repetitionPenalty: p.repetitionPenalty,
    maxTokens: p.maxTokens, contextBudget: p.contextBudget ?? 16000, pinContextBudget: p.pinContextBudget ?? false,
    bindPerModel: p.bindPerModel ?? false,
    modelFreeOnly: p.modelFreeOnly ?? false,
    modelGroupByOwner: p.modelGroupByOwner ?? false,
    editingModelId: null,
    stopSequences: p.stopSequences,
    logitBias: p.logitBias ?? [],
    seed: p.seed ?? null, showReasoning: p.showReasoning,
    reasoningEffort: p.reasoningEffort,
    streamResponse: p.streamResponse,
    customSamplers: p.customSamplers ?? false,
    proxyMode: p.proxyMode ?? "inherit",
    proxyId: p.proxyId ?? null,
  };
}

interface Capabilities {
  nonStreamGeneration: boolean;
  abortSignal: boolean;
  streaming: boolean;
  prefill: boolean;
  logitBias: boolean;
  vision?: boolean;
  reasoning?: boolean;
  tools?: boolean;
  webSearch?: boolean;
  premium?: boolean;
  samplers: SamplerCapabilityFlags;
}

function getCapabilities(type: string, providerPreset: string, model: string, endpoint: string): Capabilities {
  switch (type) {
    case PROVIDER_TYPE.anthropic: case PROVIDER_TYPE.google:
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: false, logitBias: false, samplers: resolveSamplerCapabilities(providerPreset, type) };
    case PROVIDER_TYPE.ollama: case PROVIDER_TYPE.llamaCpp: case PROVIDER_TYPE.unsloth:
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, logitBias: resolveLogitBiasSupport(providerPreset, model, endpoint).supported, samplers: resolveSamplerCapabilities(providerPreset, type) };
    case PROVIDER_TYPE.koboldCpp:
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: false, logitBias: false, samplers: resolveSamplerCapabilities(providerPreset, type) };
    default:
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, logitBias: resolveLogitBiasSupport(providerPreset, model, endpoint).supported, samplers: resolveSamplerCapabilities(providerPreset, type) };
  }
}

export function ProviderModal({
  providerProfiles, activeProviderProfileId,
  onCreateProfile, onDuplicateProfile, onDeleteProfile, onActivateProfile,
  onSaveProfile, onTestDraft, onTestProfile, onTestChat, onFetchModels, onFetchModelsForProfile,
  favoriteModelsByProfile, onToggleFavoriteModel, onRefreshProfiles,
  proxies, defaultProxyId, onSetDefaultProxy,
}: ProviderModalProps) {
  const isOpen = useModalStore((s) => s.isProviderModalOpen);
  const providerModalOrigin = useModalStore((s) => s.providerModalOrigin);
  const closeProviderModalOrigin = useModalStore((s) => s.closeProviderModalOrigin);
  const returnToCoauthorProviderModal = useModalStore((s) => s.returnToCoauthorProviderModal);
  const isArmServer = useBootstrapStore((s) => s.data?.isArmServer ?? false);
  const visiblePresets = getVisibleProviderPresets(isArmServer);
  const onClose = () => { closeProviderModalOrigin(); };
  const { t } = useT();

  // ── Selection state ──
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingChat, setTestingChat] = useState(false);
  const [chatResult, setChatResult] = useState<{ reply?: string; error?: string } | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const [visionModelSearch, setVisionModelSearch] = useState("");
  const [visionModelListOpen, setVisionModelListOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeTarget, setCloseTarget] = useState<"close" | "return">("close");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [headerSaving, setHeaderSaving] = useState(false);
  const [coauthorCreatedProfileId, setCoauthorCreatedProfileId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [activeCategory, setActiveCategory] = useState<ProviderCategoryTab>("llm");
  const tts = useTtsProfiles();

  // ── Header mode: edit vs view ──
  const [isNew, setIsNew] = useState(false);
  const [headerMode, setHeaderMode] = useState<HeaderMode>("view");

  // ── Auto-save flash indicator ──
  const [autoSaveFlash, setAutoSaveFlash] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lazyAutoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPendingLazyAutoSave = useRef(false);
  const latestFormRef = useRef<FormState | null>(null);

  // ── Load cached models for a profile ──
  const loadCached = async (profileId: string | null) => {
    if (!profileId) return;

    // 1. Try cached models from the profile object first (instant, no network)
    const profile = providerProfiles.find((p) => p.id === profileId);
    const cached = profile?.cachedModels?.models;
    if (cached && cached.length > 0) {
      setModels(cached);
      return;
    }

    // 2. Fall back to live fetch only when cache is empty
    try {
      const c = await onFetchModelsForProfile(profileId);
      if (c.length > 0) setModels(c);
    } catch { /* ignore */ }
  };

  // ── Init on open ──
  useEffect(() => {
    if (!isOpen) return;
    const target = activeProviderProfileId ?? providerProfiles[0]?.id ?? null;
    if (target) {
      const p = providerProfiles.find((pr) => pr.id === target);
      if (p) { setEditingId(p.id); setForm(profileToForm(p)); void loadCached(p.id); }
    }
    setTestOk(null); setHeaderMode("view"); setIsNew(false); setDirty(false); setConfirmClose(false); setConfirmDelete(false);
    setActiveCategory("llm");
  }, [isOpen]);

  useEffect(() => {
    latestFormRef.current = form;
  }, [form]);

  useEffect(() => () => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    if (lazyAutoSaveTimer.current) clearTimeout(lazyAutoSaveTimer.current);
  }, []);

  useEffect(() => {
    devLog('modal.visionAutoSelectEffect', {
      isOpen,
      formId: form?.id,
      formVisionModel: form?.visionModel,
      modelsCount: models.length,
      visionModelsCount: models.filter(m => m.capabilities?.vision).length,
    });
    if (!isOpen || !form || form.visionModel || models.length === 0) return;
    const fetchedVisionModels = models.filter((m) => m.capabilities?.vision);
    if (fetchedVisionModels.length > 0 && fetchedVisionModels.length < models.length) {
      devLog('modal.autoSelectingVisionModel', { selected: fetchedVisionModels[0].id, reason: 'form.visionModel was empty' });
      autoSaveField("visionModel", fetchedVisionModels[0].id);
    }
    // Intentionally depend on scalar form fields only: autoSaveField updates form.visionModel,
    // which makes this effect stop after the first selection.
  }, [isOpen, form?.id, form?.visionModel, models]);

  if (!isOpen) return null;

  // ── Form helpers ──
  const updateForm = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((f) => f ? { ...f, [k]: v } : f); setDirty(true); };

  const applyPreset = (presetId: string) => {
    const fmt = visiblePresets.find((f) => f.id === presetId);
    if (!fmt) return;
    setForm((f) => {
      if (!f) return f;
      // If provider type changed (e.g. anthropic → openai_compat),
      // the stored API key is irrelevant — clear it so user enters a new one.
      const typeChanged = f.providerPreset !== fmt.id;
      return {
        ...f,
        providerPreset: fmt.id,
        baseUrl: fmt.baseUrl,
        ...(typeChanged || fmt.noApiKey ? { apiKey: '', hasStoredApiKey: false } : {}),
      };
    });
    setDirty(true);
  };

  const showAutoSaveFlash = () => {
    setAutoSaveFlash(true);
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => setAutoSaveFlash(false), 1200);
  };

  const persistForm = (next: FormState) => {
    const draft = { ...computeSavePatch(next), id: next.id };
    const parsed = saveProviderDraftSchema.safeParse(draft);
    if (parsed.success) {
      devLog('modal.persistForm', { id: next.id, model: next.model, visionModel: next.visionModel });
      void onSaveProfile(next);
    } else {
      devLog('modal.persistFormSchemaFail', { issues: JSON.stringify(parsed.error.issues) });
    }
  };

  const flushLazyAutoSave = () => {
    if (!hasPendingLazyAutoSave.current) return;
    if (lazyAutoSaveTimer.current) {
      clearTimeout(lazyAutoSaveTimer.current);
      lazyAutoSaveTimer.current = null;
    }
    const next = latestFormRef.current;
    hasPendingLazyAutoSave.current = false;
    if (next) {
      persistForm(next);
      showAutoSaveFlash();
    }
  };

  // Auto-save: persists a single field immediately (model selection, simple toggles).
  const autoSaveField = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [k]: v };
      latestFormRef.current = next;
      persistForm(next);
      return next;
    });
    showAutoSaveFlash();
  };

  // Lazy auto-save: update UI immediately, persist only after the user pauses.
  // Used for sampler fields and especially logit bias sliders to avoid request storms.
  const lazyAutoSaveField = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [k]: v };
      latestFormRef.current = next;
      return next;
    });
    hasPendingLazyAutoSave.current = true;
    setAutoSaveFlash(true);
    if (lazyAutoSaveTimer.current) clearTimeout(lazyAutoSaveTimer.current);
    lazyAutoSaveTimer.current = setTimeout(() => {
      const next = latestFormRef.current;
      hasPendingLazyAutoSave.current = false;
      lazyAutoSaveTimer.current = null;
      if (next) persistForm(next);
      showAutoSaveFlash();
    }, 900);
  };

  // ── Profile selection ──
  const handleSelect = (id: string) => {
    const p = providerProfiles.find((pr) => pr.id === id);
    if (p) { setEditingId(p.id); setForm(profileToForm(p)); setTestOk(null); setModels([]); void loadCached(p.id); setHeaderMode("view"); setIsNew(false); setDirty(false); }
  };

  // ── Add new profile ──
  const handleAdd = async () => {
    const c = await onCreateProfile();
    if (c) { setEditingId(c.id); setForm(profileToForm(c)); setModels([]); setTestOk(null); setIsNew(true); setHeaderMode("edit"); setDirty(false); if (providerModalOrigin === "coauthor") setCoauthorCreatedProfileId(c.id); }
  };

  // ── Duplicate ──
  const handleDuplicate = async () => {
    if (!editingId) return;
    const d = await onDuplicateProfile(editingId);
    if (d) { setEditingId(d.id); setForm(profileToForm(d)); setModels([]); setTestOk(null); setIsNew(true); setHeaderMode("edit"); setDirty(false); if (providerModalOrigin === "coauthor") setCoauthorCreatedProfileId(d.id); }
  };

  // ── Delete ──
  const handleDelete = () => { if (providerProfiles.length > 1) setConfirmDelete(true); };

  const confirmDeleteAction = async () => {
    if (!editingId) return;
    await onDeleteProfile(editingId);
    if (coauthorCreatedProfileId === editingId) setCoauthorCreatedProfileId(null);
    const next = providerProfiles.find((p) => p.id !== editingId);
    if (next) { setEditingId(next.id); setForm(profileToForm(next)); }
    setConfirmDelete(false); setHeaderMode("view"); setIsNew(false); setDirty(false);
  };

  // ── Save header (connection settings) ──
  const handleSaveHeader = async () => {
    if (!form) return;
    const draft = { ...computeSavePatch(form), id: form.id };
    const parsed = saveProviderDraftSchema.safeParse(draft);
    if (!parsed.success) return;
    setHeaderSaving(true);
    try {
      const saved = await onSaveProfile(form);
      if (saved) setForm(profileToForm(saved));
      setHeaderMode("view"); setIsNew(false); setDirty(false);
    } finally {
      setHeaderSaving(false);
    }
  };

  // ── Cancel editing (back to view) ──
  const handleCancelEdit = () => {
    const saved = providerProfiles.find((p) => p.id === editingId);
    if (saved) setForm(profileToForm(saved));
    setHeaderMode("view"); setDirty(false);
  };

  // ── Set active (no save needed) ──
  const handleActivate = async () => {
    if (!editingId) return;
    await onActivateProfile(editingId);
  };

  // ── Close ──
  const completeClose = (target: "close" | "return") => {
    if (target === "return" && providerModalOrigin === "coauthor") returnToCoauthorProviderModal(coauthorCreatedProfileId);
    else onClose();
  };
  const requestClose = (target: "close" | "return") => {
    flushLazyAutoSave();
    if ((dirty && activeCategory === "llm") || (tts.dirty && activeCategory === "audio")) {
      setCloseTarget(target);
      setConfirmClose(true);
    } else completeClose(target);
  };
  const handleClose = () => requestClose("close");

  // ── Per-model binding: re-hydrate form when the user picks a model to edit ──
  // Fetch the model's overlay and merge it over the PERSISTED base profile, so
  // the sampler panel shows that model's effective settings. The base comes from
  // providerProfiles (always current — autoSaveField persists identity/sampler
  // on every change when NOT in overlay mode). In overlay mode, sampler edits
  // route to the overlay via Wave 4's save routing, so switching models reads
  // the clean persisted base, not a stale form snapshot.
  const handleSelectBindingModel = async (modelId: string) => {
    if (!form) return;
    const baseProfile = providerProfiles.find((p) => p.id === form.id);
    if (!baseProfile) return;
    let overlay = null;
    try {
      overlay = await getProviderModelSettingsAction(form.id, modelId);
    } catch {
      // Network/API error — fall through with null overlay (base passthrough).
      overlay = null;
    }
    // Manual field-wise merge: overlay value if present, else base profile value.
    // (Cannot use domain's resolveEffectiveSettings directly — web
    // ProviderProfileRecord omits apiKey for security, so it isn't structurally
    // assignable to StoredProviderProfileRecord.)
    const ov = overlay?.settings ?? null;
    const pick = <K extends keyof typeof effectiveFields>(k: K): (typeof effectiveFields)[K] =>
      (ov && ov[k] != null ? ov[k] : effectiveFields[k]) as (typeof effectiveFields)[K];
    const effectiveFields = {
      temperature: baseProfile.temperature,
      topP: baseProfile.topP,
      minP: baseProfile.minP,
      topK: baseProfile.topK,
      topA: baseProfile.topA,
      typicalP: baseProfile.typicalP,
      tfsZ: baseProfile.tfsZ,
      repeatLastN: baseProfile.repeatLastN,
      mirostat: baseProfile.mirostat,
      mirostatTau: baseProfile.mirostatTau,
      mirostatEta: baseProfile.mirostatEta,
      dryMultiplier: baseProfile.dryMultiplier,
      dryBase: baseProfile.dryBase,
      dryAllowedLength: baseProfile.dryAllowedLength,
      drySequenceBreakers: baseProfile.drySequenceBreakers,
      xtcThreshold: baseProfile.xtcThreshold,
      xtcProbability: baseProfile.xtcProbability,
      frequencyPenalty: baseProfile.frequencyPenalty,
      presencePenalty: baseProfile.presencePenalty,
      repetitionPenalty: baseProfile.repetitionPenalty,
      maxTokens: baseProfile.maxTokens,
      contextBudget: baseProfile.contextBudget,
      pinContextBudget: baseProfile.pinContextBudget,
      stopSequences: baseProfile.stopSequences,
      logitBias: baseProfile.logitBias,
      seed: baseProfile.seed,
      reasoningEffort: baseProfile.reasoningEffort,
      showReasoning: baseProfile.showReasoning,
      streamResponse: baseProfile.streamResponse,
      customSamplers: baseProfile.customSamplers,
    };
    setForm((f) => {
      if (!f) return f;
      const next: FormState = {
        ...f,
        editingModelId: modelId,
        temperature: pick("temperature"),
        topP: pick("topP"),
        minP: pick("minP"),
        topK: pick("topK"),
        topA: pick("topA"),
        typicalP: pick("typicalP") ?? 1,
        tfsZ: pick("tfsZ") ?? 1,
        repeatLastN: pick("repeatLastN") ?? 0,
        mirostat: pick("mirostat") ?? 0,
        mirostatTau: pick("mirostatTau") ?? 5,
        mirostatEta: pick("mirostatEta") ?? 0.1,
        dryMultiplier: pick("dryMultiplier") ?? 0,
        dryBase: pick("dryBase") ?? 1.75,
        dryAllowedLength: pick("dryAllowedLength") ?? 2,
        drySequenceBreakers: pick("drySequenceBreakers") ?? [],
        xtcThreshold: pick("xtcThreshold") ?? 0.1,
        xtcProbability: pick("xtcProbability") ?? 0,
        frequencyPenalty: pick("frequencyPenalty"),
        presencePenalty: pick("presencePenalty"),
        repetitionPenalty: pick("repetitionPenalty"),
        maxTokens: pick("maxTokens"),
        contextBudget: pick("contextBudget") ?? 16000,
        pinContextBudget: pick("pinContextBudget") ?? false,
        stopSequences: pick("stopSequences"),
        logitBias: pick("logitBias") ?? [],
        seed: pick("seed") ?? null,
        reasoningEffort: pick("reasoningEffort"),
        showReasoning: pick("showReasoning"),
        streamResponse: pick("streamResponse"),
        customSamplers: pick("customSamplers"),
      };
      latestFormRef.current = next;
      return next;
    });
    setDirty(true);
  };

  // ── Test connection ──
  const handleTestConnection = async () => {
    if (!form) return;
    setTesting(true); setTestOk(null);
    try {
      let r: ProviderProbeResponse;
      if (editingId && shouldUsePersistedProviderForTest(editingId, isNew, dirty)) {
        r = await onTestProfile(editingId);
      } else {
        const preset = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset);
        r = await onTestDraft(form.baseUrl, form.apiKey, preset?.type, form.proxyMode, form.proxyId, editingId ?? undefined);
      }
      setTestOk(r.success);
    } catch { setTestOk(false); } finally { setTesting(false); }
  };

  // ── Fetch models ──
  const handleFetchModels = async () => {
    if (!form) return;
    const ep = form.baseUrl.trim();
    if (!ep) { setFetchError(t("endpoint_url_required")); return; }
    setFetching(true); setFetchError(null);
    try {
      let fetched: ModelOption[];
      if (editingId && !isNew) {
        fetched = await onFetchModelsForProfile(editingId);
      } else {
        const preset = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset);
        fetched = await onFetchModels(ep, form.apiKey.trim() || undefined, false, preset?.type, form.proxyMode, form.proxyId);
      }
      if (!fetched.length) setFetchError(t("no_models_returned"));
      setTestOk(fetched.length > 0);
      setModels(fetched);
      if (fetched.length && (!form.model || !fetched.find((m) => m.id === form.model))) autoSaveField("model", fetched[0].id);
      const fetchedVisionModels = fetched.filter((m) => m.capabilities?.vision);
      if (fetchedVisionModels.length > 0 && fetchedVisionModels.length < fetched.length && !form.visionModel) {
        autoSaveField("visionModel", fetchedVisionModels[0].id);
      }
    } catch (e) { setModels([]); setTestOk(false); setFetchError(e instanceof Error ? e.message : t("failed_to_fetch_models")); }
    finally { setFetching(false); }
  };

  // ── Test chat ──
  const handleTestChat = async () => {
    if (!form || !form.baseUrl.trim() || !form.model.trim()) return;
    setTestingChat(true); setChatResult(null);
    const preset = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset);
    try { setChatResult(await onTestChat(shouldUsePersistedProviderForTest(editingId, isNew, dirty) ? editingId : null, form.baseUrl.trim(), form.apiKey.trim(), form.model.trim(), preset?.type, form.proxyMode, form.proxyId)); }
    catch (e) { setChatResult({ error: e instanceof Error ? e.message : t("request_failed") }); }
    finally { setTestingChat(false); }
  };

  // ── Derived ──
  const isActive = activeProviderProfileId === editingId;
  const showConfig = headerMode === "view" && !isNew;
  const selectedPreset = form ? PROVIDER_PRESETS.find((f) => f.id === form.providerPreset) : undefined;
  const providerType = selectedPreset?.type ?? "openai_compat";
  const isLocalProvider = selectedPreset?.group === PROVIDER_PRESET_GROUP.local;
  const selectedModel = form ? models.find((model) => model.id === form.model) : null;
  const capabilities = form ? { ...getCapabilities(providerType, form.providerPreset, form.model, form.baseUrl), ...selectedModel?.capabilities } : null;
  const filteredProfiles = profileSearch.trim()
    ? providerProfiles.filter((p) => p.name.toLowerCase().includes(profileSearch.toLowerCase()) || p.providerPreset.toLowerCase().includes(profileSearch.toLowerCase()))
    : providerProfiles;
  // Main selector shows all models (RP surface). Co-Author has its own
  // dedicated modal with tool-capability filtering — no mode flag here.
  const selectableModels = models;
  const filteredModels = modelSearch.trim()
    ? selectableModels.filter((m) => m.label.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : selectableModels;
  
  const hasVisionModels = models.some(m => m.capabilities?.vision);
  const allVisionModels = models.length > 0 && models.every(m => m.capabilities?.vision);
  const showVisionFallback = hasVisionModels && !allVisionModels;
  
  const visionFilteredModels = visionModelSearch.trim()
    ? models.filter(m => m.capabilities?.vision && (m.label.toLowerCase().includes(visionModelSearch.toLowerCase()) || m.id.toLowerCase().includes(visionModelSearch.toLowerCase())))
    : models.filter(m => m.capabilities?.vision);

  return (
    <>
      {confirmClose && <ConfirmCloseModal onCancel={() => setConfirmClose(false)} onConfirm={() => { setConfirmClose(false); setDirty(false); completeClose(closeTarget); }} />}
      {confirmDelete && (
        <DestructiveConfirmModal
          title={t("delete_provider_title")}
          body={<>{t("delete_profile_inline")} <b>{form?.name}</b>? {t("delete_provider_body")}</>}
          confirmLabel={t("delete_btn")}
          onConfirm={() => void confirmDeleteAction()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <MasterDetailModal
        isOpen={true}
        onClose={handleClose}
        title={t("provider_settings_title")}
        subtitle={t("provider_settings_desc")}
        detailTitle={activeCategory === "audio" ? (tts.form ? (tts.form.name || t("tts_profile_new_title")) : t("tts_section_title")) : (form?.name ?? t("provider_settings_title"))}
        dirty={activeCategory === "audio" ? tts.dirty : dirty}
        tabs={{
          items: [
            { value: "llm", label: t("providers_category_llm") },
            { value: "audio", label: t("providers_category_audio") },
          ],
          active: activeCategory,
          onChange: (v) => setActiveCategory(v),
        }}
        containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[680px] w-[860px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        masterClassName="flex w-[220px] shrink-0 flex-col border-r border-border"
        detailClassName={isMobile ? "p-4" : "p-5"}
        headerClassName={isMobile ? "px-3 py-2.5" : "px-6 pt-5 pb-4"}
        headerActions={providerModalOrigin === "coauthor" ? <button type="button" className="font-ui text-[12px] font-medium text-t3 transition-colors hover:text-t1" onClick={() => requestClose("return")}>{t("back")}</button> : undefined}
        masterContent={() =>
          activeCategory === "audio" ? (
            <TtsSection tts={tts} />
          ) : (
            <ProviderProfileList
              filteredProfiles={filteredProfiles}
              editingId={editingId}
              activeProviderProfileId={activeProviderProfileId}
              profileSearch={profileSearch}
              profiles={providerProfiles}
              onReorder={reorderProviderProfilesAction}
              onProfileSearchChange={setProfileSearch}
              onSelectProfile={(id) => {
                handleSelect(id);
              }}
              onAddProfile={() => {
                void handleAdd();
              }}
            />
          )
        }
        detailContent={
          activeCategory === "audio" ? (
            tts.form ? (
              <TtsProfileEditor tts={tts} />
            ) : (
              <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">
                {t("tts_section_placeholder")}
              </div>
            )
          ) : !form ? (
            <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">
              {t("provider_select_profile")}
            </div>
          ) : (
            <>
              {/* ── EDIT HEADER MODE ── */}
              {headerMode === "edit" && (
                <ProviderEditHeader
                  form={form} editingId={editingId} providerProfiles={providerProfiles}
                  updateForm={updateForm} applyPreset={applyPreset}
                  proxies={proxies} defaultProxyId={defaultProxyId}
                  testOk={testOk} testing={testing} onTest={handleTestConnection}
                  onSave={() => void handleSaveHeader()}
                  onCancel={!isNew ? handleCancelEdit : undefined}
                  isNew={isNew}
                  isArmServer={isArmServer}
                  dirty={dirty}
                  saving={headerSaving}
                />
              )}

              {/* ── VIEW HEADER MODE ── */}
              {headerMode === "view" && !isNew && (
                <ProviderViewHeader
                  form={form} isActive={isActive}
                  onEdit={() => setHeaderMode("edit")}
                  onActivate={() => void handleActivate()}
                />
              )}

              {/* ── CONFIG SECTION (only after header saved) ── */}
              {showConfig && (
                <>
                  <ProviderModelSelector form={form} models={selectableModels} filteredModels={filteredModels}
                    fetching={fetching} fetchError={fetchError} modelSearch={modelSearch} modelListOpen={modelListOpen}
                    favoriteModels={favoriteModelsByProfile[form.id] ?? []}
                    updateForm={autoSaveField} onFetchModels={handleFetchModels} setModelSearch={setModelSearch}
                    setModelListOpen={setModelListOpen}
                    onToggleFavoriteModel={(model) => onToggleFavoriteModel(form.id, model)}
                    requiresAuthForModels={selectedPreset?.requiresAuthForModels ?? false}
                    isLocalProvider={isLocalProvider}
                    localEndpoint={form.baseUrl}
                    localConnectionStatus={fetching || testing ? "checking" : fetchError || testOk === false ? "offline" : testOk === true ? "online" : "unknown"}
                  />

                  {form.model && (
                    <div className="mt-2 mb-4">
                      <button type="button" onClick={() => void handleTestChat()} disabled={testingChat}
                        className="rounded-md border border-border bg-s2 px-4 py-1.5 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
                      >
                        {testingChat ? t("sending") : t("test_hi_btn")}
                      </button>
                      {chatResult?.reply && (
                        <div className="mt-2">
                          <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success italic">&ldquo;{chatResult.reply.length > 200 ? chatResult.reply.slice(0, 200) + "..." : chatResult.reply}&rdquo;</span>
                        </div>
                      )}
                      {chatResult?.error && (
                        <div className="mt-2">
                          <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close /> {chatResult.error}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <ProviderCapabilityPanel capabilities={capabilities} />

                  {showVisionFallback && (
                    <div className="mt-4 border-t border-border2 pt-2">
                      <ProviderModelSelector form={form} models={models.filter(m => m.capabilities?.vision)} filteredModels={visionFilteredModels}
                        modelKey="visionModel" labelOverride={t("vision_fallback_model")} placeholderOverride={t("select_vision_model")}
                        fetching={fetching} fetchError={fetchError} modelSearch={visionModelSearch} modelListOpen={visionModelListOpen}
                        favoriteModels={favoriteModelsByProfile[form.id] ?? []}
                        updateForm={autoSaveField} onFetchModels={handleFetchModels} setModelSearch={setVisionModelSearch}
                        setModelListOpen={setVisionModelListOpen}
                        onToggleFavoriteModel={(model) => onToggleFavoriteModel(form.id, model)}
                        requiresAuthForModels={selectedPreset?.requiresAuthForModels ?? false}
                        isLocalProvider={false} // Local settings only shown for primary model
                        showRefreshButton={false}
                        showContextLength={false}
                        syncContextBudget={false}
                      />
                    </div>
                  )}

                  {/* Hint when no models are loaded yet but provider is selected */}
                  {!fetching && models.length === 0 && selectedPreset && !showVisionFallback && (
                    <div className="mt-2 text-[12px] text-t3 italic">
                      {t("refresh_models_vision_hint")}
                    </div>
                  )}

                  <ProviderBindingPanel
                    form={form}
                    favorites={favoriteModelsByProfile[form.id] ?? []}
                    updateForm={autoSaveField}
                    onSelectBindingModel={handleSelectBindingModel}
                  />

                  <ProviderSamplerPanel form={form} updateForm={lazyAutoSaveField} capabilities={capabilities} />

                  <ProviderQuotaPanel providerProfileId={form.id} />
                </>
              )}
            </>
          )
        }
        footer={
          activeCategory === "audio" ? undefined : (
            <div className={cn("shrink-0 border-t border-border", isMobile ? "px-4 py-3" : "px-6 py-4")}>
            <div className={cn("flex items-center gap-3", isMobile && "flex-wrap")}>
              <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-2">
                <span className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-t3 transition-colors hover:text-t1" onClick={() => void handleDuplicate()}>
                  <Icons.Copy /> {t("duplicate")}
                </span>
                {providerProfiles.length > 1 && (
                  <span className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-danger/80 transition-colors hover:text-danger" onClick={handleDelete}>
                    <Icons.Trash /> {t("delete")}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 font-ui text-[12px] text-t3 transition-opacity duration-300" style={{ opacity: autoSaveFlash ? 1 : 0 }}>
                <Icons.Floppy /> {t("autosaving")}
              </div>
              <div
                data-testid="default-proxy-control"
                className={cn("ml-auto flex min-w-0 items-center gap-2", isMobile ? "order-3 w-full" : "flex-1")}
              >
                <label className="shrink-0 font-ui text-[12px] text-t3">{t("default_proxy")}</label>
                <DropdownSelect
                  value={defaultProxyId ?? ""}
                  placeholder={t("proxy_direct")}
                  defaultOption={t("proxy_direct")}
                  options={proxies.map((proxy) => ({ id: proxy.id, label: proxy.name, detail: proxy.url }))}
                  onChange={(id) => void onSetDefaultProxy(id || null)}
                  className="min-w-0 flex-1"
                />
              </div>
            </div>
          </div>
          )
        }
      />
    </>
  );
}
