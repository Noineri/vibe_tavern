import { useEffect, useMemo, useState } from "react";
import { COAUTHOR_TRANSPORT, MODEL_FAVORITE_SCOPE, canUseCoauthorResponsesTransport, resolveCoauthorGenerationSettings, resolveSamplerCapabilities, PROVIDER_TYPE, type CoauthorTransport, type ModelSettingsOverlay } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useCoauthorProviderBinding } from "../../hooks/use-coauthor-provider-binding.js";
import { useProviderModels } from "../../hooks/use-provider-models.js";
import { type ProviderSamplerOnChange, type ProviderSamplerValues } from "../../lib/provider-sampler-values.js";
import { PROVIDER_PRESETS } from "../../provider-presets.js";
import { loadCoauthorConnectionSettingsAction, loadFavoriteModelsAction, reorderCoauthorProviderProfilesAction, testProfileChatAction, toggleFavoriteModelAction, updateProviderProfileAction } from "../../stores/api-actions/provider-actions.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { ProviderProfileList } from "../settings/provider/ProviderProfileList.js";
import { CoauthorModelSelector } from "../settings/provider/CoauthorModelSelector.js";
import { ProviderSamplerPanel } from "../settings/provider/ProviderSamplerPanel.js";
import { ProviderTestHelloButton } from "../settings/provider/ProviderTestHelloButton.js";
import { SearchInput } from "../shared/SearchInput.js";
import { cn } from "../../lib/cn.js";

export interface CoauthorProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenProviderModal: () => void;
}

type CoauthorForm = ProviderSamplerValues;

function toCoauthorForm(profilePreset: string, model: string | null, settings: ModelSettingsOverlay | null | undefined): CoauthorForm {
  return {
    ...resolveCoauthorGenerationSettings(settings),
    model: model ?? "",
    providerPreset: profilePreset,
    tokenPadding: 0,
  };
}

function toGenerationSettings(form: CoauthorForm): ModelSettingsOverlay {
  const { model: _model, providerPreset: _providerPreset, tokenPadding: _tokenPadding, ...settings } = form;
  return settings;
}

