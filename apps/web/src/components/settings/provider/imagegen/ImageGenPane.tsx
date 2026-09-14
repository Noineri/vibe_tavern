import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useT, type TFunc } from "../../../../i18n/context.js";
import { IMAGE_GENERATION_MODES, type ImageGenerationMode } from "@vibe-tavern/domain";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { TextInput } from "../../../shared/text-input.js";
import { Toggle } from "../../../shared/Toggle.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { getModalPortal } from "../../../shared/modal-helpers.js";
import type { ImageGenModelEntry } from "../../../../api/image-gen-api.js";
import { fetchProviderProfileModels, listProviderProfiles } from "../../../../api/provider-api.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/**
 * Image-gen second level (IMAGE_GENERATION_PLAN IG-12) — the SttModelPicker /
 * ProviderBindingPanel forks composed on the LLM-tab canon: model picker fed
 * by the saved-profile models cache (manual custom-slug fallback), persisted
 * star-favorites (IG-12b routes), per-mode size presets (profile base), and
 * a bind-routed parameter card — sampler (capability-gated) + advanced
 * expand (steps / CFG / seed / clip skip).
 *
 * BIND ROUTING (the LLM bindPerModel mechanic on data instead of a profile
 * column): the Toggle "per-model settings" switches the SAME visible fields
 * between the profile base (`setForm` — saved by the footer's profile PATCH)
 * and the selected model's overlay (`setModelOverlay` — the footer Save PUTs
 * it after the profile PATCH; toggling OFF DELETEs the overlay immediately,
 * reverting the model to the base). Empty fields ALWAYS mean "inherit / use
 * the vendor default" — no numeric default ships in code (the
 * hardcoded-parameters ban; the plan's all-numeric-EMPTY gate).
 *
 * Numeric fields use TextInput with inputMode="numeric" (the LogitBiasPanel
 * precedent) instead of NumberInput: NumberInput requires a concrete number
 * (no empty state), and this pane's contract is optional-empty numerics.
 */

/** Picker option — the models cache entry verbatim. */
interface ModelOption {
  id: string;
  label: string;
  isFree?: boolean;
}

/** The six v1 modes as a render list (domain order). */
const MODES = Object.values(IMAGE_GENERATION_MODES) as ImageGenerationMode[];

/** i18n key per mode — full words, typed against the Resources interface
 *  (a literal map, not a dynamic string — typo = compile error). */
const MODE_LABEL_KEYS: Record<ImageGenerationMode, Parameters<TFunc>[0]> = {
  [IMAGE_GENERATION_MODES.SceneBackground]: "image_gen_mode_scene-background",
  [IMAGE_GENERATION_MODES.Portrait]: "image_gen_mode_portrait",
  [IMAGE_GENERATION_MODES.Character]: "image_gen_mode_character",
  [IMAGE_GENERATION_MODES.UserPersona]: "image_gen_mode_user-persona",
  [IMAGE_GENERATION_MODES.SceneIllustration]: "image_gen_mode_scene-illustration",
  [IMAGE_GENERATION_MODES.Free]: "image_gen_mode_free",
};

// ─── Model picker (SttModelPicker fork: favorites pinned + custom-slug) ──────

