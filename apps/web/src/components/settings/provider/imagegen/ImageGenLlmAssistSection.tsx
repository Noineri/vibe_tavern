/**
 * LLM assist section (IG-15): the image-gen profile's explicit assist
 * toggle + LLM provider/model picks + the refusal-retry opt-in
 * (IMAGEGEN_ASSIST_REFUSAL_REPORT step 3). Extracted from ImageGenPane
 * wholesale — behavior-identical.
 */

import { useEffect, useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { Toggle } from "../../../shared/Toggle.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { fetchProviderProfileModels, listProviderProfiles } from "../../../../api/provider-api.js";

// ─── LLM assist (IG-15): explicit per-profile toggle + LLM profile/model pick ──

/** The assist section's provider row — the LLM provider list mapped down to
 *  the picker's needs (id, display name, default model). */
interface LlmProfileOption {
  id: string;
  label: string;
  defaultModel: string | null;
}

export function LlmAssistSection({
  enabled,
  providerProfileId,
  modelId,
  retryOnRefusal,
  onToggle,
  onPickProvider,
  onPickModel,
  onToggleRetry,
}: {
  enabled: boolean;
  providerProfileId: string | null;
  modelId: string | null;
  retryOnRefusal: boolean;
  onToggle: (next: boolean) => void;
  onPickProvider: (next: string) => void;
  onPickModel: (next: string) => void;
  onToggleRetry: (next: boolean) => void;
}) {
  const { t } = useT();
  const [providerProfiles, setProviderProfiles] = useState<LlmProfileOption[] | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, Array<{ id: string; label: string }>>>({});

  // LLM provider list: loaded once when the section becomes visible (the
  // ExperienceSetupModal pattern — an inline error surface, never a crash).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listProviderProfiles()
      .then((profiles) => {
        if (cancelled) return;
        setProviderProfiles(
          profiles.map((p) => ({ id: p.id, label: p.name, defaultModel: p.defaultModel ?? null })),
        );
      })
      .catch(() => {
        if (!cancelled) setProviderProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // The picked provider's model catalog, cached per provider (idempotent —
  // a re-render with the cache present does not refetch).
  useEffect(() => {
    if (!enabled || providerProfileId === null) return;
    if (modelsByProvider[providerProfileId] !== undefined) return;
    let cancelled = false;
    fetchProviderProfileModels(providerProfileId)
      .then((res) => {
        if (cancelled) return;
        setModelsByProvider((prev) => ({
          ...prev,
          [providerProfileId]: res.models.map((m) => ({ id: m.id, label: m.label || m.id })),
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setModelsByProvider((prev) => ({ ...prev, [providerProfileId]: [] }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, providerProfileId, modelsByProvider]);

  // The saved picks stay visible even when the lists do not contain them
  // (a since-removed profile/model) — the STT/LLM selector rule.
  const pickedProvider = providerProfiles?.find((p) => p.id === providerProfileId);
  const fetchedModels = providerProfileId !== null ? modelsByProvider[providerProfileId] : undefined;
  const providerOptions = [
    { id: "", label: t("image_gen_assist_provider_none") },
    ...(providerProfiles ?? []).map((p) => ({ id: p.id, label: p.label })),
    ...(providerProfileId !== null && !pickedProvider ? [{ id: providerProfileId, label: providerProfileId }] : []),
  ];
  const modelOptions = [
    { id: "", label: t("image_gen_assist_model_none") },
    ...(fetchedModels ?? []),
    // The provider's default model stays pickable even when the listing
    // omits it (the ExperienceSetupModal rule) — but only when it differs
    // from what the catalog already offers.
    ...(pickedProvider?.defaultModel != null && !(fetchedModels ?? []).some((m) => m.id === pickedProvider.defaultModel)
      ? [{ id: pickedProvider.defaultModel, label: pickedProvider.defaultModel }]
      : []),
    ...(modelId !== null && !["", ...(fetchedModels ?? []).map((m) => m.id), pickedProvider?.defaultModel ?? ""].includes(modelId)
      ? [{ id: modelId, label: modelId }]
      : []),
  ];

  return (
    <section className="rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-assist-section">
      <div className="mb-3 font-ui text-[14px] font-semibold text-t1">{t("image_gen_assist_title")}</div>
      <div className="flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
        <Toggle
          checked={enabled}
          onChange={onToggle}
          className="!mb-0 !inline-flex"
          aria-label={t("image_gen_assist_title")}
        />
        <div className="min-w-0">
          <div className="font-ui text-[13px] font-medium text-t1">{t("image_gen_assist_title")}</div>
          <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
            {t("image_gen_assist_hint")}
          </div>
        </div>
      </div>
      {enabled && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <label className={lblCls}>{t("image_gen_assist_provider_label")}</label>
            <DropdownSelect
              value={providerProfileId ?? ""}
              options={providerOptions}
              onChange={onPickProvider}
              triggerTestId="image-gen-assist-provider"
            />
          </div>
          <div className="min-w-0">
            <label className={lblCls}>{t("image_gen_assist_model_label")}</label>
            <DropdownSelect
              value={modelId ?? ""}
              options={modelOptions}
              onChange={onPickModel}
              triggerTestId="image-gen-assist-model"
              disabled={providerProfileId === null}
            />
          </div>
        </div>
      )}
      {/* Refusal retry (the assist seam's refusal guard): the SAME boolean
          row pattern as the section toggle above — one silent retry after a
          refused assist output, off by default. */}
      {enabled && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
          <Toggle
            checked={retryOnRefusal}
            onChange={onToggleRetry}
            className="!mb-0 !inline-flex"
            aria-label={t("image_gen_assist_retry_label")}
          />
          <div className="min-w-0">
            <div className="font-ui text-[13px] font-medium text-t1">{t("image_gen_assist_retry_label")}</div>
            <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
              {t("image_gen_assist_retry_hint")}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
