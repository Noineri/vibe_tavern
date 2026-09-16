import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { toast } from "sonner";
import { useT, type TFunc } from "../../../../i18n/context.js";
import { IMAGE_GEN_BACKENDS, IMAGE_GENERATION_MODES, IMAGE_GEN_PARAM_RANGES, IMAGE_GEN_ADETAILER_FACE_MODELS, IMAGE_GEN_ADETAILER_DEFAULT_MODEL, IMAGE_SIZE_DEFAULT, IMAGE_SIZE_MAX_PX, IMAGE_SIZE_MIN_PX, IMAGE_SIZE_PRESETS, IMAGE_SIZE_STEP_PX, hasAdetailerExtension, type ImageGenerationMode, type ImageGenParamRange, type ImageSizeOrientation } from "@vibe-tavern/domain";
import { Icons } from "../../../shared/icons.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { cn } from "../../../../lib/cn.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { TextInput } from "../../../shared/text-input.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { Toggle } from "../../../shared/Toggle.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { getModalPortal } from "../../../shared/modal-helpers.js";
import { LocalConnectionStatusChip, type LocalConnectionStatus } from "../../../shared/LocalConnectionStatus.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import type { ImageGenSamplerSet } from "@vibe-tavern/api-contracts";
import type { ImageGenModelEntry } from "../../../../api/image-gen-api.js";
import {
  createImageGenSamplerSet,
  deleteImageGenSamplerSet,
  importImageGenSamplerSet,
  listImageGenExtensions,
  listImageGenSamplerSets,
  updateImageGenSamplerSet,
} from "../../../../api/image-gen-api.js";
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
 * Steps / CFG / CLIP-skip pair the canon range input with that same
 * empty-able numeric cell (IG-CF5) — NumberInput stays out deliberately:
 * non-nullable value, blur reverts a clear instead of committing undefined,
 * no testid passthrough (supervisor decision 2026-09-15).
 * SUPERSEDED FOR SIZES (IG-CF14, owner ruling 2026-09-16 — the old grid
 * was unacceptable and must be redone): the per-mode size rows now use NumberInput WITH a concrete
 * display anchor (IMAGE_SIZE_DEFAULT when unset) — the empty/inherit reset
 * moved into the row's preset dropdown (the Auto entry), so the non-nullable-value
 * objection no longer applies there; the params cells (steps/CFG/seed/clip)
 * keep the optional-empty TextInput contract above. Testids attach via a
 * wrapper div (the primitive has no passthrough).
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

/** Purpose-word per preset orientation (IG-CF14): "Square 1:1 · 1024×1024" —
 *  purpose + ratio + concrete resolution, never a bare ratio. */
const PRESET_LABEL_KEYS: Record<ImageSizeOrientation, Parameters<TFunc>[0]> = {
  square: "image_gen_preset_square",
  portrait: "image_gen_preset_portrait",
  landscape: "image_gen_preset_landscape",
};

// ─── Model picker (SttModelPicker fork: favorites pinned + custom-slug) ──────

