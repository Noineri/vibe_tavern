import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { COAUTHOR_TRANSPORT, MODEL_FAVORITE_SCOPE, canUseCoauthorResponsesTransport, type CoauthorTransport } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useBootstrapStore, patchUiSettingsAction } from "../../stores/api-actions/bootstrap-actions.js";
import { useCoauthorProviderBinding } from "../../hooks/use-coauthor-provider-binding.js";
import { useProviderModels } from "../../hooks/use-provider-models.js";
import { type ToolSupport } from "../../lib/provider-model-capabilities.js";
import { loadFavoriteModelsAction, testProfileChatAction, toggleFavoriteModelAction, updateProviderProfileAction } from "../../stores/api-actions/provider-actions.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { ProviderProfileList } from "../settings/provider/ProviderProfileList.js";
import { ProviderModelList, type ProviderModelListOption } from "../settings/provider/ProviderModelList.js";
import { Icons } from "../shared/icons.js";
import { NumberInput } from "../shared/NumberInput.js";
import { cn } from "../../lib/cn.js";

export interface CoauthorProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenProviderModal: () => void;
}

type CapabilityFilter = "all" | ToolSupport;

/** Selection-only Co-Author binding editor. Connection credentials remain in ProviderModal. */
export function CoauthorProviderModal({ isOpen, onClose, onOpenProviderModal }: CoauthorProviderModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const profiles = useProviderDataStore((state) => state.profiles);
  const favoritesByProfile = useProviderDataStore((state) => state.coauthorFavoritesByProfile);
  const uiSettings = useBootstrapStore((state) => state.data?.uiSettings);
  const resumeProfileId = useModalStore((state) => state.coauthorResumeProfileId);
  const consumeCoauthorResumeProfileId = useModalStore((state) => state.consumeCoauthorResumeProfileId);
  const binding = useCoauthorProviderBinding();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(binding.profileId);
  const [selectedModel, setSelectedModel] = useState<string | null>(binding.model);
  const [profileSearch, setProfileSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>("all");
  const [saving, setSaving] = useState(false);
  const [transportByProfile, setTransportByProfile] = useState<Record<string, CoauthorTransport>>({});
  const [transportSaving, setTransportSaving] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenInputRevision, setTokenInputRevision] = useState(0);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ reply?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (resumeProfileId !== null) {
      setSelectedProfileId(resumeProfileId);
      setSelectedModel(null);
      consumeCoauthorResumeProfileId();
      return;
    }
    setSelectedProfileId(binding.profileId);
    setSelectedModel(binding.model);
    setProfileSearch("");
    setModelSearch("");
    setCapabilityFilter("all");
    setTransportByProfile({});
    setTransportError(null);
    setTokenError(null);
    setTestResult(null);
  }, [isOpen]); // binding is intentionally sampled on normal open

  useEffect(() => {
    if (selectedProfileId) void loadFavoriteModelsAction(selectedProfileId, MODEL_FAVORITE_SCOPE.coauthor);
  }, [selectedProfileId]);

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === selectedProfileId) ?? null, [profiles, selectedProfileId]);
  const canSelectResponses = selectedProfile ? canUseCoauthorResponsesTransport(selectedProfile.providerPreset) : false;
  const selectedTransport = selectedProfile ? transportByProfile[selectedProfile.id] ?? selectedProfile.coauthorTransport ?? COAUTHOR_TRANSPORT.chatCompletions : COAUTHOR_TRANSPORT.chatCompletions;
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels } = useProviderModels(selectedProfileId);
  const favorites = selectedProfileId ? favoritesByProfile[selectedProfileId] ?? [] : [];
  const coauthorMaxTokens = uiSettings?.coauthorMaxTokens ?? null;
  const coauthorContextBudget = uiSettings?.coauthorContextBudget ?? null;
  const inheritedMaxTokens = selectedProfile?.maxTokens ?? 2_000;
  const inheritedContextBudget = selectedProfile?.contextBudget ?? 16_000;
  // The profile's maxTokens uses -1 (and any value <= 0) as the "no output cap"
  // sentinel: sampler-mapper only applies maxOutputTokens when maxTokens > 0,
  // and TokenCounterPopover renders the same sentinel as "∞". Co-Author
  // overrides are always a positive integer (validated in handleTokenOverride),
  // so the sentinel can only surface through the INHERITED value — render it
  // honestly as unlimited instead of leaking -1 into the numeric editor.
  const effectiveMaxTokens = coauthorMaxTokens ?? inheritedMaxTokens;
  const maxTokensUnlimited = effectiveMaxTokens <= 0;

  const listModels = useMemo<ProviderModelListOption[]>(() => {
    if (!selectedModel || models.some((model) => model.id === selectedModel)) return models;
    return [{ id: selectedModel, label: selectedModel, toolSupport: "unknown" }, ...models];
  }, [models, selectedModel]);
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return listModels.filter((model) => (
      (capabilityFilter === "all" || model.toolSupport === capabilityFilter)
      && (!query || model.label.toLowerCase().includes(query) || model.id.toLowerCase().includes(query))
    ));
  }, [capabilityFilter, listModels, modelSearch]);
  const filteredProfiles = useMemo(() => {
    const query = profileSearch.trim().toLowerCase();
    return !query ? profiles : profiles.filter((profile) => profile.name.toLowerCase().includes(query) || profile.providerPreset.toLowerCase().includes(query));
  }, [profileSearch, profiles]);

  const dirty = selectedProfileId !== binding.profileId || selectedModel !== binding.model;
  const canSave = Boolean(selectedProfileId && selectedModel && dirty && !saving);
  const filterOptions: Array<{ value: CapabilityFilter; label: string }> = [
    { value: "all", label: t("coauthor.provider.filter_all") },
    { value: "supported", label: t("coauthor.provider.filter_supported") },
    { value: "unknown", label: t("coauthor.provider.filter_unknown") },
    { value: "unsupported", label: t("coauthor.provider.filter_unsupported") },
  ];

  async function handleSave() {
    if (!selectedProfileId || !selectedModel) return;
    setSaving(true);
    try {
      await binding.saveBinding(selectedProfileId, selectedModel);
      onClose();
    } finally {
      setSaving(false);
    }
  }
  function handleSelectProfile(id: string) {
    const cachedModels = profiles.find((profile) => profile.id === id)?.cachedModels?.models;
    if (selectedModel && cachedModels?.length && !cachedModels.some((model) => model.id === selectedModel)) {
      setSelectedModel(null);
    }
    setSelectedProfileId(id);
    setModelSearch("");
    setTransportError(null);
    setTokenError(null);
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
  async function handleTokenOverride(patch: { coauthorMaxTokens?: number | null; coauthorContextBudget?: number | null }) {
    const values = [patch.coauthorMaxTokens, patch.coauthorContextBudget].filter((value): value is number => value !== null && value !== undefined);
    if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
      setTokenError(t("coauthor.provider.tokens_invalid"));
      setTokenInputRevision((current) => current + 1);
      return;
    }
    setTokenSaving(true);
    setTokenError(null);
    try {
      await patchUiSettingsAction(patch);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : t("coauthor.provider.tokens_save_error"));
      setTokenInputRevision((current) => current + 1);
    } finally {
      setTokenSaving(false);
    }
  }
  async function handleTest() {
    if (!selectedProfileId || !selectedModel) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProfileChatAction(selectedProfileId, selectedModel, selectedTransport));
    } finally {
      setTesting(false);
    }
  }
  async function handleToggleFavorite(model: ProviderModelListOption) {
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
    containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[680px] w-[860px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
    masterClassName="flex w-[220px] shrink-0 flex-col border-r border-border"
    detailClassName={isMobile ? "p-4" : "p-5"}
    headerClassName={isMobile ? "px-3 py-2.5" : "px-6 pt-5 pb-4"}
    headerActions={<button type="button" className="font-ui text-[12px] font-medium text-t3 transition-colors hover:text-t1" onClick={() => { onClose(); onOpenProviderModal(); }}>{t("coauthor.provider.manage_connections")}</button>}
    masterContent={() => <ProviderProfileList profiles={profiles} filteredProfiles={filteredProfiles} editingId={selectedProfileId} activeProviderProfileId={binding.profileId} profileSearch={profileSearch} onProfileSearchChange={setProfileSearch} onSelectProfile={handleSelectProfile} selectionOnly />}
    detailContent={!selectedProfile ? <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">{profiles.length === 0 ? t("coauthor.provider.no_profiles") : t("coauthor.provider.select_profile")}</div> : <div className="flex min-h-full flex-col gap-4">
      <div className="shrink-0 rounded-lg border border-border bg-s2 px-4 py-3"><div className="font-ui text-[13px] font-medium text-t1">{selectedProfile.name}</div><div className="mt-0.5 font-ui text-[11px] text-t4">{selectedProfile.endpoint}</div></div>
      <div className="shrink-0 rounded-lg border border-border bg-s2 px-4 py-3">
        <div className="font-ui text-[12px] font-medium text-t2">{t("coauthor.provider.transport_label")}</div>
        {canSelectResponses ? <><div className="mt-2 flex gap-1 rounded-md bg-surface p-1"><button type="button" disabled={transportSaving} onClick={() => void handleTransportChange(COAUTHOR_TRANSPORT.chatCompletions)} className={cn("flex-1 rounded px-2 py-1.5 font-ui text-[11px] font-medium", selectedTransport === COAUTHOR_TRANSPORT.chatCompletions ? "bg-accent/15 text-accent-t" : "text-t3 hover:text-t1")}>{t("coauthor.provider.transport_chat_completions")}</button><button type="button" disabled={transportSaving} onClick={() => void handleTransportChange(COAUTHOR_TRANSPORT.responses)} className={cn("flex-1 rounded px-2 py-1.5 font-ui text-[11px] font-medium", selectedTransport === COAUTHOR_TRANSPORT.responses ? "bg-accent/15 text-accent-t" : "text-t3 hover:text-t1")}>{t("coauthor.provider.transport_responses")}</button></div><p className="mt-2 font-ui text-[11px] leading-snug text-warning-text">{t("coauthor.provider.transport_may_not_be_supported")}</p></> : <div className="mt-1 font-ui text-[12px] text-t3">{t("coauthor.provider.transport_native")}</div>}

        {transportError && <p className="mt-2 font-ui text-[11px] leading-snug text-danger">{transportError}</p>}
      </div>
      <div className="shrink-0 rounded-lg border border-border bg-s2 px-4 py-3">
        <div className="font-ui text-[12px] font-medium text-t2">{t("coauthor.provider.tokens_label")}</div>
        <p className="mt-1 font-ui text-[11px] leading-snug text-t4">{t("coauthor.provider.tokens_inherit")}</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div><label className="mb-1 block font-ui text-[11px] text-t3">{t("coauthor.provider.max_tokens")}</label>{maxTokensUnlimited ? <button type="button" disabled={tokenSaving} onClick={() => void handleTokenOverride({ coauthorMaxTokens: 2_000 })} className="flex h-8 w-full items-center justify-center rounded-md border border-border bg-s2 font-ui text-[15px] leading-none text-t3 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50">∞</button> : <NumberInput key={`max-${selectedProfile.id}-${tokenInputRevision}`} value={effectiveMaxTokens} min={1} max={1_000_000} step={100} disabled={tokenSaving} onChange={(value) => void handleTokenOverride({ coauthorMaxTokens: value })} />}<button type="button" disabled={tokenSaving || coauthorMaxTokens === null} onClick={() => void handleTokenOverride({ coauthorMaxTokens: null })} className="mt-1 font-ui text-[10px] text-t4 hover:text-t2 disabled:opacity-50">{t("reset")}</button></div>
          <div><label className="mb-1 block font-ui text-[11px] text-t3">{t("coauthor.provider.context_budget")}</label><NumberInput key={`context-${selectedProfile.id}-${tokenInputRevision}`} value={coauthorContextBudget ?? inheritedContextBudget} min={1} max={10_000_000} step={1_000} disabled={tokenSaving} onChange={(value) => void handleTokenOverride({ coauthorContextBudget: value })} /><button type="button" disabled={tokenSaving || coauthorContextBudget === null} onClick={() => void handleTokenOverride({ coauthorContextBudget: null })} className="mt-1 font-ui text-[10px] text-t4 hover:text-t2 disabled:opacity-50">{t("reset")}</button></div>
        </div>
        {tokenError && <p className="mt-2 font-ui text-[11px] leading-snug text-danger">{tokenError}</p>}
      </div>
      <div className="flex shrink-0 flex-col">
        <label className="mb-1.5 block shrink-0 font-ui text-[12px] font-medium text-t3">{t("coauthor.provider.model_label")}</label>
        <div className="mb-2 flex shrink-0 items-center gap-2"><div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-s2 px-2.5 py-1.5"><Icons.Search /><input className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[13px] text-t1 outline-none placeholder:text-t4" placeholder={t("coauthor.provider.model_search")} value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} /></div><button type="button" disabled={modelsLoading} onClick={() => void refreshModels()} className="shrink-0 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50">{t("refresh_models")}</button></div>
        <div className="mb-2 flex shrink-0 flex-wrap gap-1">{filterOptions.map((option) => <button key={option.value} type="button" onClick={() => setCapabilityFilter(option.value)} className={cn("flex items-center gap-1 rounded px-2 py-1 font-ui text-[11px]", capabilityFilter === option.value ? "bg-accent/15 text-accent-t" : "bg-s2 text-t3 hover:text-t1")}>{option.value === "supported" && <Icons.Wrench />}{option.label}</button>)}</div>
        <div data-testid="coauthor-model-list" className="h-[250px] shrink-0 overflow-hidden rounded-lg border border-border">
          {modelsLoading && <div className="flex h-full items-center justify-center font-ui text-[12px] text-t4">{t("loading")}</div>}
          {modelsError && <div className="flex h-full items-center justify-center font-ui text-[12px] text-danger">{modelsError}</div>}
          {!modelsLoading && !modelsError && <Command shouldFilter={false} className="h-full"><ProviderModelList models={filteredModels} selectedId={selectedModel ?? ""} search={modelSearch} favorites={favorites} onSelect={(model) => { setSelectedModel(model.id); setTestResult(null); }} onToggleFavorite={(model) => void handleToggleFavorite(model)} onUseCustomSlug={(slug) => { setSelectedModel(slug); setModelSearch(""); setTestResult(null); }} toolFilter={capabilityFilter === "all" ? undefined : capabilityFilter} listClassName="h-full max-h-none" /></Command>}
        </div>
      </div>
      {selectedModel && <div className="shrink-0"><button type="button" disabled={testing} onClick={() => void handleTest()} className="rounded-md border border-border bg-s2 px-4 py-1.5 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50">{testing ? t("sending") : t("test_hi_btn")}</button>{testResult?.reply && <div className="mt-2"><span className="inline-flex rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] italic text-success">&ldquo;{testResult.reply.length > 200 ? `${testResult.reply.slice(0, 200)}...` : testResult.reply}&rdquo;</span></div>}{testResult?.error && <div className="mt-2"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close /> {testResult.error}</span></div>}</div>}
      {!binding.isExplicit && <p className="shrink-0 font-ui text-[11px] leading-snug text-t4">{t("coauthor.provider.fallback_explainer")}</p>}
    </div>}
    footer={<div data-testid="coauthor-modal-footer" className={cn("flex shrink-0 items-center justify-end gap-2 border-t border-border", isMobile ? "px-4 py-3" : "px-6 py-4")}><button type="button" className="rounded-md px-3 py-1.5 font-ui text-[12px] font-medium text-t3 transition-colors hover:bg-s2 hover:text-t1" onClick={onClose}>{t("cancel")}</button><button type="button" disabled={!canSave} onClick={() => void handleSave()} className={cn("rounded-md px-4 py-1.5 font-ui text-[12px] font-medium transition-colors", canSave ? "bg-accent text-accent-t hover:bg-accent/90" : "cursor-not-allowed bg-s3 text-t4")}>{saving ? t("saving") : t("coauthor.provider.use_for_coauthor")}</button></div>}
  />;
}
