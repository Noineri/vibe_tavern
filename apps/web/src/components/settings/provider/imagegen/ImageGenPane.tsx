import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { toast } from "sonner";
import { useT, type TFunc } from "../../../../i18n/context.js";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GEN_PARAM_RANGES, IMAGE_GENERATION_MODES, IMAGE_GEN_STOCK_SAMPLER_SET_IDS, IMAGE_GEN_WORKFLOW_FAMILY_IDS, IMAGE_SIZE_DEFAULT, IMAGE_SIZE_MAX_PX, IMAGE_SIZE_MIN_PX, IMAGE_SIZE_PRESETS, IMAGE_SIZE_STEP_PX, adaptSamplerSetPayloadToTarget, type ImageGenerationMode, type ImageGenParamRange, type ImageSizeOrientation, type SetFieldNote } from "@vibe-tavern/domain";
import { Icons } from "../../../shared/icons.js";
import { CustomTooltip, TooltipProvider } from "../../../shared/Tooltip.js";
import { cn } from "../../../../lib/cn.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { templateDisplayLabel } from "../../../../lib/imagegen/template-labels.js";
import { formatListingSnapshotTime } from "../../../../lib/imagegen/listing-snapshot.js";
import { buildAdetailerControl, buildDitSidecarControls, buildHiresControl, buildKreaTwoControls, buildSamplerControl, buildScalarSliders, buildSchedulerControl, buildSeedField, isLocalDialectBackend, translateModelOptions } from "../../../../lib/imagegen/model-controls.js";
import { TextInput } from "../../../shared/text-input.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { SliderField } from "../../../shared/SliderField.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { Toggle } from "../../../shared/Toggle.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { getModalPortal } from "../../../shared/modal-helpers.js";
import { LocalConnectionStatusChip, type LocalConnectionStatus } from "../../../shared/LocalConnectionStatus.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import type {
  ImageGenFamilyDetectionAttemptValue,
  ImageGenFamilyDetectionSourceValue,
  ImageGenSamplerSet,
  ImageGenBackendValue,
  ImageGenDefaultParamsValue,
  ImageGenModelSettingsOverlayValue,
  ImagePromptFamilyInfoValue,
  ImagePromptFamilyValue,
} from "@vibe-tavern/api-contracts";
import type { ImageGenModelEntry, ImageGenUpscaler } from "../../../../api/image-gen-api.js";
import {
  createImageGenSamplerSet,
  deleteImageGenSamplerSet,
  detectImageGenProfileFamily,
  importImageGenSamplerSet,
  listImageGenExtensions,
  listImageGenFaceDetectors,
  listImageGenSamplerSets,
  listImageGenUpscalers,
  listImagePromptFamilies,
  setImageGenProfileFamily,
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
  /** Model-family label (comfyui dialect, CG-A3): rendered as a chip in
   *  the row; absent = unknown family. */
  family?: string;
  /** Workflow template marker (comfyui dialect, CG-A2/A3): drives the
   *  «Detected» readout under the trigger and the DiT sidecar fields. */
  template?: string;
}

/** Krea-2 starting-point values (CG-B1, form-side per CF5 — the backend
 *  keeps ONE materialization ladder of node-class defaults for both
 *  templates; these are the values the FORM offers as explicit starting
 *  values when a DiT model is picked on an untouched param base). */
