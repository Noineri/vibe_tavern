import { useEffect, useRef, useState } from "react";
import type { ProviderProbeResponse } from "@rp-platform/domain";
import type { ProviderProfileRecord } from "../app-client.js";
import { cn } from "../lib/cn.js";
import { PROVIDER_PRESETS } from "../provider-presets.js";
import {
  ProviderCapabilityPanel,
  ProviderForm,
  ProviderModelSelector,
  ProviderProfileList,
  ProviderSamplerPanel,
} from "./provider/index.js";
import { ConfirmCloseModal } from "./shared/confirm-close-modal.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";
import { Icons } from "./shared/icons.js";
import { useDirtyState } from "./shared/use-dirty-state.js";

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

interface ModelOption {
  id: string;
  label: string;
}

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

function profileToForm(profile: ProviderProfileRecord): FormState {
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.type === profile.type && candidate.baseUrl === profile.endpoint);

  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    providerPreset: preset?.id ?? "",
    baseUrl: profile.endpoint,
    apiKey: "",
    hasStoredApiKey: profile.hasStoredApiKey,
    model: profile.defaultModel ?? "",
    temperature: profile.temperature ?? 0.9,
    topP: profile.topP ?? 1.0,
    minP: profile.minP ?? 0.05,
    topK: profile.topK ?? 40,
    typicalP: profile.typicalP ?? 1.0,
    repPen: profile.repPen ?? 1.1,
    freqPen: profile.freqPen ?? 0.0,
    presPen: profile.presPen ?? 0.0,
    maxTokens: profile.maxTokens ?? 8192,
    contextBudget: profile.contextBudget ?? 128000,
    stopSeq: profile.stopSeq ?? "",
    seed: profile.seed ?? null,
    reasoningEffort: profile.reasoningEffort ?? "medium",
    streamResponse: profile.streamResponse ?? true,
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
    case "anthropic":
    case "google":
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: false, sdkSupport: "native" };
    case "ollama":
    case "llamacpp":
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, sdkSupport: "openai_fallback" };
    case "koboldcpp":
      return { nonStreamGeneration: false, abortSignal: false, streaming: false, prefill: false, sdkSupport: "unsupported" };
    default:
      return { nonStreamGeneration: true, abortSignal: true, streaming: true, prefill: true, sdkSupport: "native" };
  }
}

