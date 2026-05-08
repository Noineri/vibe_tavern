import { useEffect, useRef, useState } from "react";
import type { ProviderProfileRecord } from "../app-client.js";
import type { ProviderProbeResponse } from "@rp-platform/domain";
import { PROVIDER_PRESETS } from "../provider-presets.js";
import { Icons } from "./shared/icons.js";
import {
  ProviderActionFooter,
  ProviderProfileListSection,
  ProviderFormFields,
  ProviderSamplerFields,
  ProviderModelSelectorSection,
  ProviderCapabilitySection,
} from "./provider-modal-sections.js";
import { useDirtyState } from "./shared/use-dirty-state.js";
import { ConfirmCloseModal } from "./shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";

export interface FormState {
  id: string;
  name: string;
  type: string;
  providerPreset: string;
  baseUrl: string;
  apiKey: string;
  hasStoredApiKey: boolean;
  model: string;
  temperature: number;
  topP: number;
  minP: number;
  topK: number;
  typicalP: number;
  repPen: number;
  freqPen: number;
  presPen: number;
  maxTokens: number;
  contextBudget: number;
  stopSeq: string;
  seed: string | null;
  reasoningEffort: string;
  streamResponse: boolean;
}

interface ModelOption { id: string; label: string; }

interface ProviderModalProps {
  isOpen: boolean;
  providerProfiles: ProviderProfileRecord[];
  activeProviderProfileId: string | null;
  onClose: () => void;
  onCreateProfile: () => Promise<ProviderProfileRecord | null>;
  onDuplicateProfile: (id: string) => Promise<ProviderProfileRecord | null>;
  onDeleteProfile: (id: string) => Promise<void>;
  onActivateProfile: (id: string) => Promise<void>;
  onSaveProfile: (form: FormState) => Promise<ProviderProfileRecord | null>;
  onTestDraft: (endpoint: string, apiKey: string) => Promise<ProviderProbeResponse>;
  onTestChat: (profileId: string | null, baseUrl: string, apiKey: string, model: string) => Promise<{ success: boolean; reply?: string; error?: string }>;
  onFetchModels: (baseUrl: string, apiKey?: string, useCache?: boolean) => Promise<ModelOption[]>;
  onRefreshProfiles: () => Promise<void>;
}

function profileToForm(p: ProviderProfileRecord): FormState {
  const preset = PROVIDER_PRESETS.find((f) => f.type === p.type && f.baseUrl === p.endpoint);
  return {
    id: p.id, name: p.name, type: p.type, providerPreset: preset?.id ?? "",
    baseUrl: p.endpoint, apiKey: "", hasStoredApiKey: p.hasStoredApiKey,
    model: p.defaultModel ?? "", temperature: p.temperature ?? 0.9, topP: p.topP ?? 1.0,
    minP: p.minP ?? 0.05, topK: p.topK ?? 40, typicalP: p.typicalP ?? 1.0,
    repPen: p.repPen ?? 1.1, freqPen: p.freqPen ?? 0.0, presPen: p.presPen ?? 0.0,
    maxTokens: p.maxTokens ?? 8192, contextBudget: p.contextBudget ?? 128000,
    stopSeq: p.stopSeq ?? "", seed: p.seed ?? null, reasoningEffort: p.reasoningEffort ?? "medium",
    streamResponse: p.streamResponse ?? true,
  };
}

interface Capabilities {
  nonStreamGeneration: boolean;
  abortSignal: boolean;
  streaming: boolean;
  prefill: boolean;
  sdkSupport: string;
}

function getCapabilities(type: string): Capabilities {
  switch (type) {
    case "anthropic": case "google":
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: false, sdkSupport: "native" };
    case "ollama": case "llamacpp":
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, sdkSupport: "openai_fallback" };
    case "koboldcpp":
      return { nonStreamGeneration: false, abortSignal: false, streaming: false, prefill: false, sdkSupport: "unsupported" };
    default:
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, sdkSupport: "native" };
  }
}