const KREA2_FORM_DEFAULTS = { steps: 8, cfgScale: 1, sampler: "euler", scheduler: "simple" } as const;

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
  [IMAGE_GENERATION_MODES.Selfie]: "image_gen_mode_selfie",
  [IMAGE_GENERATION_MODES.Avatar]: "image_gen_mode_avatar",
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
  snapshotAt,
}: {
  value: string | null;
  onChange: (modelId: string) => void;
  models: ModelOption[];
  fetching: boolean;
  favoriteIds: Set<string>;
  onToggleFavorite: (model: ModelOption) => void;
  onRefresh: () => void;
  /** IF-20: the list came from the server's last-good snapshot (ISO time). */
  snapshotAt: string | null;
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
          {model.family && (
            <span
              data-testid="image-gen-model-family"
              className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-t4"
            >
              {model.family}
            </span>
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
      <div className="min-w-0 flex-1">
        <label className="mb-[6px] block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3">
          {t("selected_model_label")}
        </label>
        {/* The refresh button rides the DROPDOWN's row (not a sibling of the
            whole field column): the custom/detected hints render below the
            row, so their appearance can no longer drop the button to a
            different height (owner 2026-09-22; same fix in the LLM/STT/TTS
            model pickers). */}
        <div className="flex items-end gap-3">
          <div className="relative min-w-0 flex-1">
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
        {!selectedModel && value && (
          <div className="mt-2 font-ui text-[12px] font-medium text-accent">{t("custom_model", { name: value })}</div>
        )}
        {/* «Detected: …» readout (CG-B1, the Matrix idiom): which
            workflow template the adapter auto-detects for the picked
            model — loader-folder membership, the adapter's ground
            truth. A selected model without a template marker (cloud
            dialects, custom slugs) renders nothing. */}
        {selectedModel?.template && (
          <div
            data-testid="image-gen-model-detected"
            className="mt-2 font-ui text-[12px] font-medium text-accent"
          >
            {t("image_gen_detected_template", {
              template: templateDisplayLabel(selectedModel.template, t),
            })}
          </div>
        )}
        {/* IF-20: an honest «saved list» line — the live fetch failed and
            the server answered from its last-good snapshot; «refresh»
            re-fetches live. */}
        {snapshotAt !== null && (
          <div
            data-testid="image-gen-models-snapshot"
            className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t4"
          >
            {t("image_gen_models_snapshot", { time: formatListingSnapshotTime(snapshotAt) })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Image prompt family (IPT-5 — the profile's checkpoint-family row,
//     always visible in the params block directly under the model setting) ──

/** Registry family label/detail keys — the IPT-4 pane's family dropdown
 *  keys reused verbatim (one home for the display names). */
function familyLabelKey(family: ImagePromptFamilyValue): string {
  return `imagePromptTemplates.family.${family}`;
}

function familyDetailKey(family: ImagePromptFamilyValue): string {
  return `imagePromptTemplates.familyDetail.${family}`;
}

/** i18n key per ordered detection-ladder source — the success sourceLabel
 *  and the tried[] failure reasons share this vocabulary. */
const FAMILY_SOURCE_LABEL_KEYS: Record<ImageGenFamilyDetectionSourceValue, Parameters<TFunc>[0]> = {
  "backend-metadata": "image_gen_family_source_backend-metadata",
  sidecar: "image_gen_family_source_sidecar",
  "civitai-by-hash": "image_gen_family_source_civitai-by-hash",
  "extension-preset": "image_gen_family_source_extension-preset",
};

/** The current detect response's authoritative source, kept only while the
 *  record still carries that exact detection (family + model anchor). After
 *  a reload the profile DTO proves no source and none is fabricated (IPT-5
 *  supervisor ruling — the response's sourceLabel is authoritative for that
 *  response alone). */
interface FamilyDetectSession {
  profileId: string;
  model: string;
  family: ImagePromptFamilyValue;
  sourceLabel: ImageGenFamilyDetectionSourceValue;
}

interface FamilyRequestIdentity {
  profileId: string | null;
  model: string | null;
  persistedModel: string | null;
}

function sameFamilyRequestIdentity(a: FamilyRequestIdentity, b: FamilyRequestIdentity): boolean {
  return a.profileId === b.profileId && a.model === b.model && a.persistedModel === b.persistedModel;
}

function ImagePromptFamilyRow({ imageGen }: { imageGen: ImageGenHook }) {
  const { t, tDynamic } = useT();
  const [families, setFamilies] = useState<ImagePromptFamilyInfoValue[] | null>(null);
  const [familiesFailed, setFamiliesFailed] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [writeFailure, setWriteFailure] = useState<{ profileId: string; message: string } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectSession, setDetectSession] = useState<FamilyDetectSession | null>(null);
  const [detectFailure, setDetectFailure] = useState<{
    profileId: string;
    error: string;
    tried: ImageGenFamilyDetectionAttemptValue[];
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Every family write/detect claims a new operation token. Identity checks
  // still bind a detection to its profile and model, while this token also
  // rejects an A → B → A continuation whose value identity happens to match
  // again after the intervening target change.
  const familyOperationRef = useRef(0);

  const form = imageGen.form;
  const profileId = form?.id ?? null;
  // Server truth for the family state: the RECORD list, never the form —
  // family writes ride the dedicated family route only (the Wave-2
  // contract), so the form carries no family fields to read.
  const record = profileId !== null ? (imageGen.profiles.find((p) => p.id === profileId) ?? null) : null;

  const modelShown = form?.modelId ?? null;
  const persistedModel = record?.modelId ?? null;
  // Identity guard (the editor operation pattern): async continuations
  // compare against the live profile AND model identity. The request names
  // the DISPLAYED model explicitly (IF-8a), so the guard's job is binding
  // the response to that exact model — a response for model A must never
  // surface after the pane starts showing model B.
  const identityRef = useRef<FamilyRequestIdentity>({ profileId: null, model: null, persistedModel: null });
  // Commit-phase invalidation makes the operation token reflect only targets
  // that reached the screen. A synchronous committed A → B → A move still
  // advances it twice, while an abandoned render cannot strand an operation.
  useLayoutEffect(() => {
    const committedIdentity: FamilyRequestIdentity = { profileId, model: modelShown, persistedModel };
    if (!sameFamilyRequestIdentity(identityRef.current, committedIdentity)) {
      familyOperationRef.current += 1;
      identityRef.current = committedIdentity;
    }
  }, [profileId, modelShown, persistedModel]);

  const isCurrentFamilyOperation = (operation: number, identity: FamilyRequestIdentity): boolean =>
    familyOperationRef.current === operation && sameFamilyRequestIdentity(identityRef.current, identity);

  // Registry list: one fetch per mount (the ModelSamplerSetRow load rule —
  // static server data, no per-profile scoping).
  useEffect(() => {
    let cancelled = false;
    listImagePromptFamilies()
      .then((response) => {
        if (!cancelled) setFamilies(response.families);
      })
      .catch(() => {
        if (!cancelled) setFamiliesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A profile or displayed-model move resets the session-scoped detect UI and
  // aborts an in-flight ladder run. Its response belongs to the prior target.
  useEffect(() => {
    setDetectSession(null);
    setDetectFailure(null);
    setWriteFailure(null);
    setDetecting(false);
    setPinning(false);
    abortRef.current?.abort();
    return () => {
      abortRef.current?.abort();
    };
  }, [profileId, modelShown, persistedModel]);

  // IF-8a (owner correction 2026-09-25): the ladder inspects the DISPLAYED
  // model — the request names it explicitly, so a freshly picked unsaved
  // model is detectable on the spot. The only remaining block is "nothing
  // picked at all" (no model to inspect); no save-first gate exists anymore.
  const detectBlocked = modelShown === null;
  const pin = record?.familyOverride ?? null;
  const detected = record?.familyDetected ?? null;
  const detectedForModel = record?.familyDetectedForModel ?? null;
  // Freshness is model-anchored: only the exact model shown renders a
  // detection as current; a manual pin is authoritative and never stale.
  const detectedFresh = detected !== null && modelShown !== null && detectedForModel === modelShown;
  const sessionSource =
    pin === null &&
    detectSession !== null &&
    detectedFresh &&
    detectSession.profileId === profileId &&
    detectSession.family === detected &&
    detectSession.model === modelShown &&
    detectSession.model === detectedForModel
      ? detectSession.sourceLabel
      : null;

  if (record === null) return null;

  const handleSelectFamily = async (next: string) => {
    if (profileId === null || pinning || detecting) return;
    // "" is the explicit automatic (unpinned) choice; a re-select of the
    // current state is a no-op skip, not a redundant write.
    const chosen = families?.find((family) => family.id === next) ?? null;
    if ((chosen?.id ?? null) === (record.familyOverride ?? null)) return;
    const requestIdentity: FamilyRequestIdentity = { profileId, model: modelShown, persistedModel };
    const operation = ++familyOperationRef.current;
    setPinning(true);
    setWriteFailure(null);
    try {
      await setImageGenProfileFamily(profileId, chosen?.id ?? null);
      if (!isCurrentFamilyOperation(operation, requestIdentity)) return;
      // Persist first, then refresh the list (the activateProfile rule) —
      // the record's family fields stay the rendering truth.
      await imageGen.reload();
    } catch (cause) {
      if (isCurrentFamilyOperation(operation, requestIdentity)) {
        setWriteFailure({ profileId, message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      if (isCurrentFamilyOperation(operation, requestIdentity)) setPinning(false);
    }
  };

  /** IF-7b auto-preselect: the DETECTED family's stock set rides the
   *  CURRENT arm — but ONLY when that arm carries no set pointer (the D20
   * rule: an explicit user pick always survives; preselect never
   * overwrites). Best-effort options data: a failed list call or a deleted
   * stock row leaves the arm untouched. */
  const preselectStockSamplerSet = async (family: string, model: string, baseModel?: string) => {
    const stockId = stockSamplerSetIdForFamily(
      family,
      `${model}${baseModel !== undefined ? ` ${baseModel}` : ""}`,
    );
    if (stockId === null) return;
    const boundArm = imageGen.modelOverlay !== null;
    const pointed = boundArm
      ? imageGen.modelOverlaySetId
      : (imageGen.form?.defaultParamsSetId ?? null);
    if (pointed !== null) return;
    try {
      const stock = (await listImageGenSamplerSets()).find((set) => set.id === stockId) ?? null;
      if (stock === null) return; // the user deleted the stock row — deletes stick
      // IF-7c: the stock row's names are authored in ITS family's dialect —
      // adapt to the CURRENT target's live lists before applying (a Diffusion
      // row applied on Comfy translates «Euler a» → euler_ancestral and
      // warns; a missing name skips the field + warns — never silent).
      const { payload, notes } = await adaptSetPayloadForTarget(imageGen, stock.payload);
      if (boundArm) imageGen.setModelSamplerSetBinding(stock.id, payload);
      else imageGen.applyBaseSamplerSet(stock.id, payload);
      const lines = composeSetFieldNotes(notes, t);
      if (lines.length > 0) toast.warning(lines.join(" · "));
    } catch {
      // The fetchSidecars rule: options data never draws connectivity
      // conclusions — the detection result above stays the truth.
      return;
    }
  };

  const handleDetect = async () => {
    if (profileId === null || modelShown === null || pinning || detecting || detectBlocked) return;
    const requestIdentity: FamilyRequestIdentity = { profileId, model: modelShown, persistedModel };
    const operation = ++familyOperationRef.current;
    setDetecting(true);
    setDetectFailure(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // The DISPLAYED model rides the request — detection answers for the
      // model the user is looking at, saved or not (IF-8a). The identity
      // guard below still binds the response to that exact model.
      const result = await detectImageGenProfileFamily(profileId, controller.signal, modelShown);
      if (!isCurrentFamilyOperation(operation, requestIdentity)) return;
      if (result.ok) {
        // The server persisted familyDetected + its exact model anchor on
        // success. Refresh first so the record remains rendering truth, then
        // retain the exact response source only for this matching session.
        await imageGen.reload();
        if (!isCurrentFamilyOperation(operation, requestIdentity)) return;
        setDetectSession({
          profileId,
          model: modelShown,
          family: result.family,
          sourceLabel: result.sourceLabel,
        });
        // IF-7b: the detected family's stock set preselects onto the current
        // arm (pointer-less arms only — the D20 rule).
        void preselectStockSamplerSet(result.family, modelShown, result.baseModel);
      } else {
        // Honest no-answer: the server persisted nothing, so the saved state
        // stays untouched — the error and EVERY ordered tried[] reason
        // render inline (no toast-only failure, no swallowed detail).
        setDetectFailure({ profileId, error: result.error, tried: result.tried });
      }
    } catch (cause) {
      if (isCurrentFamilyOperation(operation, requestIdentity)) {
        setDetectFailure({ profileId, error: cause instanceof Error ? cause.message : String(cause), tried: [] });
      }
    } finally {
      if (isCurrentFamilyOperation(operation, requestIdentity)) setDetecting(false);
    }
  };

  return (
    <div className="my-4" data-testid="image-gen-family-row">
      <div className="mb-3 border-b border-border2 pb-2 font-ui text-[calc(var(--ui-fs))] font-semibold text-t1">
        {t("image_gen_family_title")}
      </div>
      {/* items-end pairs the two controls by their BOTTOM edge; the button
          adopts the dropdown's field height (2px borders + 2×6px py + 13px
          line box = 33.5px — the refresh-button row-pairing canon,
          MOBILE_UI_DEFECTS step 5) instead of the compact h-7 — a shorter
          sibling in a field row is the IF-8a height mismatch (owner report
          2026-09-22). */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label className={lblCls}>{t("image_gen_family_label")}</label>
          <DropdownSelect
            value={pin ?? ""}
            options={[
              { id: "", label: t("image_gen_family_automatic") },
              ...(families ?? []).map((family) => ({
                id: family.id,
                label: tDynamic(familyLabelKey(family.id)),
                detail: tDynamic(familyDetailKey(family.id)),
              })),
              // A stored pin outside the live registry keeps its own option
              // so the trigger shows the truth (the STT/LLM selector rule).
              ...(pin !== null && !(families ?? []).some((family) => family.id === pin)
                ? [{ id: pin, label: pin }]
                : []),
            ]}
            defaultOption={t("image_gen_family_automatic")}
            searchable={false}
            disabled={pinning || detecting}
            onChange={(next) => void handleSelectFamily(next)}
            triggerTestId="image-gen-family-select"
            triggerDetail={false}
          />
        </div>
        {!detectBlocked ? (
          <button
            type="button"
            data-testid="image-gen-family-detect"
            onClick={() => void handleDetect()}
            disabled={pinning || detecting}
            className="flex min-h-[33.5px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-[6px] font-ui text-[13px] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-50"
          >
            {detecting ? (
              <span className="ml-[3px] inline-flex items-center gap-[3px] align-middle">
                <span className="h-1 w-1 animate-genp rounded-full bg-accent" />
                <span className="h-1 w-1 animate-genp rounded-full bg-accent [animation-delay:0.18s]" />
                <span className="h-1 w-1 animate-genp rounded-full bg-accent [animation-delay:0.36s]" />
            </span>
            ) : (
              <Icons.brain />
            )}
            {t("image_gen_family_detect")}
          </button>
        ) : (
          <TooltipProvider delayDuration={200}>
            <CustomTooltip content={t("image_gen_family_detect_pick_model_first")}>
              <span
                data-testid="image-gen-family-detect-disabled"
                className="flex min-h-[33.5px] shrink-0 cursor-help items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-[6px] font-ui text-[13px] font-medium text-t4"
              >
                <Icons.brain />
                {t("image_gen_family_detect")}
              </span>
            </CustomTooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1" data-testid="image-gen-family-status">
        {/* IF-8a: the save-first hint rides the row INLINE — a hover-only
            tooltip is a trap (touch has no hover; the owner read the blocked
            button as "dead on everything"). The hint IS the button's
            visible state explanation while detection is model-save-gated. */}
        {detectBlocked && (
          <span
            data-testid="image-gen-family-detect-blocked-hint"
            className="font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-warning"
          >
            {t("image_gen_family_detect_pick_model_first")}
          </span>
        )}
        {pin !== null ? (
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-t3">
            {t("image_gen_family_manual_note")}
          </span>
        ) : detected !== null ? (
          detectedFresh ? (
            <span
              data-testid="image-gen-family-detected"
              className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium leading-[1.5] text-accent"
            >
              {t("image_gen_family_detected", { family: tDynamic(familyLabelKey(detected)) })}
            </span>
          ) : (
            <span
              data-testid="image-gen-family-stale"
              className="font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-warning"
            >
              {t("image_gen_family_stale", {
                family: tDynamic(familyLabelKey(detected)),
                model: detectedForModel ?? "",
              })}
            </span>
          )
        ) : (
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-t3">
            {t("image_gen_family_not_detected")}
          </span>
        )}
        {sessionSource !== null && (
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-t3">
            {t("image_gen_family_source_note", {
              source: tDynamic(FAMILY_SOURCE_LABEL_KEYS[sessionSource]),
            })}
          </span>
        )}
      </div>
      {detectFailure !== null && detectFailure.profileId === profileId && (
        <div
          data-testid="image-gen-family-error"
          className="mt-2 rounded-md bg-danger/10 px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-danger"
        >
          <div className="break-words">
            {t("image_gen_family_detect_failed")}
            {detectFailure.error !== "" ? `: ${detectFailure.error}` : ""}
          </div>
          {detectFailure.tried.length > 0 && (
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
              {detectFailure.tried.map((attempt, index) => (
                <li key={`${attempt.source}-${index}`} data-testid="image-gen-family-tried-item" className="break-words">
                  {tDynamic(FAMILY_SOURCE_LABEL_KEYS[attempt.source])}: {attempt.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {writeFailure !== null && writeFailure.profileId === profileId && (
        <div
          data-testid="image-gen-family-write-error"
          className="mt-2 rounded-md bg-danger/10 px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-danger"
        >
          <span className="break-words">
            {t("image_gen_family_write_failed")}
            {writeFailure.message !== "" ? `: ${writeFailure.message}` : ""}
          </span>
        </div>
      )}
      {familiesFailed && (
        <div
          data-testid="image-gen-family-registry-error"
          className="mt-2 break-words font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-danger"
        >
          {t("image_gen_family_registry_failed")}
        </div>
      )}
    </div>
  );
}

// ─── Optional numeric field (TextInput inputMode=numeric — the empty-able
//     numeric; no NumberInput because it requires a concrete number) ────────

// ─── Slider+number field (IG-CF13: the ProviderSamplerPanel SamplerField
//     taken VERBATIM per the owner's 2026-09-16 ruling — take the existing
//     LLM implementation, don't reshape it). The CF5 "empty box /
//     clear-to-undefined" optionality was supervisor spec invention, not an
//     owner requirement — killed. The cell is NumberInput (h-[30px] w-[60px]
//     hideControls — its own self-clamping), the label is the uppercase micro
//     canon, and the display value is `value ?? min` exactly like the LLM
//     panel. Untouched params still don't send until edited. Seed keeps the
//     plain OptionalNumberField above (a full seed-range slider is meaningless —
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

/** Structural read of a stored hires block off a loose record (either
 *  arm's params arrive as Record<string, unknown> here) — the setPayloadOf
 *  twin of the zod boundary: wrong-shaped values drop out, never crash. */
function readHiresBlockOf(
  source: Record<string, unknown>,
): ImageGenSamplerSet["payload"]["hires"] {
  const raw = source.hires;
  if (typeof raw !== "object" || raw === null) return undefined;
  const block = raw as Record<string, unknown>;
  if (typeof block.enabled !== "boolean") return undefined;
  const clean: NonNullable<ImageGenSamplerSet["payload"]["hires"]> = { enabled: block.enabled };
  if (typeof block.upscaler === "string" && block.upscaler !== "") clean.upscaler = block.upscaler;
  if (typeof block.steps === "number") clean.steps = block.steps;
  if (typeof block.scale === "number") clean.scale = block.scale;
  if (typeof block.denoisingStrength === "number") clean.denoisingStrength = block.denoisingStrength;
  return clean;
}

/** The set payload projection of an arm's params (IF-7b: beyond the five
 *  LS-5 scalars — scheduler, the swappable-slot VAE, and the hires block
 *  join; modeSizePresets stays the model layer's own surface, IG-CF14). */
function setPayloadOf(overlay: Record<string, unknown>): ImageGenSamplerSet["payload"] {
  const payload: ImageGenSamplerSet["payload"] = {};
  if (typeof overlay.steps === "number") payload.steps = overlay.steps;
  if (typeof overlay.cfgScale === "number") payload.cfgScale = overlay.cfgScale;
  if (typeof overlay.sampler === "string") payload.sampler = overlay.sampler;
  if (typeof overlay.seed === "number") payload.seed = overlay.seed;
  if (typeof overlay.clipSkip === "number") payload.clipSkip = overlay.clipSkip;
  if (typeof overlay.scheduler === "string") payload.scheduler = overlay.scheduler;
  if (typeof overlay.encoderName === "string" && overlay.encoderName !== "") payload.encoderName = overlay.encoderName;
  if (
    typeof overlay.workflowFamily === "string" &&
    (IMAGE_GEN_WORKFLOW_FAMILY_IDS as readonly string[]).includes(overlay.workflowFamily)
  ) {
    payload.workflowFamily = overlay.workflowFamily as ImageGenSamplerSet["payload"]["workflowFamily"];
  }
  // Sampler-set `vae` is the compact wire field for both dialects: A1111
  // restores its swappable VAE directly, while Comfy restores it into the
  // DiT sidecar's `vaeName` (the adapter/request spelling).
  const vae = typeof overlay.vaeName === "string" && overlay.vaeName !== ""
    ? overlay.vaeName
    : typeof overlay.vae === "string" && overlay.vae !== ""
      ? overlay.vae
      : undefined;
  if (vae !== undefined) payload.vae = vae;
  const hires = readHiresBlockOf(overlay);
  if (hires !== undefined) payload.hires = hires;
  return payload;
}

/** Stock-set auto-preselect resolver (IF-7b): the DETECTED family → its
 *  stock set, keyed by the owner's matrix. Krea 2 splits Turbo/RAW by the
 *  variant text (turbo wins when both appear — finetune names like
 *  "Krea2TurboRaw" are Turbo-family). Null = no stock set for the family
 *  (prose/qwen/hybrid). The DIFFUSION class covers the SDXL tag families
 *  + sdxl-realism — diffusion checkpoints all take the generic set. */
function stockSamplerSetIdForFamily(family: string, variantText: string): string | null {
  const variant = variantText.toLowerCase();
  switch (family) {
    case "krea2":
      return variant.includes("turbo")
        ? IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo
        : variant.includes("raw")
          ? IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Raw
          : IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo;
    case "anima":
      return IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima;
    case "pony":
    case "illustrious":
    case "noobai":
    case "sdxl-realism":
      return IMAGE_GEN_STOCK_SAMPLER_SET_IDS.diffusion;
    default:
      return null;
  }
}

/** IF-7c: gather the CURRENT target's live lists and adapt a set payload
 *  for that dialect (alias bridge + live validation). A backend with no
 *  local sampler surface (cloud) applies unchanged; an options-list fetch
 *  that fails returns null and leaves the payload as stored — options data
 *  never draws conclusions (the samplers-guard rule). */
async function adaptSetPayloadForTarget(
  imageGen: ImageGenHook,
  payload: ImageGenSamplerSet["payload"],
): Promise<{ payload: ImageGenSamplerSet["payload"]; notes: SetFieldNote[] }> {
  const form = imageGen.form;
  if (!form?.id) return { payload, notes: [] };
  const dialect =
    form.backend === IMAGE_GEN_BACKENDS.ComfyUI
      ? "comfyui"
      : form.backend === IMAGE_GEN_BACKENDS.A1111
        ? "a1111"
        : null;
  if (dialect === null) return { payload, notes: [] };
  const modelEntry = (imageGen.modelsByProfile[form.id] ?? []).find((m) => m.id === form.modelId) ?? null;
  const ditFamilyFixedVae =
    dialect === "comfyui" &&
    payload.workflowFamily === undefined &&
    modelEntry?.template === "krea2-dit";
  let samplers = imageGen.samplersByProfile[form.id] ?? [];
  if (samplers.length === 0) samplers = (await imageGen.fetchSamplers(form.id)) ?? [];
  let schedulers = imageGen.schedulersByProfile[form.id] ?? [];
  if (schedulers.length === 0) schedulers = (await imageGen.fetchSchedulers(form.id)) ?? [];
  let vaes: string[] = [];
  if (payload.vae !== undefined && !ditFamilyFixedVae) {
    vaes = (await imageGen.fetchVae(form.id)) ?? [];
  }
  return adaptSamplerSetPayloadToTarget(payload, { dialect, ditFamilyFixedVae, samplers, schedulers, vaes });
}

/** Compose the structured adaptation notes into localized hint lines (the
 *  import flow's `toast.warning(notes.join(" · "))` canon — IF-7c rides
 *  the same surface). */
/** Restore the sampler-set VAE carrier onto the target arm's native field.
 * Comfy's DiT templates consume `vaeName`; A1111/checkpoint flows retain the
 * historical swappable `vae` field. */
function samplerSetValuesForTarget(
  payload: ImageGenSamplerSet["payload"],
  backend: ImageGenBackendValue | undefined,
): Partial<ImageGenDefaultParamsValue & ImageGenModelSettingsOverlayValue> {
  if (backend !== IMAGE_GEN_BACKENDS.ComfyUI || payload.vae === undefined) return payload;
  const { vae, ...values } = payload;
  return { ...values, vaeName: vae };
}

function composeSetFieldNotes(
  notes: SetFieldNote[],
  t: ReturnType<typeof useT>["t"],
): string[] {
  return notes.map((note) => {
    switch (note.reason) {
      case "translated":
        return t("sampler_set_note_translated", { stored: note.stored, resolved: note.resolved ?? "" });
      case "missing":
        return note.field === "sampler"
          ? t("sampler_set_note_sampler_missing", { name: note.stored })
          : note.field === "scheduler"
            ? t("sampler_set_note_scheduler_missing", { name: note.stored })
            : t("sampler_set_note_vae_missing", { name: note.stored });
      case "dit-fixed-vae":
        return t("sampler_set_note_vae_dit");
    }
  });
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

  // IF-7a: the row serves BOTH bind states — the sets row is NOT gated by
  // the per-model toggle (owner ruling 2026-09-22: the toggle binds params
  // to favorite MODELS, it never gates the ability to use sets). Bound →
  // writes ride the per-model overlay; unbound → writes ride the profile
  // BASE defaultParams (applyBaseSamplerSet). The payload source, the
  // bound-set id, and every write route branch on `bound`.
  const bound = imageGen.modelOverlay !== null;
  const baseParams = imageGen.form?.defaultParams ?? {};
  const overlay: Record<string, unknown> = bound ? (imageGen.modelOverlay ?? {}) : baseParams;
  const boundSetId = bound
    ? imageGen.modelOverlaySetId
    : (imageGen.form?.defaultParamsSetId ?? null);
  const selected = sets.find((s) => s.id === boundSetId) ?? null;

  // Back-fill the dirty-dot baseline from the pre-selected set once the
  // library arrives (previous-session pre-selection — no re-apply).
  useEffect(() => {
    if (!setsLoaded || boundSetId === null) return;
    if (appliedRef.current?.setId === boundSetId) return;
    const set = sets.find((s) => s.id === boundSetId);
    if (!set) return;
    appliedRef.current = { setId: set.id, baseline: { ...set.payload } };
    bumpApplied();
  });

  const isDirty = Boolean(
    selected &&
      appliedRef.current?.setId === selected.id &&
      JSON.stringify(appliedRef.current.baseline) !== JSON.stringify(setPayloadOf(overlay)),
  );

  const applySet = async (set: ImageGenSamplerSet) => {
    // IF-7c: dialect adaptation before the values ride the arm — names
    // resolve against the target's LIVE lists (alias bridge on vocabulary
    // drift); a missing name skips the field + warns (the import-flow
    // toast canon), never silent garbage.
    const { payload, notes } = await adaptSetPayloadForTarget(imageGen, set.payload);
    const values = samplerSetValuesForTarget(payload, imageGen.form?.backend);
    if (bound) imageGen.setModelSamplerSetBinding(set.id, values);
    else imageGen.applyBaseSamplerSet(set.id, values);
    // The dirty-dot baseline is the ADAPTED payload — the arm now holds the
    // adapted names, and the dot compares the arm against what was applied.
    appliedRef.current = { setId: set.id, baseline: { ...payload } };
    bumpApplied();
    const lines = composeSetFieldNotes(notes, t);
    if (lines.length > 0) toast.warning(lines.join(" · "));
    toast.success(t("sampler_set_applied", { name: set.name }));
  };

  const handleSelectSet = (id: string) => {
    if (id === "") {
      // Explicit "no set": clear the pointer, keep the current values.
      if (bound) imageGen.setModelSamplerSetBinding(null);
      else imageGen.applyBaseSamplerSet(null);
      appliedRef.current = null;
      bumpApplied();
      return;
    }
    const set = sets.find((s) => s.id === id);
    if (set) void applySet(set);
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
        if (bound) imageGen.setModelSamplerSetBinding(created.id, created.payload);
        else imageGen.applyBaseSamplerSet(created.id, created.payload);
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
      // Clear whichever pointer family referenced the deleted set (the
      // server nulls STORED pointers for both; this mirrors the live form).
      if (bound && imageGen.modelOverlaySetId === confirmDeleteId) {
        imageGen.setModelSamplerSetBinding(null);
      }
      if (!bound && imageGen.form?.defaultParamsSetId === confirmDeleteId) {
        imageGen.applyBaseSamplerSet(null);
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
            value={boundSetId ?? ""}
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
  // IG-20a custom-size draft row (vendor-set backends only): W/H steppers
  // walk the same ±128 ladder; the ratio field is OpenRouter-only (its wire
  // takes aspect-ratio strings — pixel grids don't reduce to them).
  const [draftWidth, setDraftWidth] = useState<number>(IMAGE_SIZE_DEFAULT.width);
  const [draftHeight, setDraftHeight] = useState<number>(IMAGE_SIZE_DEFAULT.height);
  const [draftRatio, setDraftRatio] = useState("");

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
  // The LOCAL dialect family: ONE shared derivation (T2, model-controls —
  // isLocalDialectBackend) — the scheduler-list consumer gate; both
  // dialects expose the schedulers route (PG-3/CG-A3).
  const guardIsLocalDialect = form !== null && isLocalDialectBackend(form.backend);
  // Scheduler list (PG-3) — the dialect-gated schedule-type catalog, one-shot
  // cache fill per profile (the samplers-guard twin, dialect-gated: the
  // schedulers route exists only on the local family). Failure = empty
  // options, no connectivity signal (the samplers fetch owns that).
  useEffect(() => {
    if (guardProfileId === null || !guardIsLocalDialect) return;
    if ((imageGen.schedulersByProfile[guardProfileId] ?? []).length === 0) {
      void imageGen.fetchSchedulers(guardProfileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [guardProfileId, guardIsLocalDialect]);
  // DiT sidecar lists (CG-B1, comfyui dialect): one-shot cache fill when
  // the SELECTED model (or the manual base-workflow pick) resolves a DiT
  // workflow family — the encoder/VAE fields need them. Options-data only
  // (the fetchSchedulers rule): a failure = empty options, no connectivity
  // signal. Sits above the null guard like its siblings (hook-order
  // invariant).
  const guardModelId = form?.modelId ?? null;
  const guardModelEntry =
    guardProfileId !== null && guardModelId !== null
      ? ((imageGen.modelsByProfile[guardProfileId] ?? []).find((m) => m.id === guardModelId) ?? null)
      : null;
  // The manual base-workflow pick (IF-12a sets): the active arm's value —
  // the ONE derivation the sliders' CFG gate below reads too.
  const guardWorkflowFamily = imageGen.modelOverlay?.workflowFamily ?? form?.defaultParams.workflowFamily;
  // T3 (TWIN_UNIFICATION step 5): the DiT sidecar gate — ONE derivation
  // (model-controls) serving the fetch guard AND the render block (single
  // function scope); `guardIsDit` is the boolean projection for the
  // effect's stable deps.
  const ditControls = buildDitSidecarControls({
    backend: form?.backend,
    workflowFamily: guardWorkflowFamily,
    modelTemplate: guardModelEntry?.template,
    modelId: guardModelId ?? undefined,
  });
  const guardIsDit = ditControls !== null;
  useEffect(() => {
    if (guardProfileId === null || !guardIsDit) return;
    if (imageGen.sidecarsByProfile[guardProfileId] === undefined) {
      void imageGen.fetchSidecars(guardProfileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [guardProfileId, guardIsDit]);
  // VAE list (IF-7b): the swappable-VAE vocabulary for the advanced
  // accordion's VAE field — one-shot cache fill per LOCAL profile (A1111
  // + ComfyUI; the field renders for every non-DiT local target).
  // Options-data only (the fetchSidecars rule verbatim).
  useEffect(() => {
    if (guardProfileId === null || !guardIsLocalDialect) return;
    if (imageGen.vaeByProfile[guardProfileId] === undefined) {
      void imageGen.fetchVae(guardProfileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot cache
    // fill per profile; imageGen actions are stable callbacks.
  }, [guardProfileId, guardIsLocalDialect]);
  // Hires upscaler vocabulary (IF-7b, the pane's hires section): fetched
  // when a hires-capable profile opens the advanced accordion — the chip's
  // own fetch twin. Options-data only; [] on failure (Auto stays pickable).
  const [paneUpscalers, setPaneUpscalers] = useState<ImageGenUpscaler[] | null>(null);
  const guardSupportsHires =
    form?.backend !== undefined &&
    IMAGE_GEN_BACKEND_CAPABILITIES[form.backend].supportsHiresFix === true;
  useEffect(() => {
    if (guardProfileId === null || !guardSupportsHires) {
      return;
    }
    let cancelled = false;
    void listImageGenUpscalers(guardProfileId)
      .then((list) => {
        if (!cancelled) setPaneUpscalers(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setPaneUpscalers([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot
    // vocabulary fill per profile; listImageGenUpscalers is a stable import.
  }, [guardProfileId, guardSupportsHires]);
  const [extensions, setExtensions] = useState<string[] | null>(null);
  useEffect(() => {
    if (!guardIsA1111 || guardProfileId === null) {
      setExtensions(null);
      return;
    }
    let cancelled = false;
    setExtensions(null);
    // fork #2 of 2 (counterpart: apps/web/src/components/chat/ImageGenFineTuningChip.tsx) — adetailer probe fetch; no shared source yet
    void listImageGenExtensions(guardProfileId)
      .then((names) => {
        if (!cancelled) setExtensions(names ?? []);
      })
      .catch(() => {
        if (!cancelled) setExtensions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [guardIsA1111, guardProfileId]);
  // Face-detector chain probe (IF-6) — the ComfyUI dialect's ADetailer
  // availability twin of the extensions probe above: null = pending/failed
  // (row hidden, the failed-probe precedent); an ANSWERED empty list = the
  // Impact Pack chain absent (row renders disabled + hint, the plan's
  // honest-unavailable ruling); non-empty = the toggle lights up and the
  // picker serves the DISCOVERED models.
  const guardIsComfy = form?.backend === IMAGE_GEN_BACKENDS.ComfyUI;
  const [faceDetectors, setFaceDetectors] = useState<string[] | null>(null);
  useEffect(() => {
    if (!guardIsComfy || guardProfileId === null) {
      setFaceDetectors(null);
      return;
    }
    let cancelled = false;
    setFaceDetectors(null);
    void listImageGenFaceDetectors(guardProfileId)
      .then((detectors) => {
        if (!cancelled) setFaceDetectors(detectors ?? []);
      })
      .catch(() => {
        if (!cancelled) setFaceDetectors(null);
      });
    return () => {
      cancelled = true;
    };
  }, [guardIsComfy, guardProfileId]);
  if (form === null || form.id === null) return null;
  const profileId = form.id;
  const models: ImageGenModelEntry[] = imageGen.modelsByProfile[profileId] ?? [];
  const samplers = imageGen.samplersByProfile[profileId] ?? [];
  const schedulers = imageGen.schedulersByProfile[profileId] ?? [];
  const sidecars = imageGen.sidecarsByProfile[profileId];
  // IF-20: set when the server answered from its last-good snapshot.
  const modelsSnapshotAt = imageGen.modelsSnapshotAtByProfile[profileId];
  const sidecarsSnapshotAt = imageGen.sidecarsSnapshotAtByProfile[profileId];
  // IG-CF12a: the LOCAL-family pane (A1111 + ComfyUI, CG-B1) is a LOCAL
  // control surface — the shared status chip rides above the picker,
  // driven by the sampler fetch signal (`samplerStatusByProfile`), and an
  // offline server greys out the whole control panel below the chip
  // (owner ruling 2026-09-16: an unresponsive server greys out the whole
  // control panel). The chip's re-check button is the recovery
  // affordance — it stays interactive while the panel is greyed. Cloud
  // backends (openrouter/openai-images) render no chip.
  const isLocalBackend = isLocalDialectBackend(form.backend);
  const localStatus: LocalConnectionStatus = imageGen.samplerStatusByProfile[profileId] ?? "unknown";
  const localOffline = isLocalBackend && localStatus === "offline";
  const caps = form.capabilities;
  const bound = imageGen.modelOverlay !== null;
  const overlay = imageGen.modelOverlay;
  const selectedWorkflowFamily = guardWorkflowFamily;
  // The shared descriptor owns both backend and CFG-1-family gates.
  const [stepsSlider, cfgSlider, clipSkipSlider, cfgRescaleSlider] = buildScalarSliders({
    capabilities: caps,
    backend: form.backend,
    workflowFamily: selectedWorkflowFamily,
  });
  // T5: the optional seed — the ONE parse lives in the descriptor.
  const seedControl = buildSeedField(caps);
  // The SELECTED model's cache entry (comfyui dialect enrichment, CG-B1):
  // the template marker drives the «Detected» readout (picker), the DiT
  // sidecar fields (advanced), and the Krea-2 starting-point prefill.
  // T3: the DiT projection of the ONE gate derivation (the guard block's
  // `ditControls`) — the render rows and the swappable-VAE exclusion read
  // it. (The Krea-2 prefill below keeps its own local model-entry lookup.)
  const isDitTemplate = ditControls !== null;
  // T1 (TWIN_UNIFICATION step 1): the sampler dropdown's definition —
  // gate, options, label, commit — lives in model-controls; this surface
  // keeps only the renderer + its dual bind arm (one data source, many
  // consumers).
  const samplerControl = buildSamplerControl({
    supportsSamplers: caps.supportsSamplers,
    samplers,
  });
  // T2 (TWIN_UNIFICATION step 4): the scheduler dropdown's gate, options
  // and commit live in model-controls (the ONE local-dialect predicate
  // gates both this render and the fetch guards); this surface renders.
  const schedulerControl = buildSchedulerControl({ backend: form.backend });
  // T6 (TWIN_UNIFICATION step 2): the Krea 2 section's HOME — the chip's
  // accordion inherits the same descriptors (the IF-11 incident fix: the
  // controls are provider-modal settings, not a chip-only secret).
  const kreaControls = buildKreaTwoControls({ backend: form.backend, modelId: form.modelId ?? "" });
  // Effective (routed) params + sizes: the overlay's own values while bound
  // (empty = inherit the base), the profile base otherwise.
  const params = bound ? (overlay ?? {}) : form.defaultParams;
  // IF-19: the DiT sidecar options, translated once — the Auto head entry
  // (labelled with the file Auto resolves to) doubles as the pickable
  // `defaultOption` label.
  const ditEncoderOptions = ditControls
    ? translateModelOptions(ditControls.encoder.options(sidecars?.encoders, params.encoderName), t)
    : [];
  const ditVaeOptions = ditControls
    ? translateModelOptions(ditControls.vae.options(sidecars?.vaes, params.vaeName), t)
    : [];
  const sizes = bound ? (overlay?.modeSizePresets ?? {}) : form.modeSizePresets;
  const adetailerBaseSteps = params.steps ?? stepsSlider?.range.min ?? IMAGE_GEN_PARAM_RANGES.steps.min;
  // T7: gate, unavailable state, options, and fallback live in the shared
  // descriptor; this surface keeps its bound-only, non-accordion row.
  const adetailerControl = buildAdetailerControl({
    backend: form.backend,
    extensions,
    faceDetectors,
    baseSteps: adetailerBaseSteps,
  });

  const setParam = (patch: Partial<typeof params>) => {
    if (bound) imageGen.setModelOverlay(patch);
    else imageGen.setForm({ defaultParams: { ...form.defaultParams, ...patch } });
  };
  // IF-7b: the hires block write — a MERGE into the current block so the
  // toggle-off keeps the configured knobs (the stock sets' configured-but-
  // disabled pattern) and a knob edit never wipes its siblings.
  const setHiresParam = (patch: Partial<NonNullable<typeof params.hires>>) => {
    const current = params.hires ?? { enabled: false };
    setParam({ hires: { ...current, ...patch } });
  };
  // The narrowed block for the JSX below — a const local narrows where the
  // `params` union's property chain cannot.
  const paneHires = params.hires ?? null;
  // IF-7b: the pane's hires-section gate — the STATIC capability table
  // (the adapter's own gate; the profile's mirrored capabilities can be a
  // stale snapshot, the IF-6 lesson).
  const supportsHiresPane = IMAGE_GEN_BACKEND_CAPABILITIES[form.backend].supportsHiresFix === true;
  const hiresControl = buildHiresControl({ supportsHiresFix: supportsHiresPane });
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

  // ── IG-20a user size entries (vendor-set backends only) ──────────────
  // The entries extend the vendor grid until our static table catches up
  // (owner 2026-09-14: the user enters what the vendor announced). Shared
  // by every mode dropdown — the vocabulary is backend-level, not per-mode.
  const isVendorSet = caps.sizeSupport.kind === "vendor-set";
  // OpenRouter's wire takes aspect-ratio STRINGS (its pixel grids do not
  // reduce to the published ratios), so entries there MUST carry the ratio
  // from the vendor announcement; the OpenAI-images family sends "WxH"
  // verbatim and needs none.
  const needsRatio = form.backend === IMAGE_GEN_BACKENDS.OpenRouter;
  const userSizeOptions = form.userSizes.map((entry) => ({
    id: `${entry.width}x${entry.height}`,
    label:
      entry.ratio !== undefined
        ? `${entry.width}×${entry.height} · ${entry.ratio}`
        : `${entry.width}×${entry.height}`,
  }));
  const knownSizeIds = new Set<string>(
    caps.sizeSupport.kind === "vendor-set"
      ? [...caps.sizeSupport.sizes, ...userSizeOptions.map((option) => option.id)]
      : [],
  );
  const draftRatioOk = !needsRatio || /^\d+:\d+$/.test(draftRatio.trim());
  const draftKey = `${draftWidth}x${draftHeight}`;
  const canAddUserSize = !knownSizeIds.has(draftKey) && draftRatioOk;
  const addUserSize = () => {
    if (!canAddUserSize) return;
    const ratio = needsRatio ? draftRatio.trim() : undefined;
    imageGen.setForm({
      userSizes: [
        ...form.userSizes,
        { width: draftWidth, height: draftHeight, ...(ratio !== undefined && ratio !== "" ? { ratio } : {}) },
      ],
    });
    setDraftRatio("");
  };
  const removeUserSize = (index: number) => {
    imageGen.setForm({ userSizes: form.userSizes.filter((_, i) => i !== index) });
  };

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
          //
          // Krea-2 starting points (CG-B1, CF5 — explicit FORM values, never
          // hidden server state): picking a DiT model on a profile whose
          // param base is UNTOUCHED prefills the four krea2 scalars into the
          // base. IF-8b: the loader-folder template marker is NOT Krea-2
          // truth — every bare DiT (Anima, Qwen-Image, FLUX) lives in
          // diffusion_models and paints krea2-dit. The prefill keys off the
          // listing ladder's FAMILY label instead (owner ruling 2026-09-22,
          // IMAGEGEN_FOLLOWUP_REPORT IF-8b); a non-Krea DiT takes its own
          // family's stock set via detect-preselect, never krea2 defaults.
          // The all-four-unset gate is deliberate — a base the user already
          // tuned for checkpoints keeps its values; the overlay inherits
          // whatever the base carries.
          const entry = models.find((m) => m.id === modelId) ?? null;
          const prevEntry = form.modelId != null ? (models.find((m) => m.id === form.modelId) ?? null) : null;
          // DiT sidecar pins are TEMPLATE-LOCAL (owner defect report
          // 2026-09-27: an Anima-era encoder/VAE pin survived the switch to
          // a Krea model both ways — explicit beats the new family's
          // canonical in resolveComfySidecar, so a stale pin silently
          // mis-wires the graph). A switch that changes the resolved
          // template drops the pins; Auto resolves the new family's own
          // canonical pair (the Anima canonicals ARE qwen_3_06b_base +
          // qwen_image_vae — the owner's saved pair). Unknown listings
          // (hand-typed ids, missing entries) never trigger a clear.
          const templateChanged =
            prevEntry !== null && entry !== null && prevEntry.template !== entry.template;
          const prefillKrea2 =
            form.backend === IMAGE_GEN_BACKENDS.ComfyUI &&
            entry?.template === "krea2-dit" &&
            entry?.family === "Krea 2" &&
            form.defaultParams.steps === undefined &&
            form.defaultParams.cfgScale === undefined &&
            form.defaultParams.sampler === undefined &&
            form.defaultParams.scheduler === undefined;
          imageGen.setForm({
            modelId,
            ...(prefillKrea2 || templateChanged
              ? {
                  defaultParams: {
                    ...form.defaultParams,
                    ...(prefillKrea2 ? KREA2_FORM_DEFAULTS : {}),
                    ...(templateChanged ? { encoderName: undefined, vaeName: undefined } : {}),
                  },
                }
              : {}),
          });
        }}
        models={models}
        fetching={false}
        favoriteIds={favoriteIds}
        onToggleFavorite={(model) =>
          void (favoriteIds.has(model.id) ? imageGen.unstarModel(model.id) : imageGen.starModel(model.id, model.label))
        }
        onRefresh={() => {
          void imageGen.fetchSavedModels(profileId);
          // IF-20: «refresh» is the force-live path for every listing the
          // pane shows from the models folders — the DiT sidecar lists too.
          if (ditControls !== null) void imageGen.fetchSidecars(profileId);
        }}
        snapshotAt={modelsSnapshotAt ?? null}
      />

      {/* ── Image prompt family (IPT-5): ALWAYS visible under the model
          setting — dropdown (registry families + the explicit automatic
          choice) + Auto-detect + honest inline status/error. Server is the
          authority: the record's family fields render, the family route is
          the only writer, detection never guesses. */}
      <ImagePromptFamilyRow imageGen={imageGen} />

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
                      // IG-20a: the user's vendor-announced entries extend
                      // the grid (shared vocabulary across modes).
                      ...userSizeOptions,
                      // A stored pair outside table ∪ entries keeps its own
                      // option so the trigger shows the truth (the free-row
                      // twin — e.g. an entry deleted after a mode pinned it).
                      ...(presetKey !== "" && !knownSizeIds.has(presetKey)
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
          {isVendorSet && (
            <div
              className="mt-1 flex flex-col gap-2 rounded-lg border border-border2 bg-s2 p-3"
              data-testid="image-gen-user-sizes"
            >
              <div className="font-ui text-[13px] font-medium text-t1">{t("image_gen_user_sizes_title")}</div>
              <div className="text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
                {t("image_gen_user_sizes_hint")}
              </div>
              {form.userSizes.length > 0 && (
                <div className="flex flex-col gap-1.5" data-testid="image-gen-user-sizes-list">
                  {form.userSizes.map((entry, index) => (
                    <div
                      key={`${entry.width}x${entry.height}`}
                      className="flex items-center gap-2"
                      data-testid="image-gen-user-size-row"
                    >
                      <span className="font-ui text-[13px] text-t2">
                        {entry.width}×{entry.height}
                        {entry.ratio !== undefined ? ` · ${entry.ratio}` : ""}
                      </span>
                      <button
                        type="button"
                        data-testid={`image-gen-user-size-delete-${entry.width}x${entry.height}`}
                        aria-label={t("image_gen_user_size_delete", { size: `${entry.width}×${entry.height}` })}
                        onClick={() => removeUserSize(index)}
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-s3 text-t2 transition-all hover:bg-s2 hover:text-t1"
                      >
                        <Icons.Close />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-[110px] shrink-0" data-testid="image-gen-user-size-width">
                  <NumberInput
                    value={draftWidth}
                    min={IMAGE_SIZE_MIN_PX}
                    max={IMAGE_SIZE_MAX_PX}
                    step={IMAGE_SIZE_STEP_PX}
                    aria-label={t("image_gen_user_size_width")}
                    onChange={setDraftWidth}
                  />
                </div>
                <span className="select-none font-ui text-[13px] text-t3" aria-hidden="true">×</span>
                <div className="w-[110px] shrink-0" data-testid="image-gen-user-size-height">
                  <NumberInput
                    value={draftHeight}
                    min={IMAGE_SIZE_MIN_PX}
                    max={IMAGE_SIZE_MAX_PX}
                    step={IMAGE_SIZE_STEP_PX}
                    aria-label={t("image_gen_user_size_height")}
                    onChange={setDraftHeight}
                  />
                </div>
                {needsRatio && (
                  <div className="w-[90px] shrink-0" data-testid="image-gen-user-size-ratio">
                    <TextInput
                      value={draftRatio}
                      onChange={(e) => setDraftRatio(e.target.value)}
                      aria-label={t("image_gen_user_size_ratio")}
                      placeholder="5:4"
                    />
                  </div>
                )}
                <button
                  type="button"
                  data-testid="image-gen-user-size-add"
                  disabled={!canAddUserSize}
                  title={
                    !draftRatioOk
                      ? t("image_gen_user_size_ratio_required")
                      : knownSizeIds.has(draftKey)
                        ? t("image_gen_user_size_duplicate")
                        : undefined
                  }
                  onClick={addUserSize}
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-50"
                >
                  {t("image_gen_user_size_add")}
                </button>
              </div>
            </div>
          )}
          </div>
        )}
      </section>

      {/* ── Parameters: bind toggle + sampler + advanced expand ── */}
      <section className="rounded-lg border border-border bg-surface p-3.5" data-testid="image-gen-params-section">
        <div className="mb-3 font-ui text-[14px] font-semibold text-t1">{t("image_gen_params_section_title")}</div>

        {form.modelId !== null && (
          <div className="mb-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
            {/* The per-model bind toggle scopes WHERE parameter edits land:
                bound → the per-model overlay, unbound → the profile's
                default params (the same shape as per-model LLM settings).
                It is NEVER a visibility gate for settings themselves —
                every generation control renders in BOTH arms and
                reads/writes through the arm-routed `params`/`setParam`
                seam. The only bind-conditional element is the
                overlay-inherit hint below (copy describing the active
                arm). */}
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
            {/* IF-7a: the sets row lives here ALWAYS — bound (overlay arm) or
                unbound (profile-base arm) alike; the per-model toggle gates
                only the overlay FIELDS below, never set usage. */}
            <ModelSamplerSetRow imageGen={imageGen} />
          </div>
          {advancedOpen && (
            <div className="grid grid-cols-1 gap-3 bg-surface p-3 sm:grid-cols-2" data-testid="image-gen-advanced-body">
              {/* The sampler pick lives INSIDE the advanced accordion with the
                  rest of the sampler settings (owner 2026-09-17 — it used to
                  stand as a separate row above; the accordion IS the model's
                  sampler-settings surface). Full-width cell, first row. */}
              {samplerControl && (
                <div className="min-w-0 sm:col-span-2">
                  <label className={lblCls}>{t(samplerControl.labelKey)}</label>
                  <DropdownSelect
                    value={params.sampler ?? ""}
                    triggerTestId="image-gen-field-sampler"
                    searchable={false}
                    className="w-auto max-w-[320px]"
                    options={translateModelOptions(samplerControl.options, t)}
                    onChange={(next) => setParam(samplerControl.commit(next))}
                  />
                </div>
              )}
              {/* Schedule type (PG-3) — the sampler's schedule, on the
                  LOCAL dialect family (the descriptor's gate — a1111 +
                  comfyui serve the schedulers route; cloud backends have
                  no scheduler surface). Empty = vendor default, the
                  CF5 no-silent-defaults rule; the SAME bind routing as the
                  sampler above (bound → overlay, unbound → profile
                  defaults). Full-width cell, right under the sampler. */}
              {schedulerControl && (
                <div className="min-w-0 sm:col-span-2">
                  <label className={lblCls}>{t(schedulerControl.labelKey)}</label>
                  <DropdownSelect
                    value={params.scheduler ?? ""}
                    triggerTestId="image-gen-field-scheduler"
                    searchable={false}
                    className="w-auto max-w-[320px]"
                    options={translateModelOptions(schedulerControl.options(schedulers), t)}
                    onChange={(next) => setParam(schedulerControl.commit(next))}
                  />
                </div>
              )}
              {/* DiT sidecar fields (CG-B1, comfyui dialect; every DiT
                  workflow family since IF-19): text encoder + VAE — live
                  folder lists, the SAME bind routing as the sampler (bound
                  → overlay, unbound → profile defaults). Empty = the
                  adapter's canonical auto-resolution — CF5's honest Auto,
                  labelled with the file it resolves to, and the hint below
                  names what the family needs (IF-19). */}
              {ditControls && (
                <>
                  <div className="min-w-0">
                    <label className={lblCls}>{t(ditControls.encoder.labelKey)}</label>
                    <DropdownSelect
                      value={params.encoderName ?? ""}
                      triggerTestId="image-gen-field-encoder"
                      searchable={false}
                      className="w-auto max-w-[320px]"
                      // `defaultOption` makes Auto PICKABLE in the opened
                      // list (empty-id options are filtered out — the CG-B2
                      // review caught the pane's Auto as display-only; the
                      // chip's twin now ships pickable, parity restored).
                      // Its label is the descriptor's Auto head entry.
                      defaultOption={ditEncoderOptions[0]?.label}
                      options={ditEncoderOptions}
                      onChange={(next) => setParam(ditControls.encoder.commit(next))}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className={lblCls}>{t(ditControls.vae.labelKey)}</label>
                    <DropdownSelect
                      value={params.vaeName ?? ""}
                      triggerTestId="image-gen-field-vae"
                      searchable={false}
                      className="w-auto max-w-[320px]"
                      defaultOption={ditVaeOptions[0]?.label}
                      options={ditVaeOptions}
                      onChange={(next) => setParam(ditControls.vae.commit(next))}
                    />
                  </div>
                  <span
                    data-testid="image-gen-sidecar-hint"
                    className="sm:col-span-2 px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4"
                  >
                    {t(ditControls.hint.labelKey, ditControls.hint.params)}
                  </span>
                  {/* T3 hint parity: a failed sidecar fetch says so (the
                      chip's `sidecarsFailed` twin — the store's per-profile
                      flag, same key, options-data rule: no connectivity
                      conclusion). */}
                  {sidecarsSnapshotAt != null && (
                    <span
                      data-testid="image-gen-sidecars-snapshot"
                      className="sm:col-span-2 px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4"
                    >
                      {t("image_gen_sidecars_snapshot", { time: formatListingSnapshotTime(sidecarsSnapshotAt) })}
                    </span>
                  )}
                  {(imageGen.sidecarsFailedByProfile[profileId] ?? false) && (
                    <span
                      data-testid="image-gen-sidecars-failed"
                      className="sm:col-span-2 px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4"
                    >
                      {t("image_gen_sidecars_failed")}
                    </span>
                  )}
                </>
              )}
              {/* Swappable-VAE field (IF-7b): the SET/profile-carried VAE
                  override for dialects with a SWAPPABLE slot — A1111
                  (override_settings.sd_vae) and the Comfy checkpoint
                  template (VAELoader swap). DiT targets keep their
                  family-fixed sidecar above (the field never renders for
                  them). Same bind routing as every param (bound → overlay,
                  unbound → profile defaults). */}
              {isLocalBackend && !isDitTemplate && (
                <div className="min-w-0">
                  <label className={lblCls}>{t("image_gen_vae_label")}</label>
                  <DropdownSelect
                    value={params.vae ?? ""}
                    triggerTestId="image-gen-field-vae-swap"
                    searchable={false}
                    className="w-auto max-w-[320px]"
                    defaultOption={t("image_gen_sampler_auto")}
                    options={[
                      { id: "", label: t("image_gen_sampler_auto") },
                      ...(imageGen.vaeByProfile[profileId] ?? []).map((name) => ({ id: name, label: name })),
                      // A stored value outside the live list stays pickable
                      // (the STT/LLM selector rule — the since-removed-file
                      // truth the DiT fields render).
                      ...(params.vae !== undefined && !(imageGen.vaeByProfile[profileId] ?? []).includes(params.vae)
                        ? [{ id: params.vae, label: params.vae }]
                        : []),
                    ]}
                    onChange={(next) => setParam({ vae: next === "" ? undefined : next })}
                  />
                </div>
              )}
              {stepsSlider && (
                <SamplerSliderField
                  label={t(stepsSlider.labelKey)}
                  value={params.steps}
                  onChange={(steps) => setParam(stepsSlider.commit(steps))}
                  range={stepsSlider.range}
                  rangeTestId="image-gen-range-steps"
                  cellTestId="image-gen-field-steps"
                />
              )}
              {cfgSlider && (
                <SamplerSliderField
                  label={t(cfgSlider.labelKey)}
                  value={params.cfgScale}
                  onChange={(cfgScale) => setParam(cfgSlider.commit(cfgScale))}
                  range={cfgSlider.range}
                  rangeTestId="image-gen-range-cfg"
                  cellTestId="image-gen-field-cfg"
                />
              )}
              {cfgRescaleSlider && (
                <SamplerSliderField
                  label={t(cfgRescaleSlider.labelKey)}
                  value={params.cfgRescale}
                  onChange={(cfgRescale) => setParam(cfgRescaleSlider.commit(cfgRescale))}
                  range={cfgRescaleSlider.range}
                  rangeTestId="image-gen-range-cfg-rescale"
                  cellTestId="image-gen-field-cfg-rescale"
                />
              )}
              {/* T5: the optional seed — label + numeric TextInput parsed by
                  the ONE descriptor parse ("" → inherit; garbage → no commit).
                  A full seed-range slider is meaningless here (owner-approved). */}
              {seedControl && (
                <div className="min-w-0">
                  <label className={lblCls}>{t(seedControl.labelKey)}</label>
                  <div className="relative">
                    <TextInput
                      className="!pr-8"
                      inputMode="numeric"
                      data-testid="image-gen-field-seed"
                      value={params.seed === undefined ? "" : String(params.seed)}
                      onChange={(e) => {
                        const patch = seedControl.parse(e.target.value);
                        if (patch !== null) setParam({ seed: patch.seed });
                      }}
                    />
                    <button
                      type="button"
                      aria-label={t("image_gen_seed_random")}
                      data-testid="image-gen-random-seed"
                      className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-t3 transition-colors hover:text-t1"
                      onClick={() => {
                        const patch = seedControl.parse(String(seedControl.randomSeed()));
                        if (patch !== null) setParam({ seed: patch.seed });
                      }}
                    >
                      <Icons.Dices />
                    </button>
                  </div>
                </div>
              )}
              {clipSkipSlider && (
                <SamplerSliderField
                  label={t(clipSkipSlider.labelKey)}
                  value={params.clipSkip}
                  onChange={(clipSkip) => setParam(clipSkipSlider.commit(clipSkip))}
                  range={clipSkipSlider.range}
                  rangeTestId="image-gen-range-clip-skip"
                  cellTestId="image-gen-field-clip-skip"
                />
              )}
              {/* Krea 2 generative controls (T6, TWIN_UNIFICATION step 2): the
                  pane is the section's HOME — rendered from the same
                  model-controls descriptors the chip's accordion reads.
                  Owner ruling: NOT gated behind the per-model bind toggle
                  — the section renders for any krea-own model and writes
                  the ACTIVE arm (the base profile when unbound, the
                  per-model overlay when bound). Display follows the
                  CF13/CF15 canon: the arm's OWN block — a bound overlay
                  with an empty field shows the anchor default, never the
                  base (the generation ladder still inherits per-field).
                  Creativity defaults to the POLICY "raw", sliders to the
                  vendor-neutral unsent 0. */}
              {kreaControls !== null && (
                <div
                  className="col-span-full flex flex-col gap-2.5 rounded-md border border-border bg-s2/50 p-2.5"
                  data-testid="image-gen-krea-section"
                >
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">
                    {t("image_gen_krea_section")}
                  </span>
                  <div className="flex flex-col gap-1.5">
                    <span className={cn(lblCls, "!mb-0 font-ui text-t2")}>{t(kreaControls.creativity.labelKey)}</span>
                    <SegmentedControl
                      value={params.krea?.creativity ?? kreaControls.creativity.default}
                      options={kreaControls.creativity.options.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      }))}
                      onChange={(value) => setParam(kreaControls.creativity.commit(params.krea, value))}
                      wrap
                      mobileFill
                      mobileSelect
                      ariaLabel={t(kreaControls.creativity.labelKey)}
                    />
                  </div>
                  {kreaControls.sliders.map((slider) => (
                    <SamplerSliderField
                      key={slider.field}
                      label={t(slider.labelKey)}
                      value={params.krea?.[slider.field] ?? slider.default}
                      onChange={(value) => setParam(slider.commit(params.krea, value))}
                      range={{ min: slider.min, max: slider.max, step: slider.step }}
                      rangeTestId={`image-gen-range-krea-${slider.field}`}
                      cellTestId={`image-gen-field-krea-${slider.field}`}
                    />
                  ))}
                </div>
              )}
              {/* ADetailer (IG-CF15 15d / PG-4 v1): T7 supplies the
                  dialect tri-state. Renders in BOTH bind arms — the bind
                  toggle routes edits (overlay vs default params), it never
                  hides controls; IO rides the shared `params`/`setParam`
                  seam like the krea sliders and the hires section. */}
              {adetailerControl !== null && (
                <div
                  className="col-span-full flex flex-col gap-2 rounded-md border border-border bg-s2/50 p-2.5"
                  data-testid="image-gen-adetailer-row"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={cn(
                        "font-ui text-[calc(var(--ui-fs)-2px)] font-medium",
                        adetailerControl.state === "unavailable" ? "text-t3" : "text-t1",
                      )}
                    >
                      {t(adetailerControl.labelKey)}
                    </span>
                    <Toggle
                      checked={params.adetailer === true}
                      onChange={(checked) => setParam({ adetailer: checked })}
                      disabled={adetailerControl.state === "unavailable"}
                      aria-label={t(adetailerControl.labelKey)}
                    />
                  </div>
                  {adetailerControl.state === "unavailable" ? (
                    <span
                      className="font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-t3"
                      data-testid="image-gen-adetailer-missing"
                    >
                      {t(adetailerControl.hintKey)}
                    </span>
                  ) : params.adetailer === true && (
                    <>
                    <div className="flex flex-col gap-1.5">
                      <span className={cn(lblCls, "!mb-0 font-ui text-t2")}>{t(adetailerControl.modelLabelKey)}</span>
                      <DropdownSelect
                        value={params.adetailerModel ?? adetailerControl.fallback}
                        options={translateModelOptions(adetailerControl.options, t)}
                        onChange={(id) => setParam({ adetailerModel: id })}
                        triggerTestId="image-gen-adetailer-model"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className={cn(lblCls, "!mb-0 font-ui text-t2")}>{t(adetailerControl.stepsLabelKey)}</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          data-testid="image-gen-range-adetailer-steps"
                          min={adetailerControl.stepsRange.min}
                          max={adetailerControl.stepsRange.max}
                          step={adetailerControl.stepsRange.step}
                          value={params.adetailerSteps ?? adetailerBaseSteps}
                          onChange={(e) => {
                            const patch = adetailerControl.parseSteps(e.target.value);
                            if (patch !== null) setParam(patch);
                          }}
                          className={cn("!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent p-0")}
                        />
                        <div className="w-[60px] shrink-0" data-testid="image-gen-adetailer-steps">
                          <NumberInput
                            className="h-[30px] w-[60px]"
                            min={adetailerControl.stepsRange.min}
                            max={adetailerControl.stepsRange.max}
                            step={adetailerControl.stepsRange.step}
                            value={params.adetailerSteps ?? adetailerBaseSteps}
                            onChange={(n) => {
                              const patch = adetailerControl.parseSteps(String(n));
                              if (patch !== null) setParam(patch);
                            }}
                            hideControls
                          />
                        </div>
                      </div>
                    </div>
                    </>
                  )}
                </div>
              )}
              {/* Hires-fix section (IF-7b): the pane's twin of the chip's
                  ImageGenHiresSection — the PROFILE-level home of the block
                  (both bind arms: bound → overlay.hires, unbound →
                  defaultParams.hires), so a stock set's configured-but-
                  disabled block has a place where the user flips it on
                  (owner ruling 2026-09-22: the user opts in — see
                  reports/IMAGEGEN_FOLLOWUP_REPORT.md). Gated off the
                  STATIC capability table — the adapter's own gate (the
                  mirror can be stale, the IF-6 lesson).
                  fork #2 of the hires field block (source: model-controls
                  buildHiresControl); correspondence: toggle row, upscaler
                  dropdown, and three shared-descriptor sliders; deviations:
                  pane card chrome, dual-arm routing, and no failed hint. */}
              {hiresControl !== null && (
                <div
                  className="col-span-full flex flex-col gap-2 rounded-md border border-border bg-s2/50 p-2.5"
                  data-testid="image-gen-hires-row"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">
                      {t(hiresControl.labelKey)}
                    </span>
                    <Toggle
                      checked={paneHires?.enabled === true}
                      onChange={(checked) => setHiresParam({ enabled: checked })}
                      aria-label={t(hiresControl.labelKey)}
                    />
                  </div>
                  {paneHires?.enabled === true && (
                    <div className="flex flex-col gap-2" data-testid="image-gen-hires-body">
                      <div className="flex flex-col gap-1.5">
                        <span className={cn(lblCls, "!mb-0 font-ui text-t2")}>
                          {t(hiresControl.upscalerLabelKey)}
                        </span>
                        <DropdownSelect
                          value={paneHires.upscaler ?? ""}
                          defaultOption={t(hiresControl.upscalerAutoLabelKey)}
                          options={translateModelOptions(hiresControl.upscalerOptions(paneUpscalers, paneHires.upscaler), t)}
                          onChange={(next) => setHiresParam({ upscaler: hiresControl.commitUpscaler(next) })}
                          triggerTestId="image-gen-hires-upscaler"
                        />
                      </div>
                      <SliderField
                        label={t(hiresControl.sliders[0].labelKey)}
                        value={paneHires.steps ?? hiresControl.sliders[0].displayAnchor}
                        min={hiresControl.sliders[0].range.min}
                        max={hiresControl.sliders[0].range.max}
                        step={hiresControl.sliders[0].range.step}
                        onChange={(value) => setHiresParam({ steps: value })}
                        rangeTestId="image-gen-hires-steps"
                      />
                      <SliderField
                        label={t(hiresControl.sliders[1].labelKey)}
                        value={paneHires.scale ?? hiresControl.sliders[1].displayAnchor}
                        min={hiresControl.sliders[1].range.min}
                        max={hiresControl.sliders[1].range.max}
                        step={hiresControl.sliders[1].range.step}
                        onChange={(value) => setHiresParam({ scale: value })}
                        rangeTestId="image-gen-hires-scale"
                      />
                      <SliderField
                        label={t(hiresControl.sliders[2].labelKey)}
                        value={paneHires.denoisingStrength ?? hiresControl.sliders[2].displayAnchor}
                        min={hiresControl.sliders[2].range.min}
                        max={hiresControl.sliders[2].range.max}
                        step={hiresControl.sliders[2].range.step}
                        onChange={(value) => setHiresParam({ denoisingStrength: value })}
                        rangeTestId="image-gen-hires-denoise"
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