export function ProviderModal({
  isOpen,
  providerProfiles,
  activeProviderProfileId,
  onClose,
  onCreateProfile,
  onDuplicateProfile,
  onDeleteProfile,
  onActivateProfile,
  onSaveProfile,
  onTestDraft,
  onTestChat,
  onFetchModels,
  onRefreshProfiles,
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
    try {
      const cachedModels = await onFetchModels(baseUrl, apiKey, true);
      if (cachedModels.length > 0) setModels(cachedModels);
    } catch {
      // Cache miss should not block opening the modal.
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    const targetProfileId = activeProviderProfileId ?? providerProfiles[0]?.id ?? null;
    if (targetProfileId) {
      const targetProfile = providerProfiles.find((profile) => profile.id === targetProfileId);
      if (targetProfile) {
        setEditingId(targetProfile.id);
        setForm(profileToForm(targetProfile));
        if (targetProfile.endpoint) void loadCached(targetProfile.endpoint);
      }
    }

    setTestOk(null);
    setChatResult(null);
    reset();
    void onRefreshProfiles();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setModelListOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen]);

  if (!isOpen) return null;

  const updateForm = <FormKey extends keyof FormState>(key: FormKey, value: FormState[FormKey]) => {
    setForm((currentForm) => (currentForm ? { ...currentForm, [key]: value } : currentForm));
    markDirty();
  };

  const applyPreset = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;

    setForm((currentForm) =>
      currentForm
        ? {
            ...currentForm,
            providerPreset: preset.id,
            type: preset.type,
            baseUrl: preset.baseUrl,
          }
        : currentForm,
    );
    markDirty();
  };

  const handleClose = () => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }

    onClose();
  };

  const handleSelect = (profileId: string) => {
    const selectedProfile = providerProfiles.find((profile) => profile.id === profileId);
    if (!selectedProfile) return;

    setEditingId(selectedProfile.id);
    setForm(profileToForm(selectedProfile));
    setTestOk(null);
    setChatResult(null);
    setModels([]);
    if (selectedProfile.endpoint) void loadCached(selectedProfile.endpoint);
    reset();
  };

  const handleAdd = async () => {
    const createdProfile = await onCreateProfile();
    if (!createdProfile) return;

    setEditingId(createdProfile.id);
    setForm(profileToForm(createdProfile));
    setModels([]);
    setTestOk(null);
    setChatResult(null);
    reset();
  };

  const handleDuplicate = async () => {
    if (!editingId) return;

    const duplicatedProfile = await onDuplicateProfile(editingId);
    if (!duplicatedProfile) return;

    setEditingId(duplicatedProfile.id);
    setForm(profileToForm(duplicatedProfile));
    setModels([]);
    setTestOk(null);
    setChatResult(null);
    reset();
  };

  const handleDelete = () => {
    if (providerProfiles.length > 1) setConfirmDelete(true);
  };

  const confirmDeleteAction = async () => {
    if (!editingId) return;

    await onDeleteProfile(editingId);
    const nextProfile = providerProfiles.find((profile) => profile.id !== editingId);
    if (nextProfile) {
      setEditingId(nextProfile.id);
      setForm(profileToForm(nextProfile));
    }

    setConfirmDelete(false);
    reset();
  };

  const handleSaveProfile = async () => {
    if (!form) return;

    const savedProfile = await onSaveProfile(form);
    if (savedProfile) setForm(profileToForm(savedProfile));
    reset();
  };

  const handleActivate = async () => {
    if (!editingId) return;

    await handleSaveProfile();
    await onActivateProfile(editingId);
    onClose();
  };

  const handleTestConnection = async () => {
    if (!form) return;

    setTesting(true);
    setTestOk(null);
    try {
      const response = await onTestDraft(form.baseUrl, form.apiKey);
      setTestOk(response.success);
      if (response.success && form.baseUrl.trim()) {
        const fetchedModels = await onFetchModels(form.baseUrl.trim(), form.apiKey.trim() || undefined, true);
        if (fetchedModels.length > 0) setModels(fetchedModels);
      }
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  };

  const handleTestChat = async () => {
    if (!form || !form.baseUrl.trim() || !form.model.trim()) return;

    setTestingChat(true);
    setChatResult(null);
    try {
      setChatResult(await onTestChat(editingId, form.baseUrl.trim(), form.apiKey.trim(), form.model.trim()));
    } catch (error) {
      setChatResult({ error: error instanceof Error ? error.message : "Request failed." });
    } finally {
      setTestingChat(false);
    }
  };

  const handleFetchModels = async () => {
    if (!form) return;

    const endpoint = form.baseUrl.trim();
    if (!endpoint) {
      setFetchError("Endpoint URL is required.");
      return;
    }

    setFetching(true);
    setFetchError(null);
    try {
      const fetchedModels = await onFetchModels(endpoint, form.apiKey.trim() || undefined, false);
      if (!fetchedModels.length) setFetchError("No models returned. Check endpoint URL and API key.");
      setModels(fetchedModels);
      if (fetchedModels.length && (!form.model || !fetchedModels.find((model) => model.id === form.model))) {
        updateForm("model", fetchedModels[0].id);
      }
    } catch (error) {
      setModels([]);
      setFetchError(error instanceof Error ? error.message : "Failed to fetch models.");
    } finally {
      setFetching(false);
    }
  };

  const filteredProfiles = profileSearch.trim()
    ? providerProfiles.filter(
        (profile) =>
          profile.name.toLowerCase().includes(profileSearch.toLowerCase()) ||
          profile.type.toLowerCase().includes(profileSearch.toLowerCase()),
      )
    : providerProfiles;
  const filteredModels = modelSearch.trim()
    ? models.filter(
        (model) =>
          model.label.toLowerCase().includes(modelSearch.toLowerCase()) ||
          model.id.toLowerCase().includes(modelSearch.toLowerCase()),
      )
    : models;
  const capabilities = form ? getCapabilities(form.type) : null;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={(event) => event.target === event.currentTarget && handleClose()}>
      {confirmClose && <ConfirmCloseModal onCancel={() => setConfirmClose(false)} onConfirm={() => { reset(); onClose(); }} />}
      {confirmDelete && (
        <DestructiveConfirmModal
          title="Delete provider"
          body={<>Delete profile <b>{form?.name}</b>? This cannot be undone.</>}
          confirmLabel="Delete provider"
          onConfirm={() => void confirmDeleteAction()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <div className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]" style={{ width: 860, height: 680 }}>
        {/* HEADER */}
        <div className="shrink-0 border-b border-border" style={{ padding: "20px 24px 16px" }}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 font-body text-[18px] font-semibold text-t1" style={{ marginBottom: 4 }}>
                Настройки провайдера
                {dirty && <span className="h-2 w-2 rounded-full bg-accent" title="Unsaved changes" />}
              </div>
              <div className="font-ui text-[13px] text-t3">Профили провайдеров для API-подключений (локальных и облачных).</div>
            </div>
            <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1" onClick={handleClose}>
              <Icons.Close />
            </div>
          </div>
          {dirty && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-s2 font-ui text-[12px] text-t2" style={{ padding: "5px 12px" }}>
              <span className="shrink-0 text-accent-t"><Icons.Edit /></span>
              Несохранённые изменения
            </div>
          )}
        </div>

        {/* BODY — sidebar + main */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ProviderProfileList
            filteredProfiles={filteredProfiles}
            editingId={editingId}
            activeProviderProfileId={activeProviderProfileId}
            profileSearch={profileSearch}
            onProfileSearchChange={setProfileSearch}
            onSelectProfile={handleSelect}
            onAddProfile={handleAdd}
          />

          <div className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
            {!form ? (
              <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">
                Выберите профиль или создайте новый.
              </div>
            ) : (
              <>
                <ProviderForm
                  form={form}
                  editingId={editingId}
                  providerProfiles={providerProfiles}
                  updateForm={updateForm}
                  applyPreset={applyPreset}
                  testOk={testOk}
                  testing={testing}
                  testingChat={testingChat}
                  chatResult={chatResult}
                  onTest={handleTestConnection}
                  onTestChat={handleTestChat}
                />

                <ProviderModelSelector
                  form={form}
                  models={models}
                  filteredModels={filteredModels}
                  fetching={fetching}
                  fetchError={fetchError}
                  modelSearch={modelSearch}
                  modelListOpen={modelListOpen}
                  updateForm={updateForm}
                  onFetchModels={handleFetchModels}
                  setModelSearch={setModelSearch}
                  setModelListOpen={setModelListOpen}
                  dropdownRef={dropdownRef}
                />

                <ProviderCapabilityPanel capabilities={capabilities} />

                <ProviderSamplerPanel form={form} updateForm={updateForm} />
              </>
            )}
          </div>
        </div>

        {/* FOOTER */}
        <div className="flex shrink-0 items-center justify-between border-t border-border" style={{ padding: "16px 24px" }}>
          <div className="flex gap-4">
            <span
              className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-t3 transition-colors hover:text-t1"
              onClick={() => void handleDuplicate()}
            >
              <Icons.Copy /> Дублировать провайдер
            </span>
            {providerProfiles.length > 1 && (
              <span
                className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-danger/80 transition-colors hover:text-danger"
                onClick={handleDelete}
              >
                <Icons.Trash /> Удалить профиль
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              className={cn(
                "h-[37px] rounded-md border font-ui text-[13px] font-medium transition-colors",
                saveState === "saved"
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
              )}
              style={{ padding: "0 24px" }}
              onClick={() => triggerSave(() => void handleSaveProfile())}
            >
              {saveState === "saving" ? "Сохранение..." : saveState === "saved" ? "Сохранено" : "Сохранить профиль"}
            </button>
            <button
              className="h-[37px] rounded-md bg-accent font-ui text-[13px] font-medium text-white shadow-lg shadow-accent/20 transition-all hover:bg-accent-t"
              style={{ padding: "0 24px" }}
              onClick={() => void handleActivate()}
            >
              Сделать активным
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