function ModelPicker({
  value,
  onChange,
  models,
  fetching,
  favoriteIds,
  onToggleFavorite,
  onRefresh,
}: {
  value: string | null;
  onChange: (modelId: string) => void;
  models: ModelOption[];
  fetching: boolean;
  favoriteIds: Set<string>;
  onToggleFavorite: (model: ModelOption) => void;
  onRefresh: () => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedModel = models.find((model) => model.id === value);
  // The selected id always stays visible even when it is not in the fetched
  // list (a hand-typed or since-removed model) — the STT/LLM selector rule.
  const listModels = selectedModel || !value ? models : [{ id: value, label: value }, ...models];
  const portalContainer = getModalPortal() ?? undefined;

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
  // The LLM ProviderModelList sort verbatim: favorites first, then label —
  // NO group headers (the owner says the LLM dropdown is the canon; its
  // favorites are a sort, not a section split).
  const visible = listModels
    .filter((model) => !query || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query))
    .sort((a, b) => {
      const favoriteOrder = Number(favoriteIds.has(b.id)) - Number(favoriteIds.has(a.id));
      return favoriteOrder || a.label.localeCompare(b.label);
    });
  const customSlug = search.trim();
  const hasExactMatch = listModels.some((model) => model.id === customSlug);

  const renderRow = (model: ModelOption) => {
    const favorite = favoriteIds.has(model.id);
    return (
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
      <CustomTooltip content={favorite ? t("remove_from_favorites") : t("add_to_favorites")}>
        <button
          type="button"
          data-testid="image-gen-model-star"
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-warning-text",
            favorite && "text-warning-text",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(model);
          }}
        >
          {favorite ? <Icons.StarFilled /> : <Icons.Star />}
        </button>
      </CustomTooltip>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t1">{model.label || model.id}</span>
          {model.isFree && (
            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-t4">free</span>
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
  };

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
                      {visible.map(renderRow)}
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
        {/** IG-16 clone rule: the refresh button is the ProviderModelSelector
         *  picker-row canon VERBATIM (the `provider-models-refresh` shape —
         *  Icons.Regen, py-[6px] matching the trigger, mobile icon-only 34px,
         *  genp dots while fetching). The first cut had cloned the wrong
         *  sibling (the local-status chip's mini button, line 109) — caught by
         *  the owner 2026-09-16. */}
        <button
          type="button"
          data-testid="image-gen-models-refresh"
          onClick={() => onRefresh()}
          disabled={fetching}
          className={cn(
            "shrink-0 items-center gap-2 rounded-md border border-border bg-s2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50",
            // Mobile stays the icon-only 34px shape but must match the closed
            // dropdown's height: 2px borders + 2×6px py + 13px×1.5 line box
            // (Tailwind preflight html line-height) = 33.5px. The row is
            // items-end, so a shorter button would leave the row top edges
            // misaligned (MOBILE_UI_DEFECTS_REPORT step 5).
            isMobile ? "flex w-[34px] min-h-[33.5px] justify-center px-0 py-[6px]" : "flex px-4 py-[6px] font-ui text-[13px] font-medium text-t2",
          )}
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
          {!isMobile && <> {t("refresh_models")}</>}
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

// ─── Slider+number field (IG-CF13: the ProviderSamplerPanel SamplerField
//     taken VERBATIM per the owner's 2026-09-16 ruling — take the existing
//     LLM implementation, don't reshape it). The CF5 "empty box /
//     clear-to-undefined" optionality was supervisor spec invention, not an
//     owner requirement — killed. The cell is NumberInput (h-[30px] w-[60px]
//     hideControls — its own self-clamping), the label is the uppercase micro
//     canon, and the display value is `value ?? min` exactly like the LLM
//     panel. Untouched params still don't send until edited. Seed keeps the
//     plain OptionalNumberField above (a 0..2^32 slider is meaningless —
//     owner-approved).

function SamplerSliderField({
  label,
  value,
  onChange,
  range,
  rangeTestId,
  cellTestId,
}: {
  label: string;
  /** The layer's own value (undefined = not set on this layer). */
  value: number | undefined;
  onChange: (next: number) => void;
  range: ImageGenParamRange;
  rangeTestId: string;
  cellTestId: string;
}) {
  const val = value ?? range.min;
  return (
    <div className="min-w-0">
      <label className={lblCls}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          data-testid={rangeTestId}
          min={range.min}
          max={range.max}
          step={range.step}
          value={val}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          className={cn("!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent p-0")}
        />
        <div className="w-[60px] shrink-0" data-testid={cellTestId}>
          <NumberInput
            className="h-[30px] w-[60px]"
            min={range.min}
            max={range.max}
            step={range.step}
            value={val}
            onChange={onChange}
            hideControls
          />
        </div>
      </div>
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

// ─── Model sampler-set row (IG-CF15 — the ProviderSamplerPanel LS-5 set
//     row twin, model-scoped): bounded inline dropdown + 7 icon-only actions
//     (+ 💾 ✏ 🔄 🗑 ⬆ ⬇) + the dirty dot. Semantics fork the LLM row verbatim:
//     apply (select / re-select / 🔄) copies the payload into the open
//     overlay (copy-on-select) + records the pointer; 💾 overwrites the set
//     from the overlay; «+» saves the overlay under a new name; delete never
//     touches applied values — the pointer clears. Edits ride the SAME
//     form-dirty Save as every other overlay edit (one Save button). ───────

/** The set payload projection of an overlay: the five scalar params ONLY
 *  (modeSizePresets is the model layer's own surface, IG-CF14). */
function setPayloadOf(overlay: Record<string, unknown>): { steps?: number; cfgScale?: number; sampler?: string; seed?: number; clipSkip?: number } {
  const payload: { steps?: number; cfgScale?: number; sampler?: string; seed?: number; clipSkip?: number } = {};
  if (typeof overlay.steps === "number") payload.steps = overlay.steps;
  if (typeof overlay.cfgScale === "number") payload.cfgScale = overlay.cfgScale;
  if (typeof overlay.sampler === "string") payload.sampler = overlay.sampler;
  if (typeof overlay.seed === "number") payload.seed = overlay.seed;
  if (typeof overlay.clipSkip === "number") payload.clipSkip = overlay.clipSkip;
  return payload;
}

function ModelSamplerSetRow({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();
  const [sets, setSets] = useState<ImageGenSamplerSet[]>([]);
  const [setsLoaded, setSetsLoaded] = useState(false);
  const [morph, setMorph] = useState<null | { intent: "new" | "rename"; value: string }>(null);
  const [morphConflict, setMorphConflict] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const appliedRef = useRef<{ setId: string; baseline: ReturnType<typeof setPayloadOf> } | null>(null);
  const [, forceRender] = useState(0);
  const bumpApplied = () => forceRender((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void listImageGenSamplerSets()
      .then((list) => {
        if (cancelled) return;
        setSets(list);
        setSetsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSetsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const overlay = imageGen.modelOverlay ?? {};
  const selected = sets.find((s) => s.id === imageGen.modelOverlaySetId) ?? null;

  // Back-fill the dirty-dot baseline from the pre-selected set once the
  // library arrives (previous-session pre-selection — no re-apply).
  useEffect(() => {
    if (!setsLoaded || imageGen.modelOverlaySetId === null) return;
    if (appliedRef.current?.setId === imageGen.modelOverlaySetId) return;
    const set = sets.find((s) => s.id === imageGen.modelOverlaySetId);
    if (!set) return;
    appliedRef.current = { setId: set.id, baseline: { ...set.payload } };
    bumpApplied();
  });

  const isDirty = Boolean(
    selected &&
      appliedRef.current?.setId === selected.id &&
      JSON.stringify(appliedRef.current.baseline) !== JSON.stringify(setPayloadOf(overlay)),
  );

  const applySet = (set: ImageGenSamplerSet) => {
    imageGen.setModelSamplerSetBinding(set.id, set.payload);
    appliedRef.current = { setId: set.id, baseline: { ...set.payload } };
    bumpApplied();
    toast.success(t("sampler_set_applied", { name: set.name }));
  };

  const handleSelectSet = (id: string) => {
    if (id === "") {
      // Explicit "no set": clear the pointer, keep the overlay's values.
      imageGen.setModelSamplerSetBinding(null);
      appliedRef.current = null;
      bumpApplied();
      return;
    }
    const set = sets.find((s) => s.id === id);
    if (set) applySet(set);
  };

  const handleSaveIntoSet = async () => {
    if (!selected) return;
    const payload = setPayloadOf(overlay);
    try {
      const updated = await updateImageGenSamplerSet(selected.id, { payload });
      setSets((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      appliedRef.current = { setId: updated.id, baseline: { ...updated.payload } };
      bumpApplied();
      toast.success(t("sampler_set_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sampler_set_action_failed"));
    }
  };

  const handleMorphConfirm = async () => {
    if (!morph) return;
    const name = morph.value.trim();
    if (!name) return;
    if (morph.intent === "new") {
      try {
        const created = await createImageGenSamplerSet({ name, payload: setPayloadOf(overlay) });
        setSets((list) => [...list, created]);
        imageGen.setModelSamplerSetBinding(created.id, created.payload);
        appliedRef.current = { setId: created.id, baseline: { ...created.payload } };
        bumpApplied();
        setMorph(null);
        setMorphConflict(false);
        toast.success(t("sampler_set_created"));
      } catch (error) {
        setMorphConflict(true);
        toast.error(error instanceof Error ? error.message : t("sampler_set_action_failed"));
      }
      return;
    }
    if (!selected) return;
    try {
      const updated = await updateImageGenSamplerSet(selected.id, { name });
      setSets((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      setMorph(null);
      setMorphConflict(false);
      toast.success(t("sampler_set_renamed"));
    } catch (error) {
      setMorphConflict(true);
      toast.error(error instanceof Error ? error.message : t("sampler_set_action_failed"));
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteId) return;
    try {
      await deleteImageGenSamplerSet(confirmDeleteId);
      setSets((list) => list.filter((s) => s.id !== confirmDeleteId));
      if (imageGen.modelOverlaySetId === confirmDeleteId) {
        imageGen.setModelSamplerSetBinding(null);
      }
      if (appliedRef.current?.setId === confirmDeleteId) {
        appliedRef.current = null;
        bumpApplied();
      }
      setConfirmDeleteId(null);
      toast.success(t("sampler_set_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sampler_set_action_failed"));
    }
  };

  const handleImportFile = async (file: File) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      toast.error(t("sampler_set_import_failed"));
      return;
    }
    const name = file.name.replace(/\.json$/i, "").trim() || t("sampler_set_import_default_name");
    try {
      const { set, notes } = await importImageGenSamplerSet({ name, raw });
      setSets((list) => [...list.filter((s) => s.id !== set.id), set]);
      if (notes.length > 0) toast.warning(notes.join(" · "));
      toast.success(t("sampler_set_imported", { name: set.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sampler_set_import_failed"));
    }
  };

  const handleExportSet = () => {
    if (!selected) return;
    const payloadJson = JSON.stringify(selected.payload, null, 2);
    const blob = new Blob([payloadJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.name.replace(/[/\\:*?"<>|]/g, "_")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const morphName = morph?.value.trim() ?? "";
  const morphSelfId = morph?.intent === "rename" ? selected?.id : null;
  const morphClientConflict =
    morphName.length > 0 &&
    sets.some((s) => s.id !== morphSelfId && s.name.trim().toLowerCase() === morphName.toLowerCase());
  const morphShowConflict = morphClientConflict || morphConflict;
  const morphConfirmDisabled = morphName.length === 0 || morphShowConflict;

  return (
    <div className="flex max-md:flex-col max-md:items-stretch max-md:gap-2 md:flex-row md:items-center md:gap-1" data-testid="image-gen-model-set-row">
      {morph ? (
        <div className="flex min-w-0 items-center gap-1">
          <div className="flex min-w-0 flex-col">
            <TextInput
              data-testid="image-gen-set-name-input"
              className={cn("w-[180px]", morphShowConflict && "!border-danger")}
              value={morph.value}
              onChange={(e) => {
                setMorph({ ...morph, value: e.target.value });
                setMorphConflict(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleMorphConfirm();
                if (e.key === "Escape") setMorph(null);
              }}
              placeholder={t("sampler_set_name_placeholder")}
              autoFocus
            />
            {morphShowConflict && (
              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-warning">
                <span className="[&_svg]:h-[10px] [&_svg]:w-[10px]"><Icons.Alert /></span>
                {t("sampler_set_name_exists")}
              </div>
            )}
          </div>
          <CustomTooltip content={t("confirm")}>
            <button
              type="button"
              data-testid="image-gen-set-morph-confirm"
              disabled={morphConfirmDisabled}
              onClick={(e) => {
                e.stopPropagation();
                void handleMorphConfirm();
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-accent-t transition-colors hover:bg-[var(--border)] disabled:pointer-events-none disabled:opacity-40"
              aria-label={t("confirm")}
            >
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Check /></span>
            </button>
          </CustomTooltip>
          <CustomTooltip content={t("cancel")}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMorph(null);
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
              aria-label={t("cancel")}
            >
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Close /></span>
            </button>
          </CustomTooltip>
        </div>
      ) : (
        <div className="flex min-w-0 items-center">
          <DropdownSelect
            value={imageGen.modelOverlaySetId ?? ""}
            options={sets.map((s) => ({ id: s.id, label: s.name }))}
            defaultOption={t("sampler_set_none")}
            placeholder={t("sampler_set_placeholder")}
            onChange={handleSelectSet}
            triggerClassName="h-7 w-auto max-w-[200px] rounded border border-border bg-s2 px-2 py-0 text-[12px] hover:border-accent"
            triggerDetail={false}
            contentWidth={260}
            triggerLeading={
              isDirty ? (
                <span data-testid="image-gen-set-dirty-dot" className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
              ) : undefined
            }
            triggerTestId="image-gen-model-set-trigger"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <CustomTooltip content={t("sampler_set_new")}>
          <button
            type="button"
            data-testid="image-gen-set-new"
            onClick={(e) => {
              e.stopPropagation();
              setMorph({ intent: "new", value: "" });
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
            aria-label={t("sampler_set_new")}
          >
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Plus /></span>
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("sampler_set_save")}>
          <button
            type="button"
            data-testid="image-gen-set-save"
            disabled={!selected}
            onClick={(e) => {
              e.stopPropagation();
              void handleSaveIntoSet();
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("sampler_set_save")}
          >
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Floppy /></span>
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("sampler_set_rename")}>
          <button
            type="button"
            data-testid="image-gen-set-rename"
            disabled={!selected}
            onClick={(e) => {
              e.stopPropagation();
              setMorph({ intent: "rename", value: selected?.name ?? "" });
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("sampler_set_rename")}
          >
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Edit /></span>
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("sampler_set_revert")}>
          <button
            type="button"
            data-testid="image-gen-set-revert"
            disabled={!selected}
            onClick={(e) => {
              e.stopPropagation();
              if (selected) applySet(selected);
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("sampler_set_revert")}
          >
            <span className="[&_svg]:h-[11px] [&_svg]:w-[11px]"><Icons.Regen /></span>
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("sampler_set_delete")}>
          <button
            type="button"
            data-testid="image-gen-set-delete"
            disabled={!selected}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDeleteId(selected?.id ?? null);
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-danger disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("sampler_set_delete")}
          >
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Trash /></span>
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("sampler_set_import")}>
          <button
            type="button"
            data-testid="image-gen-set-import"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
            aria-label={t("sampler_set_import")}
          >
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Import /></span>
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("sampler_set_export")}>
          <button
            type="button"
            data-testid="image-gen-set-export"
            disabled={!selected}
            onClick={(e) => {
              e.stopPropagation();
              handleExportSet();
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("sampler_set_export")}
          >
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Download /></span>
          </button>
        </CustomTooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleImportFile(file);
          }}
        />
      </div>
      {confirmDeleteId !== null && (
        <DestructiveConfirmModal
          title={t("sampler_set_delete")}
          body={t("sampler_set_delete_confirm", { name: selected?.name ?? "" })}
          confirmLabel={t("delete")}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

// ─── The pane ────────────────────────────────────────────────────────────────

export function ImageGenPane({ imageGen }: { imageGen: ImageGenHook }) {
  const { t } = useT();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // IG-CF14: the sizes table starts collapsed (owner: the whole grid under
  // an accordion — six rows of steppers is reference material, not the
  // first thing you see when the pane opens).
  const [sizesOpen, setSizesOpen] = useState(false);

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

  // ADetailer availability (IG-CF15 15d / PG-4 v1): A1111-dialect servers
  // report their extensions; the pane row (and the chip's nested accordion
  // on its own fetch) renders only when the server has the extension.
  // Guard-style null-safe values — this hook sits above the null guard too.
  const guardIsA1111 = form?.backend === IMAGE_GEN_BACKENDS.A1111;
  const [hasAdetailer, setHasAdetailer] = useState(false);
  useEffect(() => {
    if (!guardIsA1111 || guardProfileId === null) {
      setHasAdetailer(false);
      return;
    }
    let cancelled = false;
    setHasAdetailer(false);
    void listImageGenExtensions(guardProfileId)
      .then((names) => {
        if (!cancelled) setHasAdetailer(names !== null && hasAdetailerExtension(names));
      })
      .catch(() => {
        if (!cancelled) setHasAdetailer(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guardIsA1111, guardProfileId]);

  if (form === null || form.id === null) return null;
  const profileId = form.id;
  const models: ImageGenModelEntry[] = imageGen.modelsByProfile[profileId] ?? [];
  const samplers = imageGen.samplersByProfile[profileId] ?? [];
  // IG-CF12a: the A1111-family pane is a LOCAL control surface — the shared
  // status chip rides above the picker, driven by the sampler fetch signal
  // (`samplerStatusByProfile`), and an offline server greys out the whole
  // control panel below the chip (owner ruling 2026-09-16: an unresponsive
  // server greys out the whole control panel). The chip's re-check button
  // is the recovery affordance — it stays interactive while the panel is
  // greyed. Cloud backends (openrouter/openai-images) render no chip.
  const isLocalBackend = form.backend === IMAGE_GEN_BACKENDS.A1111;
  const localStatus: LocalConnectionStatus = imageGen.samplerStatusByProfile[profileId] ?? "unknown";
  const localOffline = isLocalBackend && localStatus === "offline";
  const caps = form.capabilities;
  // IG-CF5: slider ranges resolve backend-first from the capability mirror
  // (paramRanges is a declared schema field — it survives the zod boundary),
  // global IMAGE_GEN_PARAM_RANGES defaults otherwise. Empty/absent today.
  const paramRanges = caps.paramRanges;
  const stepsRange = paramRanges?.steps ?? IMAGE_GEN_PARAM_RANGES.steps;
  const cfgRange = paramRanges?.cfgScale ?? IMAGE_GEN_PARAM_RANGES.cfgScale;
  const clipSkipRange = paramRanges?.clipSkip ?? IMAGE_GEN_PARAM_RANGES.clipSkip;
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

  return (
    <div data-testid="image-gen-pane" className="mt-1 flex flex-col gap-4">
      {isLocalBackend && (
        <LocalConnectionStatusChip
          testId="image-gen-local-status"
          status={localStatus}
          endpoint={form.endpoint}
          onRefresh={() => void imageGen.fetchSamplers(profileId)}
          refreshing={localStatus === "checking"}
          refreshLabel={t("test_connection")}
        />
      )}
      {/* The control panel (IG-CF12a): a real <fieldset> so `disabled`
          natively kills EVERY interactive descendant — native buttons
          (dropdown triggers, refresh, stars) AND inputs — for mouse AND
          keyboard, with no per-control prop threading. `m-0 border-0 p-0`
          pins the preflight reset so the fieldset adds no chrome. */}
      <fieldset
        disabled={localOffline}
        aria-disabled={localOffline}
        data-testid="image-gen-pane-controls"
        className={cn("m-0 flex min-w-0 flex-col gap-4 border-0 p-0", localOffline && "pointer-events-none opacity-50")}
      >
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
        onToggleFavorite={(model) =>
          void (favoriteIds.has(model.id) ? imageGen.unstarModel(model.id) : imageGen.starModel(model.id, model.label))
        }
        onRefresh={() => void imageGen.fetchSavedModels(profileId)}
      />

      {/* ── Sizes per mode (profile base or the bound model's override),
          IG-CF14: collapsed accordion + compact table rows. The old grid
          was a table wearing field-clothes — 12 full-height labeled
          fields, width/height labels repeated 6x (owner ruling
          2026-09-16: unacceptable, redo). Now: one slim row per mode — mode
          label, W/H steppers walking the ±128px ladder (domain
          IMAGE_SIZE_STEP_PX; owner example 720 → 848↑ / 592↓; raw typing
          never snaps), a W↔H swap button, and the preset dropdown
          (the "Portrait 3:4 · 896×1152" entry — purpose + ratio + resolution, never a
          bare ratio). UNSET rows display the domain default as the anchor
          without storing anything — "Auto" in the dropdown is the honest
          state until the user edits, steps, swaps, or picks. Vendor-set
          backends keep their capability-grid dropdown (the vendor list IS
          the size vocabulary there). */}
      <section
        className="overflow-hidden rounded-lg border border-border bg-surface"
        data-testid="image-gen-sizes-section"
      >
        <button
          type="button"
          data-testid="image-gen-sizes-header"
          onClick={() => setSizesOpen((prev) => !prev)}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 bg-s2 px-3.5 py-3 font-ui text-[14px] font-semibold text-t1 transition-colors hover:bg-[var(--border)]",
            sizesOpen && "!rounded-b-none",
          )}
        >
          <span className={cn("transition-transform", sizesOpen && "rotate-90")}>
            <Icons.Caret direction="r" />
          </span>
          {t("image_gen_sizes_section_title")}
        </button>
        {sizesOpen && (
          <div className="flex flex-col gap-2.5 p-3.5" data-testid="image-gen-sizes-body">
          {MODES.map((mode) => {
            const preset = sizes[mode as keyof typeof sizes];
            const displayWidth = preset?.width ?? IMAGE_SIZE_DEFAULT.width;
            const displayHeight = preset?.height ?? IMAGE_SIZE_DEFAULT.height;
            const presetKey =
              preset?.width !== undefined && preset?.height !== undefined
                ? `${preset.width}x${preset.height}`
                : "";
            // Editing EITHER cell of an unset/legacy-partial row pins the
            // pair: the untouched side commits its displayed anchor — a
            // stored preset is always a complete W/H pair (or absent).
            const editWidth = (width: number) =>
              setModeSize(mode, { width, height: preset?.height ?? displayHeight });
            const editHeight = (height: number) =>
              setModeSize(mode, { width: preset?.width ?? displayWidth, height });
            return (
              <div key={mode} className="flex flex-wrap items-center gap-2" data-testid={`image-gen-mode-row-${mode}`}>
                <div className="w-[180px] shrink-0 font-ui text-[13px] text-t2">{t(MODE_LABEL_KEYS[mode])}</div>
                {caps.sizeSupport.kind === "vendor-set" ? (
                  <DropdownSelect
                    value={presetKey}
                    triggerTestId={`image-gen-mode-size-${mode}`}
                    searchable={false}
                    className="w-auto max-w-[260px]"
                    defaultOption={t("image_gen_size_auto")}
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
                  <>
                    <div className="w-[110px] shrink-0" data-testid={`image-gen-mode-width-${mode}`}>
                      <NumberInput
                        value={displayWidth}
                        min={IMAGE_SIZE_MIN_PX}
                        max={IMAGE_SIZE_MAX_PX}
                        step={IMAGE_SIZE_STEP_PX}
                        onChange={editWidth}
                      />
                    </div>
                    <span className="select-none font-ui text-[13px] text-t3" aria-hidden="true">×</span>
                    <div className="w-[110px] shrink-0" data-testid={`image-gen-mode-height-${mode}`}>
                      <NumberInput
                        value={displayHeight}
                        min={IMAGE_SIZE_MIN_PX}
                        max={IMAGE_SIZE_MAX_PX}
                        step={IMAGE_SIZE_STEP_PX}
                        onChange={editHeight}
                      />
                    </div>
                    <button
                      type="button"
                      data-testid={`image-gen-mode-swap-${mode}`}
                      title={t("image_gen_size_swap")}
                      aria-label={t("image_gen_size_swap")}
                      onClick={() =>
                        // Swaps the DISPLAYED pair and pins it (a swap is an
                        // explicit act — on an unset row it pins the anchor
                        // swapped, leaving Auto behind).
                        setModeSize(mode, { width: displayHeight, height: displayWidth })
                      }
                      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-s3 text-t2 transition-all hover:bg-s2 hover:text-t1"
                    >
                      <Icons.swap />
                    </button>
                    <DropdownSelect
                      value={presetKey}
                      triggerTestId={`image-gen-mode-preset-${mode}`}
                      searchable={false}
                      className="w-auto max-w-[240px]"
                      defaultOption={t("image_gen_size_auto")}
                      options={[
                        { id: "", label: t("image_gen_size_auto") },
                        ...IMAGE_SIZE_PRESETS.map((p) => ({
                          id: `${p.width}x${p.height}`,
                          label: t(PRESET_LABEL_KEYS[p.orientation], {
                            ratio: p.ratio,
                            size: `${p.width}×${p.height}`,
                          }),
                        })),
                        // A stored custom/legacy pair outside the table gets
                        // its own entry so the trigger shows the truth with
                        // the typographic × (the bare-value fallback would
                        // render the raw key).
                        ...(presetKey !== "" &&
                        !IMAGE_SIZE_PRESETS.some((p) => `${p.width}x${p.height}` === presetKey)
                          ? [{ id: presetKey, label: presetKey.replace("x", "×") }]
                          : []),
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
                  </>
                )}
              </div>
            );
          })}
          </div>
        )}
      </section>

      {/* ── Parameters: bind toggle + sampler + advanced expand ── */}
      <section className="rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-params-section">
        <div className="mb-3 font-ui text-[14px] font-semibold text-t1">{t("image_gen_params_section_title")}</div>

        {form.modelId !== null && (
          <div className="mb-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
            <div className="flex items-center gap-3">
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

        {/* Advanced expand — header cloned from the LLM sampler accordion
            (ProviderSamplerPanel): the title span toggles; the named-set row
            lives on the header's right side and columnates under the title
            on mobile (max-md). */}
        <div className="mt-2 overflow-hidden rounded-lg border border-border2">
          <div
            data-testid="image-gen-advanced-header"
            className={cn(
              "flex w-full flex-col bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer max-md:items-stretch max-md:gap-2 md:flex-row md:items-center md:justify-between",
              advancedOpen && "!rounded-b-none",
            )}
          >
            <span
              className="flex items-center gap-2"
              onClick={() => setAdvancedOpen((prev) => !prev)}
            >
              <span className={cn("transition-transform", advancedOpen && "rotate-90")}>
                <Icons.Caret direction="r" />
              </span>
              {t("image_gen_advanced")}
            </span>
            {bound && form.modelId !== null && <ModelSamplerSetRow imageGen={imageGen} />}
          </div>
          {advancedOpen && (
            <div className="grid grid-cols-1 gap-3 bg-surface p-3 sm:grid-cols-2" data-testid="image-gen-advanced-body">
              <SamplerSliderField
                label={t("image_gen_steps_label")}
                value={params.steps}
                onChange={(steps) => setParam({ steps })}
                range={stepsRange}
                rangeTestId="image-gen-range-steps"
                cellTestId="image-gen-field-steps"
              />
              <SamplerSliderField
                label={t("image_gen_cfg_label")}
                value={params.cfgScale}
                onChange={(cfgScale) => setParam({ cfgScale })}
                range={cfgRange}
                rangeTestId="image-gen-range-cfg"
                cellTestId="image-gen-field-cfg"
              />
              <OptionalNumberField
                value={params.seed}
                onChange={(seed) => setParam({ seed })}
                label={t("image_gen_seed_label")}
                testId="image-gen-field-seed"
              />
              <SamplerSliderField
                label={t("image_gen_clip_skip_label")}
                value={params.clipSkip}
                onChange={(clipSkip) => setParam({ clipSkip })}
                range={clipSkipRange}
                rangeTestId="image-gen-range-clip-skip"
                cellTestId="image-gen-field-clip-skip"
              />
              {/* ADetailer (IG-CF15 15d / PG-4 v1): the pane's twin of the
                  chip's nested accordion — same overlay fields, extensions-
                  gated; one source of truth, two surfaces. Overlay-only (the
                  profile base carries no face-fix flag in v1). */}
              {bound && hasAdetailer && (
                <div
                  className="col-span-full flex flex-col gap-2 rounded-md border border-border bg-s2/50 p-2.5"
                  data-testid="image-gen-adetailer-row"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">
                      {t("image_gen_adetailer")}
                    </span>
                    <Toggle
                      checked={overlay?.adetailer === true}
                      onChange={(checked) => imageGen.setModelOverlay({ adetailer: checked })}
                      aria-label={t("image_gen_adetailer")}
                    />
                  </div>
                  {overlay?.adetailer === true && (
                    <div className="flex flex-col gap-1.5">
                      <span className={cn(lblCls, "!mb-0 font-ui text-t2")}>{t("image_gen_adetailer_model")}</span>
                      <DropdownSelect
                        value={overlay?.adetailerModel ?? IMAGE_GEN_ADETAILER_DEFAULT_MODEL}
                        options={IMAGE_GEN_ADETAILER_FACE_MODELS.map((m) => ({ id: m, label: m }))}
                        onChange={(id) => imageGen.setModelOverlay({ adetailerModel: id })}
                        triggerTestId="image-gen-adetailer-model"
                      />
                    </div>
                  )}
                </div>
              )}
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
      </fieldset>
    </div>
  );
}