function ModelPicker({
  value,
  onChange,
  models,
  fetching,
  favoriteIds,
  onStar,
  onUnstar,
  onRefresh,
}: {
  value: string | null;
  onChange: (modelId: string) => void;
  models: ModelOption[];
  fetching: boolean;
  favoriteIds: Set<string>;
  onStar: () => void;
  onUnstar: () => void;
  onRefresh: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedModel = models.find((model) => model.id === value);
  // The selected id always stays visible even when it is not in the fetched
  // list (a hand-typed or since-removed model) — the STT/LLM selector rule.
  const listModels = selectedModel || !value ? models : [{ id: value, label: value }, ...models];
  const portalContainer = getModalPortal() ?? undefined;

  const starred = value !== null && favoriteIds.has(value);

  const selectModel = (model: ModelOption) => {
    onChange(model.id);
    setOpen(false);
    setSearch("");
  };
  const useCustomSlug = (slug: string) => {
    onChange(slug);
    setOpen(false);
    setSearch("");
  };

  const query = search.trim().toLowerCase();
  const visible = listModels
    .filter((model) => !query || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query))
    .sort((a, b) => a.label.localeCompare(b.label));
  const favoriteRows = visible.filter((model) => favoriteIds.has(model.id));
  const otherRows = visible.filter((model) => !favoriteIds.has(model.id));
  const customSlug = search.trim();
  const hasExactMatch = listModels.some((model) => model.id === customSlug);

  const renderRow = (model: ModelOption) => (
    <Command.Item
      key={model.id}
      value={model.id}
      data-testid="image-gen-model-option"
      onSelect={() => selectModel(model)}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
        model.id === value
          ? "bg-accent-dim font-medium text-accent-t"
          : "text-t2 hover:bg-s2 hover:text-t1 data-[selected=true]:bg-s2 data-[selected=true]:text-t1",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t1">{model.label || model.id}</span>
          {model.isFree && (
            <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">free</span>
          )}
        </div>
        {model.label && model.label !== model.id && (
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-t4">
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{model.id}</span>
          </div>
        )}
      </div>
    </Command.Item>
  );

  return (
    <div className="my-4">
      <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">
        {t("model_label")}
      </div>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <label className="mb-[6px] block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3">
            {t("selected_model_label")}
          </label>
          <div className="relative">
            <Popover.Root open={open} onOpenChange={setOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  data-testid="image-gen-field-model"
                  className="flex w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[6px] font-ui text-[13px] text-t1 transition-colors hover:border-accent"
                >
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                    {fetching && models.length === 0
                      ? t("loading")
                      : selectedModel?.label || value || t("select_model")}
                  </span>
                  <span className="text-t3">
                    <Icons.Caret direction="d" />
                  </span>
                </button>
              </Popover.Trigger>
              <Popover.Portal container={portalContainer}>
                <Popover.Content
                  sideOffset={4}
                  align="start"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                  className="glass-blur z-[600] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
                  style={{ width: "var(--radix-popover-trigger-width)", maxHeight: 260 }}
                >
                  <Command shouldFilter={false} loop className="flex flex-col outline-none">
                    <div className="border-b border-border2 bg-s2 p-2">
                      <Command.Input
                        placeholder={t("search_models")}
                        value={search}
                        onValueChange={setSearch}
                        className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
                      />
                    </div>
                    <Command.List className="max-h-[200px] overflow-y-auto bg-surface p-1">
                      {favoriteRows.length > 0 && (
                        <div className="px-2.5 pb-1 pt-1.5 font-ui text-[10px] font-medium uppercase tracking-wide text-t4">
                          {t("image_gen_favorites_group")}
                        </div>
                      )}
                      {favoriteRows.map(renderRow)}
                      {otherRows.length > 0 && favoriteRows.length > 0 && (
                        <div className="px-2.5 pb-1 pt-1.5 font-ui text-[10px] font-medium uppercase tracking-wide text-t4">
                          {t("image_gen_all_models_group")}
                        </div>
                      )}
                      {otherRows.map(renderRow)}
                      {customSlug && !hasExactMatch && (
                        <Command.Item
                          data-testid="use-custom-model"
                          value={`use-${customSlug}`}
                          onSelect={() => useCustomSlug(customSlug)}
                          className="cursor-pointer rounded px-2.5 py-1.5 font-ui text-[12px] text-accent-t data-[selected=true]:bg-s2"
                        >
                          {t("use_custom_model_id", { id: customSlug })}
                        </Command.Item>
                      )}
                      {visible.length === 0 && !customSlug && (
                        <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">{t("no_models_found")}</div>
                      )}
                    </Command.List>
                  </Command>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {!selectedModel && value && (
              <div className="mt-2 font-ui text-[12px] font-medium text-accent">{t("custom_model", { name: value })}</div>
            )}
          </div>
        </div>
        {value !== null && (
          <button
            type="button"
            data-testid={starred ? "image-gen-unstar-model" : "image-gen-star-model"}
            onClick={() => (starred ? void onUnstar() : void onStar())}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md border px-4 py-[6px] font-ui text-[13px] font-medium transition-colors",
              starred
                ? "border-accent/40 bg-accent/10 text-accent-t"
                : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
            )}
            title={starred ? t("image_gen_unstar_model") : t("image_gen_star_model")}
          >
            <span className={starred ? "text-accent" : "text-t3"}>{starred ? <Icons.starFilled /> : <Icons.star />}</span>
            {starred ? t("image_gen_unstar_model") : t("image_gen_star_model")}
          </button>
        )}
        <button
          type="button"
          data-testid="image-gen-models-refresh"
          onClick={() => onRefresh()}
          disabled={fetching}
          className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-s2 px-4 py-[6px] font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
          title={t("refresh_models")}
        >
          {fetching ? (
            <span className="ml-[3px] inline-flex items-center gap-[3px] align-middle">
              <span className="h-1 w-1 animate-genp rounded-full bg-accent" />
              <span className="h-1 w-1 animate-genp rounded-full bg-accent [animation-delay:0.18s]" />
              <span className="h-1 w-1 animate-genp rounded-full bg-accent [animation-delay:0.36s]" />
            </span>
          ) : (
            <Icons.Regen />
          )}
          {t("refresh_models")}
        </button>
      </div>
    </div>
  );
}

