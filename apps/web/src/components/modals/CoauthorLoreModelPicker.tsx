import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import type { ProviderProfileRecord } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { useProviderModels } from "../../hooks/use-provider-models.js";
import { SearchInput } from "../shared/SearchInput.js";
import { ProviderModelList, type ProviderModelListOption } from "../settings/provider/ProviderModelList.js";

export interface CoauthorLoreModelPickerProps {
  profiles: ProviderProfileRecord[];
  providerId: string | null;
  modelName: string | null;
  onSave: (providerId: string | null, modelName: string | null) => Promise<void>;
}

/** Full Co-Author lore-model selector, mirroring the modal's searchable main model list. */
export function CoauthorLoreModelPicker({ profiles, providerId, modelName, onSave }: CoauthorLoreModelPickerProps) {
  const { t } = useT();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(providerId);
  const [selectedModel, setSelectedModel] = useState<string | null>(modelName);
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProviderId) ?? null,
    [profiles, selectedProviderId],
  );
  const { models, loading, error: modelsError, refresh } = useProviderModels(selectedProviderId);
  const filteredProfiles = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    return query
      ? profiles.filter((profile) => profile.name.toLowerCase().includes(query) || profile.providerPreset.toLowerCase().includes(query))
      : profiles;
  }, [profiles, providerSearch]);
  const listModels = useMemo<ProviderModelListOption[]>(() => {
    if (!selectedModel || models.some((model) => model.id === selectedModel)) return models;
    return [{ id: selectedModel, label: selectedModel, toolSupport: "unknown" }, ...models];
  }, [models, selectedModel]);
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return query
      ? listModels.filter((model) => model.label.toLowerCase().includes(query) || model.id.toLowerCase().includes(query))
      : listModels;
  }, [listModels, modelSearch]);

  useEffect(() => {
    setSelectedProviderId(providerId);
    setSelectedModel(modelName);
  }, [modelName, providerId]);

  async function save(provider: string | null, model: string | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onSave(provider, model);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("coauthor.provider.lore_model_save_error"));
    } finally {
      setSaving(false);
    }
  }

  function selectProvider(id: string): void {
    setSelectedProviderId(id);
    setSelectedModel(null);
    setModelSearch("");
    setError(null);
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-border pt-4">
      <label className="mb-1.5 block shrink-0 font-ui text-[12px] font-medium text-t3">{t("coauthor.provider.lore_model_label")}</label>
      <p className="mb-3 font-ui text-[11px] leading-snug text-t4">{t("coauthor.provider.lore_model_hint")}</p>
      <button
        type="button"
        data-testid="coauthor-lore-model-inherit"
        disabled={saving || (providerId === null && modelName === null)}
        onClick={() => void save(null, null)}
        className="mb-3 flex min-h-8 w-full items-center rounded-md border border-dashed border-border bg-s2 px-3 text-left font-ui text-[12px] text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:cursor-default disabled:opacity-60"
      >
        {t("coauthor.provider.lore_model_inherit")}
      </button>
      <SearchInput
        className="mb-2"
        placeholder={t("search_profiles")}
        value={providerSearch}
        onChange={(event) => setProviderSearch(event.target.value)}
      />
      <div className="mb-3 max-h-[180px] shrink-0 overflow-y-auto rounded-lg border border-border">
        {filteredProfiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            disabled={saving}
            onClick={() => selectProvider(profile.id)}
            className={`flex min-h-[48px] w-full items-center gap-3 border-l-[3px] px-4 text-left font-ui transition-colors ${selectedProviderId === profile.id ? "border-l-accent bg-accent-dim text-accent-t" : "border-l-transparent text-t2 hover:bg-s2"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{profile.name}</span>
              <span className="mt-0.5 block text-[11px] text-t4">{profile.providerPreset}</span>
            </span>
          </button>
        ))}
      </div>
      {selectedProfile && (
        <>
          <div className="mb-2 flex shrink-0 items-center gap-2">
            <SearchInput className="min-w-0 flex-1" placeholder={t("coauthor.provider.model_search")} value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} />
            <button type="button" disabled={loading || saving} onClick={() => void refresh()} className="shrink-0 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50">{t("refresh_models")}</button>
          </div>
          <div data-testid="coauthor-lore-model-list" className="h-[250px] shrink-0 overflow-hidden rounded-lg border border-border">
            {loading && <div className="flex h-full items-center justify-center font-ui text-[12px] text-t4">{t("loading")}</div>}
            {(modelsError || error) && <div className="flex h-full items-center justify-center px-4 text-center font-ui text-[12px] text-danger">{modelsError ?? error}</div>}
            {!loading && !modelsError && !error && <Command shouldFilter={false} className="h-full"><ProviderModelList models={filteredModels} selectedId={selectedModel ?? ""} search={modelSearch} favorites={[]} onSelect={(model) => { setSelectedModel(model.id); void save(selectedProfile.id, model.id); }} onToggleFavorite={() => {}} onUseCustomSlug={(slug) => { setSelectedModel(slug); setModelSearch(""); void save(selectedProfile.id, slug); }} listClassName="h-full max-h-none" /></Command>}
          </div>
        </>
      )}
    </div>
  );
}
