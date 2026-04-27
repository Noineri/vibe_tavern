import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderProfileRecord } from "../app-client.js";
import type { ProviderProbeResponse } from "@rp-platform/api-contracts";
import {
  PRESET_GROUPS,
  PROVIDER_PRESETS,
  TYPE_LABELS,
  getPresetGroup,
} from "../provider-presets.js";
import { Icons } from "./shared/icons.js";
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

function profileToForm(p: ProviderProfileRecord): FormState {
  const preset = PROVIDER_PRESETS.find((f) => f.type === p.type && f.baseUrl === p.endpoint);
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    providerPreset: preset?.id ?? "",
    baseUrl: p.endpoint,
    apiKey: "",
    hasStoredApiKey: p.hasStoredApiKey,
    model: p.defaultModel ?? "",
    temperature: p.temperature ?? 0.9,
    topP: p.topP ?? 1.0,
    minP: p.minP ?? 0.05,
    topK: p.topK ?? 40,
    typicalP: p.typicalP ?? 1.0,
    repPen: p.repPen ?? 1.1,
    freqPen: p.freqPen ?? 0.0,
    presPen: p.presPen ?? 0.0,
    maxTokens: p.maxTokens ?? 8192,
    stopSeq: p.stopSeq ?? "",
    seed: p.seed ?? null,
    reasoningEffort: p.reasoningEffort ?? "medium",
    streamResponse: p.streamResponse ?? true,
  };
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

  const loadCachedModels = async (baseUrl: string, apiKey?: string) => {
    try {
      const cached = await onFetchModels(baseUrl, apiKey, true);
      if (cached.length > 0) setModels(cached);
    } catch {}
  };

  useEffect(() => {
    if (!isOpen) return;
    const target = activeProviderProfileId ?? providerProfiles[0]?.id ?? null;
    if (target) {
      const p = providerProfiles.find((pr) => pr.id === target);
      if (p) {
        setEditingId(p.id);
        setForm(profileToForm(p));
        if (p.endpoint) void loadCachedModels(p.endpoint, undefined);
      }
    }
    setTestOk(null);
    reset();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setModelListOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  if (!isOpen) return null;

  const updateForm = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    markDirty();
  };

  const applyPreset = (presetId: string) => {
    const fmt = PROVIDER_PRESETS.find((f) => f.id === presetId);
    if (!fmt) return;
    setForm((f) =>
      f
        ? {
            ...f,
            providerPreset: fmt.id,
            type: fmt.type,
            baseUrl: fmt.baseUrl,
          }
        : f,
    );
    markDirty();
  };

  const handleClose = () => {
    if (dirty) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  const handleSelect = (id: string) => {
    const p = providerProfiles.find((pr) => pr.id === id);
    if (p) {
      setEditingId(p.id);
      setForm(profileToForm(p));
      setTestOk(null);
      setModels([]);
      if (p.endpoint) void loadCachedModels(p.endpoint, undefined);
      reset();
    }
  };

  const handleAdd = async () => {
    const created = await onCreateProfile();
    if (created) {
      setEditingId(created.id);
      setForm(profileToForm(created));
      setModels([]);
      setTestOk(null);
      reset();
    }
  };

  const handleDuplicate = async () => {
    if (!editingId) return;
    const dup = await onDuplicateProfile(editingId);
    if (dup) {
      setEditingId(dup.id);
      setForm(profileToForm(dup));
      setModels([]);
      setTestOk(null);
      reset();
    }
  };

  const handleDelete = () => {
    if (providerProfiles.length <= 1) return;
    setConfirmDelete(true);
  };

  const confirmDeleteAction = async () => {
    if (!editingId) return;
    await onDeleteProfile(editingId);
    const remaining = providerProfiles.filter((p) => p.id !== editingId);
    const next = remaining[0];
    if (next) {
      setEditingId(next.id);
      setForm(profileToForm(next));
    }
    setConfirmDelete(false);
    reset();
  };

  const handleSaveProfile = async () => {
    if (!form) return;
    const saved = await onSaveProfile(form);
    if (saved) {
      setForm(profileToForm(saved));
    }
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
      const result = await onTestDraft(form.baseUrl, form.apiKey);
      setTestOk(result.success);
      if (result.success && form.baseUrl.trim()) {
        const apiKey = form.apiKey.trim() || undefined;
        const fetched = await onFetchModels(form.baseUrl.trim(), apiKey, true);
        if (fetched.length > 0) setModels(fetched);
      }
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  };

  const handleTestChat = async () => {
    if (!form) return;
    const endpoint = form.baseUrl.trim();
    const model = form.model.trim();
    if (!endpoint || !model) return;
    setTestingChat(true);
    setChatResult(null);
    try {
      const result = await onTestChat(editingId, endpoint, form.apiKey.trim(), model);
      setChatResult(result);
    } catch (err) {
      setChatResult({ error: err instanceof Error ? err.message : "Request failed." });
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
      const apiKey = form.apiKey.trim() || undefined;
      const fetched = await onFetchModels(endpoint, apiKey, false);
      if (fetched.length === 0) {
        setFetchError("No models returned. Check endpoint URL and API key.");
      }
      setModels(fetched);
      if (fetched.length > 0 && (!form.model || !fetched.find((m) => m.id === form.model))) {
        updateForm("model", fetched[0].id);
      }
    } catch (err) {
      setModels([]);
      setFetchError(err instanceof Error ? err.message : "Failed to fetch models.");
    } finally {
      setFetching(false);
    }
  };

  const filteredProfiles = profileSearch.trim()
    ? providerProfiles.filter(
        (p) =>
          p.name.toLowerCase().includes(profileSearch.toLowerCase()) ||
          p.type.toLowerCase().includes(profileSearch.toLowerCase()),
      )
    : providerProfiles;

  const presetGroup = form ? getPresetGroup(form.providerPreset) : null;
  const filteredPresets = presetGroup
    ? PROVIDER_PRESETS.filter((f) => f.group === presetGroup)
    : PROVIDER_PRESETS;
  const presetEndpoint = form?.providerPreset
    ? PROVIDER_PRESETS.find((f) => f.id === form.providerPreset)?.baseUrl ?? ""
    : "";

  const filteredModels = modelSearch.trim()
    ? models.filter(
        (m) =>
          m.label.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.id.toLowerCase().includes(modelSearch.toLowerCase()),
      )
    : models;

  const duplicateNameWarning =
    form?.name &&
    providerProfiles.some(
      (p) => p.id !== editingId && p.name.trim().toLowerCase() === form.name.trim().toLowerCase(),
    );

  return (
    <div className="api-overlay" onClick={(e) => e.target === e.currentTarget && handleClose()}>
      {confirmClose && (
        <ConfirmCloseModal
          onCancel={() => setConfirmClose(false)}
          onConfirm={() => {
            reset();
            onClose();
          }}
        />
      )}
      {confirmDelete && (
        <DestructiveConfirmModal
          title="Delete provider"
          body={
            <>
              Delete profile <b>{form?.name}</b>? This cannot be undone.
            </>
          }
          confirmLabel="Delete provider"
          onConfirm={() => void confirmDeleteAction()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <div
        className="api-modal"
        style={{ width: 860, height: 680 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="api-head"
          style={{ paddingBottom: 16, borderBottom: "1px solid var(--border)" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                className="api-title"
                style={{ display: "flex", alignItems: "center" }}
              >
                Provider Settings
                {dirty && <span className="dirty-dot" title="Unsaved changes" />}
              </div>
              <div className="api-sub">
                Provider profiles for API connections (local and cloud).
              </div>
            </div>
            <button
              className="iBtn"
              aria-label="Close provider settings"
              title="Close provider settings"
              onClick={handleClose}
            >
              <Icons.Close />
            </button>
          </div>
        </div>

        <div
          className="api-body"
          style={{ padding: 0, display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}
        >
          {dirty && (
            <div className="unsaved-bar" style={{ margin: "12px 20px 0" }}>
              <Icons.Edit />
              Unsaved changes
            </div>
          )}
          <div className="pm-layout" style={{ margin: 0, width: "100%", flex: 1, minHeight: 0 }}>
            <div className="pm-nav" style={{ width: 220, minWidth: 220 }}>
              <div className="sb-lbl" style={{ padding: "4px 14px 8px" }}>
                Profiles
              </div>
              <div className="sb-search" style={{ margin: "0 10px 6px" }} title="Search profiles">
                <Icons.Search />
                <input
                  placeholder="Search profiles..."
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                />
              </div>
              {filteredProfiles.map((p) => {
                const isSelected = editingId === p.id;
                const isActive = activeProviderProfileId === p.id;
                const dotClass = isActive
                  ? p.hasStoredApiKey
                    ? "ok"
                    : "err"
                  : "none";
                return (
                  <div
                    key={p.id}
                    className={`pm-preset${isSelected ? " act" : ""}`}
                    onClick={() => handleSelect(p.id)}
                    style={{
                      whiteSpace: "normal",
                      padding: "10px 14px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        className={`provider-dot ${dotClass}`}
                        style={{
                          width: 8,
                          height: 8,
                          flexShrink: 0,
                          borderRadius: "50%",
                          background:
                            dotClass === "ok"
                              ? "oklch(0.68 0.16 145)"
                              : dotClass === "err"
                                ? "oklch(0.62 0.2 25)"
                                : "var(--t4)",
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          className="long-name-cell"
                          title={p.name}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isActive ? "★ " : ""}
                          {p.name}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: isSelected ? "var(--accent)" : "var(--t3)",
                            marginTop: 3,
                          }}
                        >
                          {TYPE_LABELS[p.type] || p.type}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="pm-add-btn" onClick={() => void handleAdd()}>
                + New profile
              </div>
            </div>

            <div className="pm-main">
              {!form ? (
                <div className="api-hint">Select a profile or create a new one.</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                    <div className="api-field" style={{ flex: 2, marginBottom: 0 }}>
                      <label>Profile name</label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => updateForm("name", e.target.value)}
                        placeholder="e.g. OpenRouter RP"
                      />
                      {duplicateNameWarning && (
                        <div className="field-warning">
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <circle cx="8" cy="8" r="6.5" />
                            <line x1="8" y1="5" x2="8" y2="9" />
                            <circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
                          </svg>
                          A profile with this name already exists
                        </div>
                      )}
                    </div>
                    <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Provider preset</label>
                      <select
                        value={presetGroup ?? ""}
                        onChange={(e) => {
                          const g = e.target.value;
                          if (!g) {
                            updateForm("providerPreset", "");
                            updateForm("type", "openai_compat");
                          } else {
                            const first = PROVIDER_PRESETS.find((f) => f.group === g);
                            if (first) applyPreset(first.id);
                          }
                        }}
                        style={{ height: 34 }}
                      >
                        <option value="">Custom</option>
                        {PRESET_GROUPS.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                    <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                      <label>API format</label>
                      <select
                        value={form.providerPreset || ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) applyPreset(val);
                        }}
                        style={{ height: 34 }}
                      >
                        <option value="">Custom</option>
                        {filteredPresets.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="api-field" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Preset endpoint</label>
                      <input
                        type="text"
                        value={presetEndpoint || "Custom"}
                        readOnly
                        style={{ opacity: 0.72 }}
                      />
                    </div>
                  </div>

                  <div className="api-field">
                    <label>API Endpoint (Base URL)</label>
                    <input
                      type="text"
                      value={form.baseUrl}
                      onChange={(e) => updateForm("baseUrl", e.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>

                  <div className="api-field">
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                        color: "var(--t1)",
                      }}
                    >
                      <div className="toggle">
                        <input
                          type="checkbox"
                          checked={form.streamResponse}
                          onChange={(e) => updateForm("streamResponse", e.target.checked)}
                        />
                        <div className="tgl-sl" />
                      </div>
                      Stream response
                    </label>
                    <div className="api-hint">
                      On: character-by-character streaming. Off: full response appears at once.
                    </div>
                  </div>

                  <div className="api-field">
                    <label>API Key</label>
                    <input
                      type="password"
                      value={form.apiKey}
                      onChange={(e) => updateForm("apiKey", e.target.value)}
                      placeholder={form.hasStoredApiKey ? "Stored on backend" : "sk-..."}
                    />
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    {!form.apiKey && !form.hasStoredApiKey && (
                      <div
                        style={{
                          padding: "8px 12px",
                          background: "var(--s2)",
                          borderRadius: 6,
                          fontSize: 12,
                          color: "var(--t3)",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span style={{ opacity: 0.5 }}>&#8857;</span>
                        <span>
                          No provider connected — enter API key above to connect
                        </span>
                      </div>
                    )}
                    {form.apiKey && !form.model && (
                      <div
                        style={{
                          padding: "8px 12px",
                          background: "var(--s2)",
                          borderRadius: 6,
                          fontSize: 12,
                          color: "var(--t3)",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span style={{ opacity: 0.5 }}>&#8857;</span>
                        <span>No model selected — choose a model to start chatting</span>
                      </div>
                    )}
                    {(form.apiKey || form.hasStoredApiKey) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <button
                          className={`api-test-btn ${testing ? "testing" : testOk === true ? "ok" : testOk === false ? "err" : "idle"}`}
                          style={{ height: 30, fontSize: 12 }}
                          onClick={() => void handleTestConnection()}
                        >
                          Test Connection
                        </button>
                        {testOk === true && (
                          <span className="api-test-result ok">
                            <Icons.Check /> Connection successful
                          </span>
                        )}
                        {testOk === false && (
                          <span className="api-test-result err">
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                            >
                              <circle cx="8" cy="8" r="6.5" />
                              <line x1="8" y1="5" x2="8" y2="9" />
                              <circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
                            </svg>
                            Connection failed
                          </span>
                        )}
                      </div>
                    )}
                    {(form.apiKey || form.hasStoredApiKey) && form.model.trim() && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <button
                          className={`api-test-btn ${testingChat ? "testing" : chatResult?.reply ? "ok" : chatResult?.error ? "err" : "idle"}`}
                          style={{ height: 30, fontSize: 12 }}
                          onClick={() => void handleTestChat()}
                          disabled={testingChat}
                        >
                          Test &quot;Hi&quot;
                        </button>
                      </div>
                    )}
                    {chatResult && (
                      <div className="test-chat-result">
                        {chatResult.reply && (
                          <div className="test-chat-reply">
                            <Icons.Check />
                            <span>{chatResult.reply.length > 200 ? chatResult.reply.slice(0, 200) + "..." : chatResult.reply}</span>
                          </div>
                        )}
                        {chatResult.error && (
                          <div className="test-chat-error">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <circle cx="8" cy="8" r="6.5" />
                              <line x1="8" y1="5" x2="8" y2="9" />
                              <circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
                            </svg>
                            <span>{chatResult.error}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="api-section-title">Model</div>
                  <div className="api-row" style={{ alignItems: "flex-end", marginBottom: 16 }}>
                    <div className="api-field" style={{ flex: 1 }} ref={dropdownRef}>
                      <label>Selected model</label>
                      {models.length > 0 ? (
                        <div style={{ position: "relative" }}>
                          <button
                            type="button"
                            onClick={() => setModelListOpen((v) => !v)}
                            style={{
                              height: 34,
                              width: "100%",
                              background: "var(--s1, var(--s2))",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              padding: "0 10px",
                              color: "var(--t1)",
                              fontFamily: "var(--font-ui)",
                              fontSize: 12,
                              textAlign: "left",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              cursor: "pointer",
                            }}
                          >
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {models.find((m) => m.id === form.model)?.label || form.model} (
                              {form.model})
                            </span>
                            <span style={{ color: "var(--t3)", marginLeft: 8 }}>
                              <Icons.Caret direction="d" />
                            </span>
                          </button>
                          {modelListOpen && (
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: 38,
                                zIndex: 40,
                                background: "var(--surface)",
                                border: "1px solid var(--border2)",
                                borderRadius: 6,
                                boxShadow: "0 12px 28px rgba(0,0,0,.35)",
                                overflow: "hidden",
                              }}
                            >
                              <input
                                type="text"
                                placeholder="Search models..."
                                value={modelSearch}
                                onChange={(e) => setModelSearch(e.target.value)}
                                autoFocus
                                style={{
                                  height: 30,
                                  fontSize: 11,
                                  background: "var(--s2)",
                                  border: 0,
                                  borderBottom: "1px solid var(--border)",
                                  borderRadius: 0,
                                  padding: "0 8px",
                                  color: "var(--t1)",
                                  fontFamily: "var(--font-ui)",
                                  width: "100%",
                                  boxSizing: "border-box",
                                  outline: "none",
                                }}
                              />
                              <div style={{ maxHeight: 150, overflowY: "auto" }}>
                                {filteredModels.map((m) => (
                                  <div
                                    key={m.id}
                                    onClick={() => {
                                      updateForm("model", m.id);
                                      setModelListOpen(false);
                                      setModelSearch("");
                                    }}
                                    style={{
                                      padding: "8px 10px",
                                      fontSize: 12,
                                      color:
                                        m.id === form.model
                                          ? "var(--accent-t)"
                                          : "var(--t2)",
                                      background:
                                        m.id === form.model ? "var(--s2)" : "transparent",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {m.label} ({m.id})
                                  </div>
                                ))}
                                {filteredModels.length === 0 && (
                                  <div
                                    style={{
                                      padding: "8px 10px",
                                      fontSize: 11,
                                      color: "var(--t4)",
                                    }}
                                  >
                                    No models match
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {!models.find((m) => m.id === form.model) && form.model && (
                            <div style={{ marginTop: 4, fontSize: 11, color: "var(--t3)" }}>
                              Custom model: {form.model}
                            </div>
                          )}
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={form.model}
                          onChange={(e) => updateForm("model", e.target.value)}
                          placeholder="Model ID (e.g. gpt-4o)"
                        />
                      )}
                    </div>
                    <button
                      onClick={() => void handleFetchModels()}
                      style={{
                        background: "var(--s2)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 12,
                        color: "var(--t2)",
                        fontFamily: "var(--font-ui)",
                        padding: "0 12px",
                        height: 34,
                        flexShrink: 0,
                        transition: "background .1s,color .1s",
                        whiteSpace: "nowrap",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {fetching ? (
                        <>
                          <span className="gen-cur" style={{ display: "inline-flex" }}>
                            <span />
                            <span />
                            <span />
                          </span>{" "}
                          Loading...
                        </>
                      ) : (
                        <>
                          <Icons.Regen /> Refresh list
                        </>
                      )}
                    </button>
                  </div>
                  {fetchError && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "oklch(0.72 0.14 70)",
                        marginTop: -8,
                        marginBottom: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <circle cx="8" cy="8" r="6.5" />
                        <line x1="8" y1="5" x2="8" y2="9" />
                        <circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
                      </svg>
                      {fetchError}
                    </div>
                  )}

                  <div className="api-section-title">Samplers (Advanced)</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Temperature ({form.temperature})</label>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.05"
                        value={form.temperature}
                        onChange={(e) => updateForm("temperature", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Max Context</label>
                      <input
                        type="number"
                        min="1024"
                        max="2000000"
                        step="1024"
                        value={form.maxTokens || ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateForm("maxTokens", v === "" ? 0 : parseInt(v) || 0);
                        }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Top P ({form.topP})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={form.topP}
                        onChange={(e) => updateForm("topP", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Min P ({form.minP})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={form.minP}
                        onChange={(e) => updateForm("minP", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Top K</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={form.topK}
                        onChange={(e) => updateForm("topK", parseInt(e.target.value) || 40)}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Typical P ({form.typicalP})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={form.typicalP}
                        onChange={(e) => updateForm("typicalP", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Rep. Penalty ({form.repPen})</label>
                      <input
                        type="range"
                        min="1"
                        max="2"
                        step="0.05"
                        value={form.repPen}
                        onChange={(e) => updateForm("repPen", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Frequency Penalty ({form.freqPen})</label>
                      <input
                        type="range"
                        min="-2"
                        max="2"
                        step="0.1"
                        value={form.freqPen}
                        onChange={(e) => updateForm("freqPen", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                    <div className="api-field" style={{ marginBottom: 0 }}>
                      <label>Presence Penalty ({form.presPen})</label>
                      <input
                        type="range"
                        min="-2"
                        max="2"
                        step="0.1"
                        value={form.presPen}
                        onChange={(e) => updateForm("presPen", parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
                    <div className="api-field" style={{ flex: 1 }}>
                      <label>Stop Sequences (comma-separated)</label>
                      <input
                        type="text"
                        value={form.stopSeq}
                        onChange={(e) => updateForm("stopSeq", e.target.value)}
                        placeholder="User:, \nUser"
                      />
                    </div>
                    <div className="api-field" style={{ width: 120 }}>
                      <label>Seed</label>
                      <input
                        type="number"
                        value={form.seed ?? ""}
                        onChange={(e) =>
                          updateForm(
                            "seed",
                            e.target.value === "" ? null : e.target.value,
                          )
                        }
                        placeholder="Random"
                      />
                    </div>
                    <div className="api-field" style={{ width: 160 }}>
                      <label>Reasoning Effort</label>
                      <select
                        value={form.reasoningEffort}
                        onChange={(e) => updateForm("reasoningEffort", e.target.value)}
                        style={{ height: 34 }}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="api-foot">
          <span
            className="act-btn"
            style={{ color: "var(--t3)", padding: "6px 12px", cursor: "pointer" }}
            onClick={() => void handleDuplicate()}
          >
            <Icons.Copy /> Duplicate provider
          </span>
          {providerProfiles.length > 1 && (
            <span
              className="act-btn"
              style={{ color: "var(--t3)", padding: "6px 12px", cursor: "pointer" }}
              onClick={handleDelete}
            >
              <Icons.Trash /> Delete profile
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <button
              className={`api-save-btn ${saveState === "saved" ? "save-btn-saved" : ""} ${saveState === "saving" ? "save-btn-saving" : ""}`}
              onClick={() => triggerSave(() => void handleSaveProfile())}
            >
              {saveState === "saving"
                ? "Saving..."
                : saveState === "saved"
                  ? "Saved"
                  : "Save profile"}
            </button>
            <button
              className="api-save-btn"
              onClick={() => void handleActivate()}
            >
              Set as active
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