export function ProviderModal({
  isOpen, providerProfiles, activeProviderProfileId, onClose,
  onCreateProfile, onDuplicateProfile, onDeleteProfile, onActivateProfile,
  onSaveProfile, onTestDraft, onTestChat, onFetchModels, onRefreshProfiles,
}: ProviderModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [fetching, setFetching] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testingChat, setTestingChat] = useState(false);
  const [chatResult, setChatResult] = useState<{ reply?: string; error?: string } | null>(null);
  const { dirty, saveState, markDirty, triggerSave, reset } = useDirtyState();
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadCached = async (baseUrl: string, apiKey?: string) => {
    try { const c = await onFetchModels(baseUrl, apiKey, true); if (c.length > 0) setModels(c); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!isOpen) return;
    const target = activeProviderProfileId ?? providerProfiles[0]?.id ?? null;
    if (target) {
      const p = providerProfiles.find((pr) => pr.id === target);
      if (p) { setEditingId(p.id); setForm(profileToForm(p)); if (p.endpoint) void loadCached(p.endpoint); }
    }
    setTestOk(null); reset();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const h = (e: MouseEvent) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setModelListOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [isOpen]);

  if (!isOpen) return null;

  const updateForm = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((f) => f ? { ...f, [k]: v } : f); markDirty(); };

  const applyPreset = (presetId: string) => {
    const fmt = PROVIDER_PRESETS.find((f) => f.id === presetId);
    if (!fmt) return;
    setForm((f) => f ? { ...f, providerPreset: fmt.id, type: fmt.type, baseUrl: fmt.baseUrl } : f);
    markDirty();
  };

  const handleClose = () => dirty ? setConfirmClose(true) : onClose();

  const handleSelect = (id: string) => {
    const p = providerProfiles.find((pr) => pr.id === id);
    if (p) { setEditingId(p.id); setForm(profileToForm(p)); setTestOk(null); setModels([]); if (p.endpoint) void loadCached(p.endpoint); reset(); }
  };

  const handleAdd = async () => {
    const c = await onCreateProfile();
    if (c) { setEditingId(c.id); setForm(profileToForm(c)); setModels([]); setTestOk(null); reset(); }
  };

  const handleDuplicate = async () => {
    if (!editingId) return;
    const d = await onDuplicateProfile(editingId);
    if (d) { setEditingId(d.id); setForm(profileToForm(d)); setModels([]); setTestOk(null); reset(); }
  };

  const handleDelete = () => { if (providerProfiles.length > 1) setConfirmDelete(true); };

  const confirmDeleteAction = async () => {
    if (!editingId) return;
    await onDeleteProfile(editingId);
    const next = providerProfiles.find((p) => p.id !== editingId);
    if (next) { setEditingId(next.id); setForm(profileToForm(next)); }
    setConfirmDelete(false); reset();
  };

  const handleSaveProfile = async () => {
    if (!form) return;
    const saved = await onSaveProfile(form); if (saved) setForm(profileToForm(saved));
    reset();
  };

  const handleActivate = async () => { if (!editingId) return; await handleSaveProfile(); await onActivateProfile(editingId); onClose(); };

  const handleTestConnection = async () => {
    if (!form) return;
    setTesting(true); setTestOk(null);
    try {
      const r = await onTestDraft(form.baseUrl, form.apiKey); setTestOk(r.success);
      if (r.success && form.baseUrl.trim()) { const f = await onFetchModels(form.baseUrl.trim(), form.apiKey.trim() || undefined, true); if (f.length > 0) setModels(f); }
    } catch { setTestOk(false); } finally { setTesting(false); }
  };

  const handleTestChat = async () => {
    if (!form || !form.baseUrl.trim() || !form.model.trim()) return;
    setTestingChat(true); setChatResult(null);
    try { setChatResult(await onTestChat(editingId, form.baseUrl.trim(), form.apiKey.trim(), form.model.trim())); }
    catch (e) { setChatResult({ error: e instanceof Error ? e.message : "Request failed." }); }
    finally { setTestingChat(false); }
  };

  const handleFetchModels = async () => {
    if (!form) return;
    const ep = form.baseUrl.trim();
    if (!ep) { setFetchError("Endpoint URL is required."); return; }
    setFetching(true); setFetchError(null);
    try {
      const fetched = await onFetchModels(ep, form.apiKey.trim() || undefined, false);
      if (!fetched.length) setFetchError("No models returned. Check endpoint URL and API key.");
      setModels(fetched);
      if (fetched.length && (!form.model || !fetched.find((m) => m.id === form.model))) updateForm("model", fetched[0].id);
    } catch (e) { setModels([]); setFetchError(e instanceof Error ? e.message : "Failed to fetch models."); }
    finally { setFetching(false); }
  };

  const filteredProfiles = profileSearch.trim()
    ? providerProfiles.filter((p) => p.name.toLowerCase().includes(profileSearch.toLowerCase()) || p.type.toLowerCase().includes(profileSearch.toLowerCase()))
    : providerProfiles;
  const filteredModels = modelSearch.trim()
    ? models.filter((m) => m.label.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : models;
  const capabilities = form ? getCapabilities(form.type) : null;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={(e) => e.target === e.currentTarget && handleClose()}>
      {confirmClose && <ConfirmCloseModal onCancel={() => setConfirmClose(false)} onConfirm={() => { reset(); onClose(); }} />}
      {confirmDelete && (
        <DestructiveConfirmModal
          title="Delete provider"
          body={<>{/* TODO(i18n) */}Delete profile <b>{form?.name}</b>? This cannot be undone.</>}
          confirmLabel="Delete provider"
          onConfirm={() => void confirmDeleteAction()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <div className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]" style={{ width: 860, height: 680 }}>
        {/* HEADER */}
        <div className="shrink-0 border-b border-border px-6 pb-4 pt-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 font-body text-[18px] font-semibold text-t1" style={{ marginBottom: 4 }}>
                {/* TODO(i18n) */}Настройки провайдера
                {dirty && <span className="h-2 w-2 rounded-full bg-accent" title="Unsaved changes" />}
              </div>
              {/* TODO(i18n) */}<div className="font-ui text-[13px] text-t3">Профили провайдеров для API-подключений (локальных и облачных).</div>
            </div>
            <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1" onClick={handleClose}><Icons.Close /></div>
          </div>
          {dirty && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-s2 font-ui text-[12px] text-t2" style={{ padding: "5px 12px" }}>
              <span className="shrink-0 text-accent-t"><Icons.Edit /></span>
              {/* TODO(i18n) */}Несохранённые изменения
            </div>
          )}
        </div>

        {/* BODY */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ProviderProfileListSection
            filteredProfiles={filteredProfiles} editingId={editingId}
            activeProviderProfileId={activeProviderProfileId} profileSearch={profileSearch}
            onProfileSearchChange={setProfileSearch} onSelectProfile={handleSelect} onAddProfile={handleAdd}
          />
          <div className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
            {!form ? (
              <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">
                {/* TODO(i18n) */}Выберите профиль или создайте новый.
              </div>
            ) : (
              <>
                <ProviderFormFields form={form} editingId={editingId} providerProfiles={providerProfiles}
                  updateForm={updateForm} applyPreset={applyPreset} testOk={testOk} testing={testing}
                  testingChat={testingChat} chatResult={chatResult} onTest={handleTestConnection} onTestChat={handleTestChat}
                />
                <ProviderModelSelectorSection form={form} models={models} filteredModels={filteredModels}
                  fetching={fetching} fetchError={fetchError} modelSearch={modelSearch} modelListOpen={modelListOpen}
                  updateForm={updateForm} onFetchModels={handleFetchModels} setModelSearch={setModelSearch}
                  setModelListOpen={setModelListOpen} dropdownRef={dropdownRef}
                />
                <ProviderCapabilitySection capabilities={capabilities} />
                <ProviderSamplerFields form={form} updateForm={updateForm} />
              </>
            )}
          </div>
        </div>

        {/* FOOTER */}
        <ProviderActionFooter providerProfiles={providerProfiles} saveState={saveState}
          onDuplicate={handleDuplicate} onDelete={handleDelete}
          onSave={() => triggerSave(() => void handleSaveProfile())} onActivate={handleActivate}
        />
      </div>
    </div>
  );
}