// ─── Optional numeric field (TextInput inputMode=numeric — the empty-able
//     numeric; no NumberInput because it requires a concrete number) ────────

function OptionalNumberField({
  value,
  onChange,
  label,
  testId,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="min-w-0">
      <label className={lblCls}>{label}</label>
      <TextInput
        inputMode="numeric"
        data-testid={testId}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </div>
  );
}

// ─── LLM assist (IG-15): explicit per-profile toggle + LLM profile/model pick ──

/** The assist section's provider row — the LLM provider list mapped down to
 *  the picker's needs (id, display name, default model). */
interface LlmProfileOption {
  id: string;
  label: string;
  defaultModel: string | null;
}

function LlmAssistSection({
  enabled,
  providerProfileId,
  modelId,
  onToggle,
  onPickProvider,
  onPickModel,
}: {
  enabled: boolean;
  providerProfileId: string | null;
  modelId: string | null;
  onToggle: (next: boolean) => void;
  onPickProvider: (next: string) => void;
  onPickModel: (next: string) => void;
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
    </section>
  );
}

// ─── The pane ────────────────────────────────────────────────────────────────

export function ImageGenPane({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const form = imageGen.form;
  // Hook-order invariant: EVERY hook sits above the null guard — an early
  // return between hooks crashes React the moment `form` goes null →
  // non-null ("Rendered more hooks than during the previous render"; caught
  // by the real-hook round-trip tests, which mount before a form exists).
  const guardProfileId = form?.id ?? null;
  const guardSamplers = form?.capabilities.supportsSamplers ?? false;
  useEffect(() => {
    if (guardProfileId === null || !guardSamplers) return;
    if ((imageGen.samplersByProfile[guardProfileId] ?? []).length === 0) {
      void imageGen.fetchSamplers(guardProfileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [guardProfileId, guardSamplers]);

  if (form === null || form.id === null) return null;
  const profileId = form.id;
  const models: ImageGenModelEntry[] = imageGen.modelsByProfile[profileId] ?? [];
  const samplers = imageGen.samplersByProfile[profileId] ?? [];
  const caps = form.capabilities;
  const bound = imageGen.modelOverlay !== null;
  const overlay = imageGen.modelOverlay;

  // Effective (routed) params + sizes: the overlay's own values while bound
  // (empty = inherit the base), the profile base otherwise.
  const params = bound ? (overlay ?? {}) : form.defaultParams;
  const sizes = bound ? (overlay?.modeSizePresets ?? {}) : form.modeSizePresets;

  const setParam = (patch: Partial<typeof params>) => {
    if (bound) imageGen.setModelOverlay(patch);
    else imageGen.setForm({ defaultParams: { ...form.defaultParams, ...patch } });
  };
  const setModeSize = (mode: string, next: { width?: number; height?: number } | undefined) => {
    const nextSizes = { ...sizes };
    if (next === undefined || (next.width === undefined && next.height === undefined)) {
      delete nextSizes[mode as keyof typeof nextSizes];
    } else {
      nextSizes[mode as keyof typeof nextSizes] = next;
    }
    if (bound) imageGen.setModelOverlay({ modeSizePresets: nextSizes });
    else imageGen.setForm({ modeSizePresets: nextSizes });
  };

  const favoriteIds = new Set(imageGen.favorites.map((f) => f.modelId));
  const selectedLabel = models.find((model) => model.id === form.modelId)?.label;

  return (
    <div data-testid="image-gen-pane" className="mt-1 flex flex-col gap-4">
      {/* ── Model: picker + star + refresh (bare, the first level-2 section) ── */}
      <ModelPicker
        value={form.modelId}
        onChange={(modelId) => {
          // The hook's setForm handles the model switch: bind state resets
          // and the NEW model's stored overlay loads (fire-and-forget — the
          // pane never races the async form state).
          imageGen.setForm({ modelId });
        }}
        models={models}
        fetching={false}
        favoriteIds={favoriteIds}
        onStar={() => form.modelId !== null && void imageGen.starModel(form.modelId, selectedLabel)}
        onUnstar={() => form.modelId !== null && void imageGen.unstarModel(form.modelId!)}
        onRefresh={() => void imageGen.fetchSavedModels(profileId)}
      />

      {/* ── Sizes per mode (profile base or the bound model's override) ── */}
      <section className="rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-sizes-section">
        <div className="mb-3 font-ui text-[14px] font-semibold text-t1">{t("image_gen_sizes_section_title")}</div>
        <div className="flex flex-col gap-2.5">
          {MODES.map((mode) => {
            const preset = sizes[mode as keyof typeof sizes];
            const key = preset !== undefined && preset.width !== undefined && preset.height !== undefined
              ? `${preset.width}x${preset.height}`
              : "";
            return (
              <div key={mode} className="flex flex-wrap items-center gap-3" data-testid={`image-gen-mode-row-${mode}`}>
                <div className="w-[180px] shrink-0 font-ui text-[13px] text-t2">{t(MODE_LABEL_KEYS[mode])}</div>
                {caps.sizeSupport.kind === "vendor-set" ? (
                  <DropdownSelect
                    value={key}
                    triggerTestId={`image-gen-mode-size-${mode}`}
                    searchable={false}
                    className="w-auto max-w-[260px]"
                    options={[
                      { id: "", label: t("image_gen_size_auto") },
                      ...caps.sizeSupport.sizes.map((size) => ({ id: size, label: size })),
                    ]}
                    onChange={(next) => {
                      if (next === "") {
                        setModeSize(mode, undefined);
                        return;
                      }
                      const [width, height] = next.split("x").map(Number);
                      setModeSize(mode, { width, height });
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-[110px]">
                      <OptionalNumberField
                        value={preset?.width}
                        onChange={(width) => setModeSize(mode, { ...preset, width })}
                        label={t("image_gen_width_label")}
                        testId={`image-gen-mode-width-${mode}`}
                      />
                    </div>
                    <div className="w-[110px]">
                      <OptionalNumberField
                        value={preset?.height}
                        onChange={(height) => setModeSize(mode, { ...preset, height })}
                        label={t("image_gen_height_label")}
                        testId={`image-gen-mode-height-${mode}`}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Parameters: bind toggle + sampler + advanced expand ── */}
      <section className="rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-params-section">
        <div className="mb-3 font-ui text-[14px] font-semibold text-t1">{t("image_gen_params_section_title")}</div>

        {form.modelId !== null && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
            <Toggle
              checked={bound}
              onChange={(v) => (v ? void imageGen.bindModelOverlay() : void imageGen.unbindModelOverlay())}
              className="!mb-0 !inline-flex"
              aria-label={t("image_gen_bind_per_model")}
            />
            <div className="min-w-0">
              <div className="font-ui text-[13px] font-medium text-t1">{t("image_gen_bind_per_model")}</div>
              <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
                {t("image_gen_bind_per_model_hint", { model: form.modelId })}
              </div>
            </div>
          </div>
        )}
        {bound && (
          <div className="mb-3 font-ui text-[12px] text-t3" data-testid="image-gen-overlay-inherit-hint">
            {t("image_gen_overlay_inherit_hint")}
          </div>
        )}

        {caps.supportsSamplers && (
          <div className="mb-3">
            <label className={lblCls}>{t("image_gen_sampler_label")}</label>
            <DropdownSelect
              value={params.sampler ?? ""}
              triggerTestId="image-gen-field-sampler"
              searchable={false}
              className="w-auto max-w-[320px]"
              options={[
                { id: "", label: t("image_gen_sampler_auto") },
                ...samplers.map((sampler) => ({ id: sampler.name, label: sampler.name })),
              ]}
              onChange={(next) => setParam({ sampler: next === "" ? undefined : next })}
            />
          </div>
        )}

        {/* Advanced expand (the ProviderSamplerPanel accordion header shape) */}
        <div className="mt-2 overflow-hidden rounded-lg border border-border2">
          <button
            type="button"
            data-testid="image-gen-advanced-header"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)]",
              advancedOpen && "!rounded-b-none",
            )}
          >
            <span className={cn("transition-transform", advancedOpen && "rotate-90")}>
              <Icons.Caret direction="r" />
            </span>
            {t("image_gen_advanced")}
          </button>
          {advancedOpen && (
            <div className="grid grid-cols-1 gap-3 bg-surface p-3 sm:grid-cols-2" data-testid="image-gen-advanced-body">
              <OptionalNumberField
                value={params.steps}
                onChange={(steps) => setParam({ steps })}
                label={t("image_gen_steps_label")}
                testId="image-gen-field-steps"
              />
              <OptionalNumberField
                value={params.cfgScale}
                onChange={(cfgScale) => setParam({ cfgScale })}
                label={t("image_gen_cfg_label")}
                testId="image-gen-field-cfg"
              />
              <OptionalNumberField
                value={params.seed}
                onChange={(seed) => setParam({ seed })}
                label={t("image_gen_seed_label")}
                testId="image-gen-field-seed"
              />
              <OptionalNumberField
                value={params.clipSkip}
                onChange={(clipSkip) => setParam({ clipSkip })}
                label={t("image_gen_clip_skip_label")}
                testId="image-gen-field-clip-skip"
              />
            </div>
          )}
        </div>
      </section>

      {/* ── LLM assist (IG-15): explicit per-profile toggle + LLM pick ── */}
      <LlmAssistSection
        enabled={form.llmAssistEnabled}
        providerProfileId={form.llmProviderProfileId}
        modelId={form.llmModelId}
        onToggle={(next) => imageGen.setForm({ llmAssistEnabled: next })}
        onPickProvider={(next) =>
          // A provider switch invalidates the model pick — a model id from
          // another provider is meaningless, so the pick resets to null.
          imageGen.setForm({ llmProviderProfileId: next === "" ? null : next, llmModelId: null })
        }
        onPickModel={(next) => imageGen.setForm({ llmModelId: next === "" ? null : next })}
      />
    </div>
  );
}
