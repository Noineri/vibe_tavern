import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import type { FavoriteProviderModelRecord, ProviderProfileRecord } from "../../app-client.js";
import { PROVIDER_PRESET_GROUP, resolveLogitBiasSupport, resolveSamplerCapabilities } from "@vibe-tavern/domain";
import type { ProviderProbeResponse, SamplerCapabilityFlags } from "@vibe-tavern/domain";
import { saveProviderDraftSchema } from "@vibe-tavern/api-contracts";
import { PROVIDER_PRESETS, getVisibleProviderPresets } from "../../provider-presets.js";
import { Icons } from "../shared/icons.js";
import {
  ProviderProfileList,
  ProviderEditHeader,
  ProviderViewHeader,
  ProviderModelSelector,
  ProviderCapabilityPanel,
  ProviderSamplerPanel,
} from "../settings/provider/index.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";

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
  stopSequences: string[];
  logitBias: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
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

interface ProviderModalProps {
  providerProfiles: ProviderProfileRecord[];
  activeProviderProfileId: string | null;
  onCreateProfile: () => Promise<ProviderProfileRecord | null>;
  onDuplicateProfile: (id: string) => Promise<ProviderProfileRecord | null>;
  onDeleteProfile: (id: string) => Promise<void>;
  onActivateProfile: (id: string) => Promise<void>;
  onSaveProfile: (form: FormState) => Promise<ProviderProfileRecord | null>;
  onTestDraft: (endpoint: string, apiKey: string, providerType?: string) => Promise<ProviderProbeResponse>;
  onTestProfile: (profileId: string) => Promise<ProviderProbeResponse>;
  onTestChat: (profileId: string | null, baseUrl: string, apiKey: string, model: string, providerType?: string) => Promise<{ success: boolean; reply?: string; error?: string }>;
  onFetchModels: (baseUrl: string, apiKey?: string, useCache?: boolean, providerType?: string) => Promise<ModelOption[]>;
  onFetchModelsForProfile: (profileId: string) => Promise<ModelOption[]>;
  favoriteModelsByProfile: Record<string, FavoriteProviderModelRecord[]>;
  onToggleFavoriteModel: (profileId: string, model: ModelOption) => Promise<void>;
  onRefreshProfiles: () => Promise<void>;
}

function profileToForm(p: ProviderProfileRecord): FormState {
  const preset = PROVIDER_PRESETS.find((f) => f.id === p.providerPreset)
    ?? PROVIDER_PRESETS.find((f) => f.type === p.providerPreset && f.baseUrl === p.endpoint);
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
    stopSequences: p.stopSequences,
    logitBias: p.logitBias ?? [],
    seed: p.seed ?? null, showReasoning: p.showReasoning,
    reasoningEffort: p.reasoningEffort,
    streamResponse: p.streamResponse,
    customSamplers: p.customSamplers ?? false,
  };
}

