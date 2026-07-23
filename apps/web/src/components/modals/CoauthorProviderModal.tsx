/**
 * Dedicated Co-Author provider modal — a selection-only surface that consumes
 * the shared connection-profile pool but writes to the independent Co-Author
 * binding (`uiSettings.coauthorProviderId` + `coauthorModelName`).
 *
 * Unlike the RP {@link ProviderModal}, this modal:
 * - Never activates a profile or writes `defaultModel`.
 * - Shows only tool-capable models (Co-Author turns require function-calling).
 * - Saves an atomic profile+model pair via `patchUiSettingsAction`.
 * - Hands connection CRUD (credentials, endpoints, new profiles) to the
 *   original ProviderModal via a "Manage connections" action.
 *
 * Reuses: MasterDetailModal, ProviderProfileList (selectionOnly), shared
 * field/button primitives, cmdk Command for the model picker.
 */

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useCoauthorProviderBinding } from "../../hooks/use-coauthor-provider-binding.js";
import { useProviderModels } from "../../hooks/use-provider-models.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { ProviderProfileList } from "../settings/provider/ProviderProfileList.js";
import { Icons } from "../shared/icons.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { cn } from "../../lib/cn.js";

export interface CoauthorProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the original RP ProviderModal (manage-connections handoff). */
  onOpenProviderModal: () => void;
}

export function CoauthorProviderModal({ isOpen, onClose, onOpenProviderModal }: CoauthorProviderModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const profiles = useProviderDataStore((s) => s.profiles);
  const binding = useCoauthorProviderBinding();

  // Local selection state — initialized from the persisted binding, updated by
  // the user, committed atomically on "Use for Co-Author".
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(binding.profileId);
  const [selectedModel, setSelectedModel] = useState<string | null>(binding.model);
  const [profileSearch, setProfileSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Sync local state when the modal opens (binding may have changed since last open).
  useEffect(() => {
    if (isOpen) {
      setSelectedProfileId(binding.profileId);
      setSelectedModel(binding.model);
      setProfileSearch("");
      setModelSearch("");
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- binding is read on open only

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  // Tool-capable models for the selected profile (cache-first, live-fetch fallback).
  const { models: toolModels, loading: modelsLoading, error: modelsError } = useProviderModels(selectedProfileId);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return toolModels;
    return toolModels.filter(
      (m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [toolModels, modelSearch]);

  const dirty = selectedProfileId !== binding.profileId || selectedModel !== binding.model;
  const canSave = Boolean(selectedProfileId) && Boolean(selectedModel) && dirty && !saving;

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
    setSelectedProfileId(id);
    // Reset model selection when switching profiles — the old model may not
    // exist on the new profile.
    setSelectedModel(null);
    setModelSearch("");
  }

  const filteredProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(
      (p) => p.name.toLowerCase().includes(q) || p.providerPreset.toLowerCase().includes(q),
    );
  }, [profiles, profileSearch]);

  return (
    <MasterDetailModal
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
      headerActions={
        <button
          type="button"
          className="font-ui text-[12px] font-medium text-t3 transition-colors hover:text-t1"
          onClick={() => {
            onClose();
            onOpenProviderModal();
          }}
        >
          {t("coauthor.provider.manage_connections")}
        </button>
      }
      masterContent={() => (
        <ProviderProfileList
          profiles={profiles}
          filteredProfiles={filteredProfiles}
          editingId={null}
          activeProviderProfileId={binding.profileId}
          profileSearch={profileSearch}
          onProfileSearchChange={setProfileSearch}
          onSelectProfile={handleSelectProfile}
          selectionOnly
        />
      )}
      detailContent={
        !selectedProfile ? (
          <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">
            {profiles.length === 0
              ? t("coauthor.provider.no_profiles")
              : t("coauthor.provider.select_profile")}
          </div>
        ) : (
          <div className="flex h-full flex-col gap-4">
            {/* Connection summary (read-only) */}
            <div className="rounded-lg border border-border bg-s2 px-4 py-3">
              <div className="font-ui text-[13px] font-medium text-t1">{selectedProfile.name}</div>
              <div className="mt-0.5 font-ui text-[11px] text-t4">
                {selectedProfile.endpoint}
              </div>
            </div>

            {/* Model picker — tool-capable only */}
            <div className="flex min-h-0 flex-1 flex-col">
              <label className="mb-1.5 block font-ui text-[12px] font-medium text-t3">
                {t("coauthor.provider.model_label")}
              </label>

              {/* Search input */}
              <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-s2 px-2.5 py-1.5">
                <Icons.Search />
                <input
                  className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[13px] text-t1 outline-none placeholder:text-t4"
                  placeholder={t("coauthor.provider.model_search")}
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
              </div>

              {/* Model list */}
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                {modelsLoading && (
                  <div className="flex h-full items-center justify-center font-ui text-[12px] text-t4">
                    {t("loading")}
                  </div>
                )}
                {modelsError && (
                  <div className="flex h-full items-center justify-center font-ui text-[12px] text-danger">
                    {modelsError}
                  </div>
                )}
                {!modelsLoading && !modelsError && filteredModels.length === 0 && (
                  <div className="flex h-full items-center justify-center font-ui text-[12px] text-t4">
                    {t("coauthor.provider.no_tool_models")}
                  </div>
                )}
                {!modelsLoading && !modelsError && filteredModels.length > 0 && (
                  <Command>
                    <Command.List className="max-h-full">
                      {filteredModels.map((m) => (
                        <Command.Item
                          key={m.id}
                          value={m.id}
                          onSelect={() => setSelectedModel(m.id)}
                          className={cn(
                            "flex cursor-pointer items-center justify-between border-l-[3px] px-4 py-2.5 font-ui text-[13px] transition-colors",
                            selectedModel === m.id
                              ? "border-l-accent bg-accent/10 text-t1"
                              : "border-l-transparent hover:bg-s2",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{m.label}</div>
                            <div className="truncate text-[11px] text-t4">{m.id}</div>
                          </div>
                          {m.contextLength != null && (
                            <span className="ml-2 shrink-0 text-[11px] text-t4">
                              {m.contextLength >= 1000
                                ? `${(m.contextLength / 1000).toFixed(m.contextLength % 1000 === 0 ? 0 : 1)}k`
                                : m.contextLength}
                            </span>
                          )}
                        </Command.Item>
                      ))}
                    </Command.List>
                  </Command>
                )}
              </div>
            </div>

            {/* Fallback explanation */}
            {!binding.isExplicit && (
              <p className="font-ui text-[11px] leading-snug text-t4">
                {t("coauthor.provider.fallback_explainer")}
              </p>
            )}

            {/* Save footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 font-ui text-[12px] font-medium text-t3 transition-colors hover:bg-s2 hover:text-t1"
                onClick={onClose}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={() => void handleSave()}
                className={cn(
                  "rounded-md px-4 py-1.5 font-ui text-[12px] font-medium transition-colors",
                  canSave
                    ? "bg-accent text-accent-t hover:bg-accent/90"
                    : "cursor-not-allowed bg-s3 text-t4",
                )}
              >
                {saving ? t("saving") : t("coauthor.provider.use_for_coauthor")}
              </button>
            </div>
          </div>
        )
      }
    />
  );
}
