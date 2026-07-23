import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { MODEL_FAVORITE_SCOPE } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useCoauthorProviderBinding } from "../../hooks/use-coauthor-provider-binding.js";
import { useProviderModels } from "../../hooks/use-provider-models.js";
import { type ToolSupport } from "../../lib/provider-model-capabilities.js";
import { loadFavoriteModelsAction, testProfileChatAction, toggleFavoriteModelAction } from "../../stores/api-actions/provider-actions.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { ProviderProfileList } from "../settings/provider/ProviderProfileList.js";
import { ProviderModelList, type ProviderModelListOption } from "../settings/provider/ProviderModelList.js";
import { Icons } from "../shared/icons.js";
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
  const resumeProfileId = useModalStore((state) => state.coauthorResumeProfileId);
  const consumeCoauthorResumeProfileId = useModalStore((state) => state.consumeCoauthorResumeProfileId);
  const binding = useCoauthorProviderBinding();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(binding.profileId);
  const [selectedModel, setSelectedModel] = useState<string | null>(binding.model);
  const [profileSearch, setProfileSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>("all");
  const [saving, setSaving] = useState(false);
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
    setTestResult(null);
  }, [isOpen]); // binding is intentionally sampled on normal open

  useEffect(() => {
    if (selectedProfileId) void loadFavoriteModelsAction(selectedProfileId, MODEL_FAVORITE_SCOPE.coauthor);
  }, [selectedProfileId]);

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === selectedProfileId) ?? null, [profiles, selectedProfileId]);
  const { models, loading: modelsLoading, error: modelsError } = useProviderModels(selectedProfileId);
  const favorites = selectedProfileId ? favoritesByProfile[selectedProfileId] ?? [] : [];

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
    setTestResult(null);
  }
  async function handleTest() {
    if (!selectedProfileId || !selectedModel) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProfileChatAction(selectedProfileId, selectedModel));
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
    detailContent={!selectedProfile ? <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">{profiles.length === 0 ? t("coauthor.provider.no_profiles") : t("coauthor.provider.select_profile")}</div> : <div className="flex h-full flex-col gap-4">
      <div className="rounded-lg border border-border bg-s2 px-4 py-3"><div className="font-ui text-[13px] font-medium text-t1">{selectedProfile.name}</div><div className="mt-0.5 font-ui text-[11px] text-t4">{selectedProfile.endpoint}</div></div>
      <div className="flex min-h-0 flex-1 flex-col">
        <label className="mb-1.5 block font-ui text-[12px] font-medium text-t3">{t("coauthor.provider.model_label")}</label>
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-s2 px-2.5 py-1.5"><Icons.Search /><input className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[13px] text-t1 outline-none placeholder:text-t4" placeholder={t("coauthor.provider.model_search")} value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} /></div>
        <div className="mb-2 flex flex-wrap gap-1">{filterOptions.map((option) => <button key={option.value} type="button" onClick={() => setCapabilityFilter(option.value)} className={cn("rounded px-2 py-1 font-ui text-[11px]", capabilityFilter === option.value ? "bg-accent/15 text-accent-t" : "bg-s2 text-t3 hover:text-t1")}>{option.label}</button>)}</div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          {modelsLoading && <div className="flex h-full items-center justify-center font-ui text-[12px] text-t4">{t("loading")}</div>}
          {modelsError && <div className="flex h-full items-center justify-center font-ui text-[12px] text-danger">{modelsError}</div>}
          {!modelsLoading && !modelsError && <Command shouldFilter={false}><ProviderModelList models={filteredModels} selectedId={selectedModel ?? ""} search={modelSearch} favorites={favorites} onSelect={(model) => { setSelectedModel(model.id); setTestResult(null); }} onToggleFavorite={(model) => void handleToggleFavorite(model)} onUseCustomSlug={(slug) => { setSelectedModel(slug); setModelSearch(""); setTestResult(null); }} toolFilter={capabilityFilter === "all" ? undefined : capabilityFilter} /></Command>}
        </div>
      </div>
      {selectedModel && <div><button type="button" disabled={testing} onClick={() => void handleTest()} className="rounded-md border border-border bg-s2 px-4 py-1.5 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50">{testing ? t("sending") : t("test_hi_btn")}</button>{testResult?.reply && <div className="mt-2"><span className="inline-flex rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] italic text-success">&ldquo;{testResult.reply.length > 200 ? `${testResult.reply.slice(0, 200)}...` : testResult.reply}&rdquo;</span></div>}{testResult?.error && <div className="mt-2"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close /> {testResult.error}</span></div>}</div>}
      {!binding.isExplicit && <p className="font-ui text-[11px] leading-snug text-t4">{t("coauthor.provider.fallback_explainer")}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3"><button type="button" className="rounded-md px-3 py-1.5 font-ui text-[12px] font-medium text-t3 transition-colors hover:bg-s2 hover:text-t1" onClick={onClose}>{t("cancel")}</button><button type="button" disabled={!canSave} onClick={() => void handleSave()} className={cn("rounded-md px-4 py-1.5 font-ui text-[12px] font-medium transition-colors", canSave ? "bg-accent text-accent-t hover:bg-accent/90" : "cursor-not-allowed bg-s3 text-t4")}>{saving ? t("saving") : t("coauthor.provider.use_for_coauthor")}</button></div>
    </div>}
  />;
}