function toProviderDraft(form: FormState) {
  return {
    id: form.id,
    name: form.name,
    providerPreset: form.providerPreset,
    endpoint: form.baseUrl,
    apiKey: form.apiKey || null,
    defaultModel: form.model || null,
    visionModel: form.visionModel || null,
    contextBudget: form.contextBudget || null,
    pinContextBudget: form.pinContextBudget,
    temperature: form.temperature,
    topP: form.topP,
    minP: form.minP,
    topK: form.topK,
    topA: form.topA,
    typicalP: form.typicalP,
    tfsZ: form.tfsZ,
    repeatLastN: form.repeatLastN,
    mirostat: form.mirostat,
    mirostatTau: form.mirostatTau,
    mirostatEta: form.mirostatEta,
    dryMultiplier: form.dryMultiplier,
    dryBase: form.dryBase,
    dryAllowedLength: form.dryAllowedLength,
    drySequenceBreakers: form.drySequenceBreakers,
    xtcThreshold: form.xtcThreshold,
    xtcProbability: form.xtcProbability,
    frequencyPenalty: form.frequencyPenalty,
    presencePenalty: form.presencePenalty,
    repetitionPenalty: form.repetitionPenalty,
    maxTokens: form.maxTokens,
    stopSequences: form.stopSequences,
    logitBias: form.logitBias,
    seed: form.seed,
    reasoningEffort: form.reasoningEffort,
    showReasoning: form.showReasoning,
    streamResponse: form.streamResponse,
    customSamplers: form.customSamplers,
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
    case "anthropic": case "google":
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: false, logitBias: false, samplers: resolveSamplerCapabilities(providerPreset, type) };
    case "ollama": case "llamacpp":
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, logitBias: resolveLogitBiasSupport(providerPreset, model, endpoint).supported, samplers: resolveSamplerCapabilities(providerPreset, type) };
    case "koboldcpp":
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
}: ProviderModalProps) {
  const isOpen = useModalStore((s) => s.isProviderModalOpen);
  const setIsOpen = useModalStore((s) => s.setIsProviderModalOpen);
  const isArmServer = useBootstrapStore((s) => s.data?.isArmServer ?? false);
  const visiblePresets = getVisibleProviderPresets(isArmServer);
  const onClose = () => setIsOpen(false);
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const visionDropdownRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

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
    try { const c = await onFetchModelsForProfile(profileId); if (c.length > 0) setModels(c); } catch { /* ignore */ }
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
  }, [isOpen]);

  useEffect(() => {
    latestFormRef.current = form;
  }, [form]);

  useEffect(() => {
    if (!isOpen) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      const isOutMain = !dropdownRef.current?.contains(target);
      const isOutVision = !visionDropdownRef.current?.contains(target);
      
      const portal = document.getElementById('modal-portal');
      const inPortal = portal?.contains(target);
      if (inPortal) return;

      if (isOutMain) setModelListOpen(false);
      if (isOutVision) setVisionModelListOpen(false);
    };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [isOpen]);

  useEffect(() => () => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    if (lazyAutoSaveTimer.current) clearTimeout(lazyAutoSaveTimer.current);
  }, []);

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
    const parsed = saveProviderDraftSchema.safeParse(toProviderDraft(next));
    if (parsed.success) void onSaveProfile(next);
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
    if (c) { setEditingId(c.id); setForm(profileToForm(c)); setModels([]); setTestOk(null); setIsNew(true); setHeaderMode("edit"); setDirty(false); }
  };

  // ── Duplicate ──
  const handleDuplicate = async () => {
    if (!editingId) return;
    const d = await onDuplicateProfile(editingId);
    if (d) { setEditingId(d.id); setForm(profileToForm(d)); setModels([]); setTestOk(null); setIsNew(true); setHeaderMode("edit"); setDirty(false); }
  };

  // ── Delete ──
  const handleDelete = () => { if (providerProfiles.length > 1) setConfirmDelete(true); };

  const confirmDeleteAction = async () => {
    if (!editingId) return;
    await onDeleteProfile(editingId);
    const next = providerProfiles.find((p) => p.id !== editingId);
    if (next) { setEditingId(next.id); setForm(profileToForm(next)); }
    setConfirmDelete(false); setHeaderMode("view"); setIsNew(false); setDirty(false);
  };

  // ── Save header (connection settings) ──
  const handleSaveHeader = async () => {
    if (!form) return;
    const parsed = saveProviderDraftSchema.safeParse(toProviderDraft(form));
    if (!parsed.success) return;
    const saved = await onSaveProfile(form);
    if (saved) setForm(profileToForm(saved));
    setHeaderMode("view"); setIsNew(false); setDirty(false);
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
  const handleClose = () => {
    flushLazyAutoSave();
    dirty ? setConfirmClose(true) : onClose();
  };

  // ── Test connection ──
  const handleTestConnection = async () => {
    if (!form) return;
    setTesting(true); setTestOk(null);
    try {
      let r: ProviderProbeResponse;
      if (editingId && !isNew) {
        r = await onTestProfile(editingId);
      } else {
        const preset = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset);
        r = await onTestDraft(form.baseUrl, form.apiKey, preset?.type);
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
        fetched = await onFetchModels(ep, form.apiKey.trim() || undefined, false, preset?.type);
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
    try { setChatResult(await onTestChat(editingId, form.baseUrl.trim(), form.apiKey.trim(), form.model.trim(), preset?.type)); }
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
  const filteredModels = modelSearch.trim()
    ? models.filter((m) => m.label.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : models;
  
  const hasVisionModels = models.some(m => m.capabilities?.vision);
  const allVisionModels = models.length > 0 && models.every(m => m.capabilities?.vision);
  const showVisionFallback = hasVisionModels && !allVisionModels;
  
  const visionFilteredModels = visionModelSearch.trim()
    ? models.filter(m => m.capabilities?.vision && (m.label.toLowerCase().includes(visionModelSearch.toLowerCase()) || m.id.toLowerCase().includes(visionModelSearch.toLowerCase())))
    : models.filter(m => m.capabilities?.vision);

  return (
    <>
      {confirmClose && <ConfirmCloseModal onCancel={() => setConfirmClose(false)} onConfirm={() => { setConfirmClose(false); setDirty(false); onClose(); }} />}
      {confirmDelete && (
        <DestructiveConfirmModal
          title={t("delete_provider_title")}
          body={<>Delete profile <b>{form?.name}</b>? {t("delete_provider_body")}</>}
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
        detailTitle={form?.name ?? t("provider_settings_title")}
        dirty={dirty}
        containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[680px] w-[860px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        masterClassName="flex w-[220px] shrink-0 flex-col border-r border-border bg-s1"
        detailClassName={isMobile ? "p-4" : "p-5"}
        headerClassName={isMobile ? "px-3 py-2.5" : "px-6 pt-5 pb-4"}
        masterContent={() => (
          <ProviderProfileList
            filteredProfiles={filteredProfiles} editingId={editingId}
            activeProviderProfileId={activeProviderProfileId} profileSearch={profileSearch}
            onProfileSearchChange={setProfileSearch}
            onSelectProfile={(id) => { handleSelect(id); }}
            onAddProfile={() => { void handleAdd(); }}
          />
        )}
        detailContent={
          !form ? (
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
                  testOk={testOk} testing={testing} onTest={handleTestConnection}
                  onSave={() => void handleSaveHeader()}
                  onCancel={!isNew ? handleCancelEdit : undefined}
                  isNew={isNew}
                  isArmServer={isArmServer}
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
                  <ProviderModelSelector form={form} models={models} filteredModels={filteredModels}
                    fetching={fetching} fetchError={fetchError} modelSearch={modelSearch} modelListOpen={modelListOpen}
                    favoriteModels={favoriteModelsByProfile[form.id] ?? []}
                    updateForm={autoSaveField} onFetchModels={handleFetchModels} setModelSearch={setModelSearch}
                    setModelListOpen={setModelListOpen} dropdownRef={dropdownRef}
                    onToggleFavoriteModel={(model) => onToggleFavoriteModel(form.id, model)}
                    requiresAuthForModels={selectedPreset?.requiresAuthForModels ?? false}
                    isLocalProvider={isLocalProvider}
                    localEndpoint={form.baseUrl}
                    localConnectionStatus={fetching || testing ? "checking" : fetchError || testOk === false ? "offline" : testOk === true ? "online" : "unknown"}
                  />

                  {showVisionFallback && (
                    <div className="mt-4 border-t border-border2 pt-2">
                      <ProviderModelSelector form={form} models={models.filter(m => m.capabilities?.vision)} filteredModels={visionFilteredModels}
                        modelKey="visionModel" labelOverride={t("vision_fallback_model")} placeholderOverride={t("select_vision_model")}
                        fetching={fetching} fetchError={fetchError} modelSearch={visionModelSearch} modelListOpen={visionModelListOpen}
                        favoriteModels={favoriteModelsByProfile[form.id] ?? []}
                        updateForm={autoSaveField} onFetchModels={handleFetchModels} setModelSearch={setVisionModelSearch}
                        setModelListOpen={setVisionModelListOpen} dropdownRef={visionDropdownRef}
                        onToggleFavoriteModel={(model) => onToggleFavoriteModel(form.id, model)}
                        requiresAuthForModels={selectedPreset?.requiresAuthForModels ?? false}
                        isLocalProvider={false} // Local settings only shown for primary model
                      />
                    </div>
                  )}

                  {/* Hint when no models are loaded yet but provider is selected */}
                  {!fetching && models.length === 0 && selectedPreset && !showVisionFallback && (
                    <div className="mt-2 text-[12px] text-t3 italic">
                      Refresh models to see vision-capable options
                    </div>
                  )}

                  {/* Test Hi */}
                  {form.model && (
                    <div className="mb-4">
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
                  <ProviderSamplerPanel form={form} updateForm={lazyAutoSaveField} capabilities={capabilities} />
                </>
              )}
            </>
          )
        }
        footer={
          <div className={cn("shrink-0 items-center justify-between border-t border-border", isMobile ? "flex flex-wrap gap-2 px-4 py-3" : "flex px-6 py-4")}>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <span className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-t3 transition-colors hover:text-t1" onClick={() => void handleDuplicate()}>
                <Icons.Copy /> {t("duplicate")}
              </span>
              {providerProfiles.length > 1 && (
                <span className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-danger/80 transition-colors hover:text-danger" onClick={handleDelete}>
                  <Icons.Trash /> {t("delete")}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2 font-ui text-[12px] text-t3 transition-opacity duration-300" style={{ opacity: autoSaveFlash ? 1 : 0 }}>
              <Icons.Floppy /> {t("autosaving")}
            </div>
          </div>
        }
      />
    </>
  );
}