/** Co-Author connection + generation-settings editor. Connection credentials remain in ProviderModal. */
export function CoauthorProviderModal({ isOpen, onClose, onOpenProviderModal }: CoauthorProviderModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const profiles = useProviderDataStore((state) => state.profiles);
  const favoritesByProfile = useProviderDataStore((state) => state.coauthorFavoritesByProfile);
  const coauthorSettingsByProfile = useProviderDataStore((state) => state.coauthorSettingsByProfile);
  const resumeProfileId = useModalStore((state) => state.coauthorResumeProfileId);
  const consumeCoauthorResumeProfileId = useModalStore((state) => state.consumeCoauthorResumeProfileId);
  const binding = useCoauthorProviderBinding();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(binding.profileId);
  const [form, setForm] = useState<CoauthorForm | null>(null);
  const [baseline, setBaseline] = useState<CoauthorForm | null>(null);
  const [profileSearch, setProfileSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transportByProfile, setTransportByProfile] = useState<Record<string, CoauthorTransport>>({});
  const [transportSaving, setTransportSaving] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ reply?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (resumeProfileId !== null) {
      setSelectedProfileId(resumeProfileId);
      consumeCoauthorResumeProfileId();
    } else {
      setSelectedProfileId(binding.profileId);
    }
    setProfileSearch("");
    setModelSearch("");
    setModelListOpen(false);
    setTransportByProfile({});
    setTransportError(null);
    setTestResult(null);
  }, [isOpen]); // The binding is intentionally sampled on modal open.

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === selectedProfileId) ?? null, [profiles, selectedProfileId]);
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels } = useProviderModels(selectedProfileId);
  const favorites = selectedProfileId ? favoritesByProfile[selectedProfileId] ?? [] : [];

  useEffect(() => {
    if (selectedProfileId) void loadFavoriteModelsAction(selectedProfileId, MODEL_FAVORITE_SCOPE.coauthor);
  }, [selectedProfileId]);

  useEffect(() => {
    if (!selectedProfile) {
      setForm(null);
      setBaseline(null);
      return;
    }
    let cancelled = false;
    setForm(null);
    setBaseline(null);
    void loadCoauthorConnectionSettingsAction(selectedProfile.id).then((row) => {
      if (cancelled) return;
      const next = toCoauthorForm(selectedProfile.providerPreset, row?.modelName ?? selectedProfile.defaultModel, row?.settings);
      setForm(next);
      setBaseline(next);
    });
    return () => { cancelled = true; };
  }, [selectedProfile]);

  const canSelectResponses = selectedProfile ? canUseCoauthorResponsesTransport(selectedProfile.providerPreset) : false;
  const selectedTransport = selectedProfile ? transportByProfile[selectedProfile.id] ?? selectedProfile.coauthorTransport ?? COAUTHOR_TRANSPORT.chatCompletions : COAUTHOR_TRANSPORT.chatCompletions;
  const selectedPreset = selectedProfile ? PROVIDER_PRESETS.find((preset) => preset.id === selectedProfile.providerPreset) : undefined;
  const samplerCapabilities = selectedProfile ? { samplers: resolveSamplerCapabilities(selectedProfile.providerPreset, selectedPreset?.type ?? PROVIDER_TYPE.openaiCompat) } : undefined;
  useEffect(() => {
    if (isOpen) void Promise.all(profiles.map((profile) => loadCoauthorConnectionSettingsAction(profile.id)));
  }, [isOpen, profiles]);

  const coauthorProfiles = useMemo(() => [...profiles].sort((left, right) => {
    const leftOrder = coauthorSettingsByProfile[left.id]?.sortOrder;
    const rightOrder = coauthorSettingsByProfile[right.id]?.sortOrder;
    if (leftOrder !== null && leftOrder !== undefined && rightOrder !== null && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== null && leftOrder !== undefined) return -1;
    if (rightOrder !== null && rightOrder !== undefined) return 1;
    return 0;
  }), [profiles, coauthorSettingsByProfile]);
  const filteredProfiles = useMemo(() => {
    const query = profileSearch.trim().toLowerCase();
    return !query ? coauthorProfiles : coauthorProfiles.filter((profile) => profile.name.toLowerCase().includes(query) || profile.providerPreset.toLowerCase().includes(query));
  }, [profileSearch, coauthorProfiles]);
  const dirty = selectedProfileId !== binding.profileId || (form !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline));
  const canSave = Boolean(selectedProfileId && form?.model && dirty && !saving);

  async function handleSave() {
    if (!selectedProfileId || !form?.model) return;
    setSaving(true);
    try {
      await binding.saveBinding(selectedProfileId, form.model, toGenerationSettings(form));
      onClose();
    } finally {
      setSaving(false);
    }
  }
  function handleSelectProfile(id: string) {
    setSelectedProfileId(id);
    setModelSearch("");
    setModelListOpen(false);
    setTransportError(null);
    setTestResult(null);
  }
  const updateForm: ProviderSamplerOnChange = (key, value) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };
  function updateModelForm(key: "model" | "contextBudget", value: string | number) {
    if (key === "model") setForm((current) => current ? { ...current, model: value as string } : current);
    else setForm((current) => current ? { ...current, contextBudget: value as number } : current);
    setTestResult(null);
  }
  async function handleTransportChange(transport: CoauthorTransport) {
    if (!selectedProfile || transport === selectedTransport) return;
    const profileId = selectedProfile.id;
    setTransportByProfile((current) => ({ ...current, [profileId]: transport }));
    setTransportSaving(true);
    setTransportError(null);
    try {
      const saved = await updateProviderProfileAction(profileId, { coauthorTransport: transport });
      setTransportByProfile((current) => ({ ...current, [profileId]: saved.coauthorTransport }));
    } catch (error) {
      setTransportByProfile((current) => {
        const next = { ...current };
        delete next[profileId];
        return next;
      });
      setTransportError(error instanceof Error ? error.message : t("coauthor.provider.transport_save_error"));
    } finally {
      setTransportSaving(false);
    }
  }
  async function handleTest() {
    if (!selectedProfileId || !form?.model) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProfileChatAction(selectedProfileId, form.model, selectedTransport));
    } finally {
      setTesting(false);
    }
  }
  async function handleToggleFavorite(model: { id: string; label: string; contextLength?: number }) {
    if (!selectedProfileId) return;
    const removing = favorites.some((favorite) => favorite.modelId === model.id);
    await toggleFavoriteModelAction(selectedProfileId, model.id, model.label, model.contextLength, removing, MODEL_FAVORITE_SCOPE.coauthor);
  }

  return <MasterDetailModal
    isOpen={isOpen}
    onClose={onClose}
    title={t("coauthor.provider.title")}
    subtitle={t("coauthor.provider.subtitle")}
    detailTitle={selectedProfile?.name ?? t("coauthor.provider.title")}
    dirty={dirty}
    masterClassName="flex w-[220px] shrink-0 flex-col border-r border-border"
    detailClassName={isMobile ? "p-4" : "p-5"}
    headerClassName={isMobile ? "px-3 py-2.5" : "px-6 pt-5 pb-4"}
    headerActions={<button type="button" className="font-ui text-[12px] font-medium text-t3 transition-colors hover:text-t1" onClick={() => { onClose(); onOpenProviderModal(); }}>{t("coauthor.provider.manage_connections")}</button>}
    masterContent={() => <ProviderProfileList profiles={coauthorProfiles} filteredProfiles={filteredProfiles} editingId={selectedProfileId} activeProfileId={binding.profileId} profileSearch={profileSearch} onProfileSearchChange={setProfileSearch} onSelectProfile={handleSelectProfile} onReorder={(updates) => reorderCoauthorProviderProfilesAction(updates)} selectionOnly />}
    detailContent={!selectedProfile ? <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">{profiles.length === 0 ? t("coauthor.provider.no_profiles") : t("coauthor.provider.select_profile")}</div> : <div className="flex min-h-full flex-col gap-4">
      <div className="shrink-0 rounded-lg border border-border bg-s2 px-4 py-3"><div className="font-ui text-[13px] font-medium text-t1">{selectedProfile.name}</div><div className="mt-0.5 font-ui text-[11px] text-t4">{selectedProfile.endpoint}</div></div>
      <div className="shrink-0 rounded-lg border border-border bg-s2 px-4 py-3">
        <div className="font-ui text-[12px] font-medium text-t2">{t("coauthor.provider.transport_label")}</div>
        {canSelectResponses ? <><div className="mt-2 flex gap-1 rounded-md bg-surface p-1"><button type="button" disabled={transportSaving} onClick={() => void handleTransportChange(COAUTHOR_TRANSPORT.chatCompletions)} className={cn("flex-1 rounded px-2 py-1.5 font-ui text-[11px] font-medium", selectedTransport === COAUTHOR_TRANSPORT.chatCompletions ? "bg-accent/15 text-accent-t" : "text-t3 hover:text-t1")}>{t("coauthor.provider.transport_chat_completions")}</button><button type="button" disabled={transportSaving} onClick={() => void handleTransportChange(COAUTHOR_TRANSPORT.responses)} className={cn("flex-1 rounded px-2 py-1.5 font-ui text-[11px] font-medium", selectedTransport === COAUTHOR_TRANSPORT.responses ? "bg-accent/15 text-accent-t" : "text-t3 hover:text-t1")}>{t("coauthor.provider.transport_responses")}</button></div><p className="mt-2 font-ui text-[11px] leading-snug text-warning-text">{t("coauthor.provider.transport_may_not_be_supported")}</p></> : <div className="mt-1 font-ui text-[12px] text-t3">{t("coauthor.provider.transport_native")}</div>}
        {transportError && <p className="mt-2 font-ui text-[11px] leading-snug text-danger">{transportError}</p>}
      </div>
      {form ? <>
        <CoauthorModelSelector values={form} models={models} fetching={modelsLoading} fetchError={modelsError} modelSearch={modelSearch} modelListOpen={modelListOpen} favoriteModels={favorites} onChange={updateModelForm} onFetchModels={refreshModels} setModelSearch={setModelSearch} setModelListOpen={setModelListOpen} onToggleFavoriteModel={(model) => void handleToggleFavorite(model)} />
        {form.model && <ProviderTestHelloButton className="shrink-0 mt-2 mb-4" testing={testing} result={testResult} onTest={() => void handleTest()} replyWrapperClassName="mt-2" errorWrapperClassName="mt-2" />}
        <ProviderSamplerPanel values={form} onChange={updateForm} showTokenPadding={false} capabilities={samplerCapabilities} />
      </> : <div className="py-6 text-center font-ui text-[12px] text-t4">{t("loading")}</div>}
    </div>}
    footer={<div data-testid="coauthor-modal-footer" className={cn("flex shrink-0 items-center justify-end gap-2 border-t border-border", isMobile ? "px-4 py-3" : "px-6 py-4")}><button type="button" className="rounded-md px-3 py-1.5 font-ui text-[12px] font-medium text-t3 transition-colors hover:bg-s2 hover:text-t1" onClick={onClose}>{t("cancel")}</button><button type="button" disabled={!canSave} onClick={() => void handleSave()} className={cn("rounded-md px-4 py-1.5 font-ui text-[12px] font-medium transition-colors", canSave ? "bg-accent text-accent-t hover:bg-accent/90" : "cursor-not-allowed bg-s3 text-t4")}>{saving ? t("saving") : t("coauthor.provider.use_for_coauthor")}</button></div>}
  />;
}
