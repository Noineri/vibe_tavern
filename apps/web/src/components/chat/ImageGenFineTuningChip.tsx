/**
 * Fine-tuning pill above the chat input (IMAGE_GENERATION_PLAN IG-17,
 * restyled to the DicePanel pill canon 2026-09-15 — owner: "chip like the
 * dice one"). Lives in the PlayMode shared launcher bar next to DicePanel /
 * NarrationPlaylistPanel (the design's "chip above the input joins the dice
 * tray" line).
 *
 * Visible ONLY while the chat's "Fine tuning" toggle is on (the IG-16 gate
 * in `useImageGenChatStore.fineTuningByChat`). A compact pill (image icon +
 * label + caret; accent state while a draft prompt is armed) opens the
 * editor: desktop a Radix popover, mobile a BottomSheet — the same body on
 * both (the DicePanel pattern). The pill label is FIXED (the dice pill never
 * shows roll internals); profile/model/samplers live in the editor body.
 *
 * The editor holds the design's chip contents (design lines 30/160):
 * profile + model pick, the model-settings accordion (FT-A1: the ONLY
 * sampler surface — the one-shot draft sampler row is gone; owner ruling
 * 2026-09-17: the fine-tuning editor is THE place to pick everything, see
 * plans/FINE_TUNING_CHIP_REBUILD_PLAN.md), LoRAs, positive prompt, negative
 * prompt (only when `supportsNegativePrompt` — the IG-13 gate). Everything edits the per-chat
 * draft in the image-gen chat store; the message popover folds the draft
 * into the NEXT generation's payload (positive → verbatim `prompt`, picks +
 * negative → `overrides`).
 *
 * The popover width is adaptive (FT-A1): clamp(300px, 40vw, 560px) with the
 * available-space cap — floor 300, grows with the window, cap 560
 * (owner-approved 2026-09-17). Mobile renders the same body in a
 * BottomSheet (unchanged).
 *
 * IF-5 (2026-09-24): the body USES that width — with advanced blocks
 * present it becomes a two-column grid at >=480px of container width
 * (base flow + prompt pair left, per-run tuning right; footer spans both).
 * The body root is the Tailwind `@container`, so the desktop popover and
 * the mobile BottomSheet switch together; a narrow container stays the
 * single column. Cloud dialects with no advanced content never get the
 * grid — no dead half-column.
 */

import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { Icons } from "../shared/icons.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { SliderField } from "../shared/SliderField.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { Toggle } from "../shared/Toggle.js";
import { TextInput } from "../shared/text-input.js";
import { NumberInput } from "../shared/NumberInput.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { buildSamplerControl, translateModelOptions } from "../../lib/imagegen/model-controls.js";
import { lblCls } from "../../lib/field-tokens.js";
import { cn } from "../../lib/cn.js";
import { templateDisplayLabel } from "../../lib/imagegen/template-labels.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT, type TFunc } from "../../i18n/context.js";
import {
  listAllImageGenProfiles,
  listImageGenPromptCaps,
  listImageGenModels,
  listImageGenSamplers,
  listImageGenUpscalers,
  listImageGenSchedulers,
  listImageGenExtensions,
  listImageGenFaceDetectors,
  listImageGenLoras,
  listImageGenDitSidecars,
  getImageGenModelSettings,
  upsertImageGenModelSettings,
  type ImageGenModelEntry,
  type ImageGenProfileRecord,
  type ImageGenLora,
  type ImageGenUpscaler,
  type ImageGenDitSidecars,
  type ImageGenPromptCap,
} from "../../api/image-gen-api.js";
import type { ImageGenSamplerInfoValue, ImageGenSchedulerInfoValue, ImageGenModelSettingsOverlayValue, ImageGenBackendValue } from "@vibe-tavern/api-contracts";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GENERATION_MODES, IMAGE_GEN_PARAM_RANGES, IMAGE_GEN_ADETAILER_FACE_MODELS, IMAGE_GEN_ADETAILER_DEFAULT_MODEL, IMAGE_SIZE_DEFAULT, IMAGE_SIZE_MAX_PX, IMAGE_SIZE_MIN_PX, IMAGE_SIZE_PRESETS, hasAdetailerExtension, type ImageGenerationMode, type ImageSizeOrientation } from "@vibe-tavern/domain";
import { EMPTY_IMAGE_GEN_DRAFT, buildDraftGenerateInput, resolveEffectiveImageGenProfile, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useOrderedMessages } from "../../stores/snapshot-store.js";
import { ImageGenLoraSection } from "./ImageGenLoraSection.js";
import { ImageGenHiresSection } from "./ImageGenHiresSection.js";

export interface ImageGenFineTuningChipProps {
  chatId: string;
}

/** Purpose-word per preset orientation (IG-CF14, the pane's twin label
 *  map): "Square 1:1 · 1024×1024" — purpose + ratio + concrete resolution,
 *  never a bare ratio. */
const PRESET_LABEL_KEYS: Record<ImageSizeOrientation, Parameters<TFunc>[0]> = {
  square: "image_gen_preset_square",
  portrait: "image_gen_preset_portrait",
  landscape: "image_gen_preset_landscape",
};

/** The six registry modes in order (FT-A2 — the message popover's list,
 *  no new names). */
const MODES: ImageGenerationMode[] = Object.values(IMAGE_GENERATION_MODES);

export function ImageGenFineTuningChip({ chatId }: ImageGenFineTuningChipProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const fineTuning = useImageGenChatStore((s) => s.fineTuningByChat[chatId] ?? false);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId]);
  const [open, setOpen] = useState(false);

  if (!fineTuning) return null;

  const hasPrompt = (draft?.prompt.trim() ?? "") !== "";

  const body = (
    <ImageGenFineTuningBody
      chatId={chatId}
      onGenerateFired={() => setOpen(false)}
    />
  );

  // The DicePanel structure verbatim: ONE popover (Root + Trigger own the
  // click → open on BOTH platforms), its Popover content desktop-only, and a
  // BottomSheet sibling for mobile — the same `body` on both.
  const popover = (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="image-gen-ft-chip"
          aria-label={t("image_gen_fine_tuning")}
          aria-expanded={open}
          className={cn(
            "glass-blur flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
            hasPrompt && "border-accent/40 bg-accent-dim text-accent-t",
          )}
        >
          <Icons.images />
          <span>{t("image_gen_fine_tuning")}</span>
          <Icons.Caret direction={open ? "d" : "u"} />
        </button>
      </Popover.Trigger>
      {!isMobile && (
        <Popover.Portal container={getModalPortal() ?? document.body}>
          <Popover.Content
            side="top"
            align="center"
            sideOffset={4}
            className="glass-blur z-[220] flex max-h-[70vh] w-[clamp(300px,40vw,560px)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border2 bg-glass-bg p-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {body}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );

  const sheet = open && isMobile && (
    <BottomSheet open={true} onClose={() => setOpen(false)} title={t("image_gen_fine_tuning")}>
      {body}
    </BottomSheet>
  );

  return (
    <div className="flex items-center" data-testid="image-gen-ft-chip-row">
      {popover}
      {sheet}
    </div>
  );
}

// ─── Shared editor body (desktop popover + mobile sheet) ────────────────────

function ImageGenFineTuningBody({ chatId, onGenerateFired }: { chatId: string; onGenerateFired?: () => void }) {
  const { t, tDynamic } = useT();
  const activeProfileId = useImageGenChatStore((s) => s.activeProfileIdByChat[chatId]);
  const globalActiveId = useImageGenChatStore((s) => s.activeImageGenProfileId);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setActiveProfile = useImageGenChatStore((s) => s.setActiveProfile);
  const setFineTuningDraft = useImageGenChatStore((s) => s.setFineTuningDraft);
  const clearFineTuningDraft = useImageGenChatStore((s) => s.clearFineTuningDraft);
  const runGeneration = useImageGenChatStore((s) => s.runGeneration);
  const running = useImageGenChatStore((s) => s.runningByChat[chatId]);
  // The tail anchor (FT-A3) — read BEFORE any early return (hooks order).
  const orderedMessages = useOrderedMessages();

  const [profiles, setProfiles] = useState<ImageGenProfileRecord[] | null>(null);
  const [models, setModels] = useState<ImageGenModelEntry[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [samplers, setSamplers] = useState<ImageGenSamplerInfoValue[] | null>(null);
  const [loras, setLoras] = useState<ImageGenLora[] | null>(null);
  const [lorasFailed, setLorasFailed] = useState(false);
  const [upscalers, setUpscalers] = useState<ImageGenUpscaler[] | null>(null);
  const [upscalersFailed, setUpscalersFailed] = useState(false);
  const [promptCaps, setPromptCaps] = useState<ImageGenPromptCap[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listAllImageGenProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    // IF-10: the learned prompt-cap table rides the same mount fetch —
    // advisory counter data, tiny global list; a failure means no counter
    // (never a blocked send).
    void listImageGenPromptCaps()
      .then((list) => {
        if (!cancelled) setPromptCaps(list);
      })
      .catch(() => {
        if (!cancelled) setPromptCaps([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // MR-5: the fallback chain — chat pick → global active → first row
  //  (the chip is the per-chat OVERRIDE layer; no pick = inherit global).
  const effective = resolveEffectiveImageGenProfile(profiles, activeProfileId, globalActiveId);
  const effectiveId = effective?.id ?? null;
  // IF-10: the learned cap lookup mirrors the adapter's model resolution —
  // the chip's model pick (non-empty) outranks the saved profile model.
  const effectiveModel =
    draft.model !== undefined && draft.model !== "" ? draft.model : (effective?.modelId ?? null);
  const promptCap =
    effective !== null && effectiveModel !== null && promptCaps !== null
      ? promptCaps.find((row) => row.backend === effective.backend && row.modelId === effectiveModel)
          ?.maxPromptChars
      : undefined;
  const caps = effective?.capabilities ?? null;
  const supportsSamplers = caps?.supportsSamplers ?? false;
  const supportsNegative = caps?.supportsNegativePrompt ?? false;
  const supportsLoras = caps?.supportsLoras ?? false;
  const supportsHiresFix = caps?.supportsHiresFix ?? false;

  // Model catalog for the effective profile (re-fetched on profile switch).
  useEffect(() => {
    if (effectiveId === null) {
      setModels(null);
      return;
    }
    let cancelled = false;
    setModels(null);
    setModelsFailed(false);
    void listImageGenModels(effectiveId)
      .then((list) => {
        if (!cancelled) setModels(list ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setModelsFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId]);

  // Sampler list — capability-gated before calling (the route 400s on
  // unsupported backends; the hook contract gates on supportsSamplers).
  useEffect(() => {
    if (effectiveId === null || !supportsSamplers) {
      setSamplers(null);
      return;
    }
    let cancelled = false;
    setSamplers(null);
    void listImageGenSamplers(effectiveId)
      .then((list) => {
        if (!cancelled) setSamplers(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setSamplers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId, supportsSamplers]);

  // LoRA list (CG-C3) — the samplers-twin gate: capability first (the
  // route 400s on non-comfy dialects), fetch on profile switch, failure =
  // the failed hint (not a crash — the MediaMenu precedent).
  useEffect(() => {
    if (effectiveId === null || !supportsLoras) {
      setLoras(null);
      setLorasFailed(false);
      return;
    }
    let cancelled = false;
    setLoras(null);
    setLorasFailed(false);
    void listImageGenLoras(effectiveId)
      .then((list) => {
        if (!cancelled) setLoras(list ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setLoras([]);
          setLorasFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId, supportsLoras]);

  // Upscaler list (FT-A6) — the loras-twin gate: capability first (the
  //  route 400s off the A1111 dialect), fetch on profile switch, failure =
  //  the failed hint beside the dropdown (not a crash — the knob rows
  //  stay usable; the MediaMenu precedent).
  useEffect(() => {
    if (effectiveId === null || !supportsHiresFix) {
      setUpscalers(null);
      setUpscalersFailed(false);
      return;
    }
    let cancelled = false;
    setUpscalers(null);
    setUpscalersFailed(false);
    void listImageGenUpscalers(effectiveId)
      .then((list) => {
        if (!cancelled) setUpscalers(list ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setUpscalers([]);
          setUpscalersFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId, supportsHiresFix]);

  if (profiles === null) {
    return (
      <div className="flex h-16 items-center justify-center px-3 text-[calc(var(--ui-fs)-2px)] text-t3">…</div>
    );
  }

  const busy = running !== undefined;

  // ── The Generate action (FT-A3) ───────────────────────────────
  // Anchor = the chat's TAIL message (the cockpit sits above the input —
  // "generate the latest moment", the message-popover twin with the last
  // message as its anchor). The target mode comes from FT-A2's selector
  // (Free display default); free still REQUIRES the chip prompt (the
  // menu's free-row gate, IG-17).
  const tailAnchor = orderedMessages.length > 0 ? orderedMessages[orderedMessages.length - 1]!.id : undefined;
  const targetMode = draft.target ?? IMAGE_GENERATION_MODES.Free;
  const freeBlocked = targetMode === IMAGE_GENERATION_MODES.Free && draft.prompt.trim() === "";
  const generateDisabled = busy || freeBlocked;
  function fireGenerate(): void {
    if (generateDisabled || effective === null) return;
    const input = buildDraftGenerateInput({
      draft,
      effective,
      mode: targetMode,
      anchorMessageId: tailAnchor,
      foldDraft: true,
    });
    if (input === null) return;
    void runGeneration(chatId, input, {
      // PG-2 twin: the START-time capability snapshot from the static
      // registry table (the saved mirror can predate the backend).
      liveProgress: IMAGE_GEN_BACKEND_CAPABILITIES[effective.backend].supportsLiveProgress,
    });
    onGenerateFired?.();
  }

  // The LoRA section's auto-preselect anchor: the family of the model this
  // generation will actually run (the draft's pick, else the profile's).
  const effectiveModelId = draft.model ?? effective?.modelId;
  const modelFamily = models?.find((m) => m.id === effectiveModelId)?.family;
  // The PICKED model's own cache entry (comfyui dialect enrichment, CG-B2 —
  // the pane's selectedModelEntry twin): its `template` marker drives the
  // «Detected» readout under the picker and the accordion's DiT gate.
  const selectedModelEntry = models?.find((m) => m.id === draft.model) ?? null;

  // ── Resolution option set (FT-A2) ────────────────────────────────
  // Vendor-set backends: the announced grid ∪ the profile's user-added
  // entries (IG-20a), the CF14 duality — no Custom there. Free backends:
  // the CF14 buckets + Custom (two steppers revealed when picked).
  const sizeSupport = caps?.sizeSupport ?? { kind: "free" as const };
  const isVendorSet = sizeSupport.kind === "vendor-set";
  const vendorSizeIds = isVendorSet
    ? [
        ...sizeSupport.sizes,
        ...(effective?.userSizes ?? []).map((e) => `${e.width}x${e.height}`),
      ].filter((id, index, all) => all.indexOf(id) === index)
    : [];
  // "" = Auto (unset); "custom" = the free-dialect stepper pair; a "WxH"
  // key = a listed bucket/size. A stored pair matching NO list entry: free
  // dialect → "custom" (the steppers show the truth); vendor dialect → its
  // own raw entry below (the pane's since-removed-files rule — the trigger
  // never lies about what is set).
  const resolutionValue = (() => {
    if (draft.customSize === true) return "custom";
    if (draft.width === undefined && draft.height === undefined) return "";
    const key = `${draft.width ?? ""}x${draft.height ?? ""}`;
    const listed = isVendorSet ? vendorSizeIds : IMAGE_SIZE_PRESETS.map((p) => `${p.width}x${p.height}`);
    if (listed.includes(key)) return key;
    return isVendorSet ? key : "custom";
  })();
  const resolutionOptions = isVendorSet
    ? [
        ...vendorSizeIds.map((id) => ({ id, label: id.replace("x", "×") })),
        ...(resolutionValue !== "" && !vendorSizeIds.includes(resolutionValue)
          ? [{ id: resolutionValue, label: resolutionValue.replace("x", "×") }]
          : []),
      ]
    : [
        ...IMAGE_SIZE_PRESETS.map((p) => ({
          id: `${p.width}x${p.height}`,
          label: t(PRESET_LABEL_KEYS[p.orientation], {
            ratio: p.ratio,
            size: `${p.width}×${p.height}`,
          }),
        })),
        { id: "custom", label: t("image_gen_size_custom") },
      ];
  const isCustomResolution = !isVendorSet && resolutionValue === "custom";
  // IF-5 (2026-09-24): with advanced blocks present (a picked local model →
  // the settings accordion, LoRAs, hires fix) the body is a two-column
  // grid at a comfortable container width — Tailwind 4 container queries,
  // the body root itself being the container, so the desktop popover AND
  // the mobile BottomSheet switch from one place ("narrow screen = single
  // column", owner ruling recorded in report item IF-5). Left column =
  // the base flow (profile → model → target → resolution) + the prompt
  // pair; right = the per-run tuning blocks; the footer spans both
  // columns. Without advanced content the single column stays — no dead
  // half-column for cloud dialects.
  const hasAdvanced =
    (effective !== null && draft.model !== undefined) || supportsLoras || supportsHiresFix;

  return (
    <div className="@container flex flex-col gap-2.5 p-1" data-testid="image-gen-ft-body">
      <div
        className={cn(
          "flex flex-col gap-2.5",
          hasAdvanced &&
            "@min-[480px]:grid @min-[480px]:grid-cols-2 @min-[480px]:items-start @min-[480px]:gap-2.5",
        )}
      >
        {/* ── Base column (left): what this generation is — the base flow
            fields, then the prompt pair. */}
        <div className="flex min-w-0 flex-col gap-2.5">
          {/* Profile + model (the design's "provider + model selector"). The
              profile pick shares the IG-16 popover's store map. */}
          <div className="flex flex-col gap-1.5 px-1.5">
            <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_profile_label")}</span>
            <DropdownSelect
              value={effective?.id ?? ""}
              options={profiles.map((p) => ({ id: p.id, label: p.name }))}
              onChange={(id) => setActiveProfile(chatId, id)}
              triggerTestId="image-gen-ft-profile-select"
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-1.5 px-1.5">
            <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_model_label")}</span>
            <DropdownSelect
              value={draft.model ?? ""}
              options={[
                { id: "", label: t("image_gen_chip_model_default") },
                // Family rides the opened list as the option's detail line
                // (CG-B2, the pane's row-family chip analog); `triggerDetail={
                // false}` keeps it OUT of the collapsed trigger (an
                // arbitrary-length family inside a nowrap trigger = the
                // inline-row gotcha, AGENTS.md).
                ...(models ?? []).map((m) => ({ id: m.id, label: m.label, detail: m.family })),
              ]}
              onChange={(id) => setFineTuningDraft(chatId, { model: id === "" ? undefined : id })}
              triggerTestId="image-gen-ft-model-select"
              disabled={busy || models === null}
              triggerDetail={false}
            />
            {/* «Detected: …» readout (CG-B2, the pane's ModelPicker line twin):
                which workflow template the adapter auto-detects for the PICKED
                model — loader-folder membership, the adapter's ground truth. A
                pick without a template marker (cloud dialects, unknown ids)
                renders nothing. */}
            {selectedModelEntry?.template && (
              <div
                data-testid="image-gen-ft-model-detected"
                className="mt-2 font-ui text-[12px] font-medium text-accent"
              >
                {t("image_gen_detected_template", {
                  template: templateDisplayLabel(selectedModelEntry.template, t),
                })}
              </div>
            )}
            {modelsFailed && (
              <span className="px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4">{t("image_gen_chip_models_failed")}</span>
            )}
          </div>

          {/* Generation target (FT-A2) — the same six modes as the message
              popover (registry order); the chip's Generate button fires this
              mode (FT-A3) and switching re-preselects the resolution from
              the profile's per-mode preset (changeable — owner 2026-09-17).
              Display default Free: the cockpit's canonical «your prompt
              verbatim» use. */}
          <div className="flex flex-col gap-1.5 px-1.5">
            <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_target_label")}</span>
            <DropdownSelect
              value={draft.target ?? IMAGE_GENERATION_MODES.Free}
              options={MODES.map((mode) => ({ id: mode, label: tDynamic(`image_gen_mode_${mode}`) }))}
              onChange={(id) => {
                const mode = id as ImageGenerationMode;
                const preset = effective?.modeSizePresets?.[mode];
                setFineTuningDraft(chatId, {
                  target: mode,
                  width: preset?.width,
                  height: preset?.height,
                });
              }}
              triggerTestId="image-gen-ft-target-select"
              disabled={busy}
            />
          </div>

          {/* Resolution (FT-A2): free backends get the CF14 buckets + Custom
              (two steppers); vendor-set backends get their announced grid +
              user-added entries (the CF14 duality, plan Wave-A item 8 — no
              Custom there). Auto = unset → the profile's per-mode preset
              resolves server-side. */}
          <div className="flex flex-col gap-1.5 px-1.5" data-testid="image-gen-ft-resolution-row">
            <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_resolution_label")}</span>
            <DropdownSelect
              value={resolutionValue}
              triggerTestId="image-gen-ft-resolution-select"
              disabled={busy}
              defaultOption={t("image_gen_size_auto")}
              options={resolutionOptions}
              onChange={(id) => {
                if (id === "") {
                  setFineTuningDraft(chatId, { customSize: undefined, width: undefined, height: undefined });
                  return;
                }
                if (id === "custom") {
                  setFineTuningDraft(chatId, {
                    customSize: true,
                    width: draft.width ?? IMAGE_SIZE_DEFAULT.width,
                    height: draft.height ?? IMAGE_SIZE_DEFAULT.height,
                  });
                  return;
                }
                const [width, height] = id.split("x").map(Number);
                setFineTuningDraft(chatId, { customSize: undefined, width, height });
              }}
            />
            {isCustomResolution && (
              <div className="flex gap-1.5" data-testid="image-gen-ft-custom-size">
                <div className="flex flex-1 flex-col gap-1.5">
                  <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_width_label")}</span>
                  <div data-testid="image-gen-ft-width">
                    <NumberInput
                      value={draft.width ?? IMAGE_SIZE_DEFAULT.width}
                      min={IMAGE_SIZE_MIN_PX}
                      max={IMAGE_SIZE_MAX_PX}
                      step={64}
                      onChange={(v) => setFineTuningDraft(chatId, { width: v })}
                      disabled={busy}
                    />
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_height_label")}</span>
                  <div data-testid="image-gen-ft-height">
                    <NumberInput
                      value={draft.height ?? IMAGE_SIZE_DEFAULT.height}
                      min={IMAGE_SIZE_MIN_PX}
                      max={IMAGE_SIZE_MAX_PX}
                      step={64}
                      onChange={(v) => setFineTuningDraft(chatId, { height: v })}
                      disabled={busy}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="my-0.5 h-px bg-border opacity-40" />

          <div className="flex flex-col gap-1.5 px-1.5">
            <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_prompt_label")}</span>
            <AutoTextarea
              value={draft.prompt}
              onChange={(e) => setFineTuningDraft(chatId, { prompt: e.target.value })}
              placeholder={t("image_gen_chip_prompt_placeholder")}
              minRows={2}
              maxRows={6}
              data-testid="image-gen-ft-prompt"
              aria-label={t("image_gen_chip_prompt_label")}
            />
            {/* IF-10: the learned provider cap — an advisory live counter
                (never a send gate). Red past the cap; the hint explains the
                mode template still adds on top of the editor text. */}
            {effective !== null && promptCap !== undefined && (
              <div
                data-testid="image-gen-ft-prompt-cap"
                title={t("image_gen_prompt_cap_hint")}
                className={`flex justify-end font-ui text-[calc(var(--ui-fs)-3px)] ${
                  draft.prompt.length > promptCap ? "text-danger" : "text-t4"
                }`}
              >
                {draft.prompt.length} / {promptCap}
              </div>
            )}
          </div>

          {supportsNegative && (
            <div className="flex flex-col gap-1.5 px-1.5" data-testid="image-gen-ft-negative-row">
              <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_negative_label")}</span>
              <AutoTextarea
                value={draft.negative}
                onChange={(e) => setFineTuningDraft(chatId, { negative: e.target.value })}
                placeholder={t("image_gen_chip_negative_placeholder")}
                minRows={2}
                maxRows={4}
                data-testid="image-gen-ft-negative"
                aria-label={t("image_gen_chip_negative_label")}
              />
            </div>
          )}
        </div>

        {/* ── Advanced column (right): the per-run tuning blocks, registry
            order; rendered only when at least one exists (the grid lives
            only with content — IF-5's no-dead-half rule). */}
        {hasAdvanced && (
          <div className="flex min-w-0 flex-col gap-2.5" data-testid="image-gen-ft-advanced-col">
            {/* The loaded model's own settings (IG-CF15 15d): edits the per-model
                overlay directly — one source of truth with the providers pane,
                the chip acting as the quick pult. Only with a concrete model
                picked; the ADetailer accordion nests INSIDE it when the server
                reports the extension (owner 2026-09-17). */}
            {effective !== null && draft.model !== undefined && (
              <ImageGenModelSettingsAccordion
                profileId={effective.id}
                modelId={draft.model}
                supportsSamplers={supportsSamplers}
                samplers={supportsSamplers ? (samplers ?? []) : []}
                backend={effective.backend}
                modelTemplate={selectedModelEntry?.template}
                disabled={busy}
              />
            )}

            {/* LoRAs (CG-C3): family-filtered picker, per-lora enable + strength,
                activation words click-to-copy — NEVER auto-inserted. */}
            {supportsLoras && (
              <ImageGenLoraSection
                chatId={chatId}
                modelFamily={modelFamily}
                loras={loras}
                failed={lorasFailed}
                disabled={busy}
              />
            )}

            {/* Hires fix (FT-A6): toggle + the four separate knobs, the A1111
                second pass — capability-gated like the loras section above. */}
            {supportsHiresFix && (
              <ImageGenHiresSection
                chatId={chatId}
                upscalers={upscalers}
                failed={upscalersFailed}
                disabled={busy}
              />
            )}
          </div>
        )}

        {/* Footer (FT-A3): Clear + the immediate Generate button (i18n key
            image_gen_chip_generate) — fires the
            shared draft fold on the current chat (mode = the target selector,
            anchor = the tail message) and closes the editor; the image lands
            as a chat slot message exactly like the message-popover path. Free
            target still requires the chip prompt (IG-17 gate). The footer
            spans BOTH columns in the IF-5 grid (`col-span-2` is inert in the
            single-column flex). */}
        <div className="flex items-center justify-end gap-1.5 px-1.5 @min-[480px]:col-span-2">
          <button
            type="button"
            data-testid="image-gen-ft-clear"
            className="cursor-pointer rounded-md px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1"
            onClick={() => clearFineTuningDraft(chatId)}
          >
            {t("image_gen_chip_clear")}
          </button>
          <button
            type="button"
            data-testid="image-gen-ft-generate"
            aria-disabled={generateDisabled}
            disabled={generateDisabled}
            title={freeBlocked ? t("image_gen_free_hint") : undefined}
            onClick={fireGenerate}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-3 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? (
              <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            ) : (
              <Icons.sparkles />
            )}
            {t("image_gen_chip_generate")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Per-model settings accordion (IG-CF15 15d) ─────────────────────────

/** The loaded model's overlay editor — the chip's «quick pult» view of the
 *  same data the providers pane edits (one source of truth, two surfaces).
 *  Fields mirror the pane's advanced section contract: slider cells display
 *  the range-min anchor for an unset field and commit on interaction; seed
 *  stays a plain optional numeric cell (empty = inherit). The ADetailer
 *  accordion NESTS INSIDE this accordion's body (owner 2026-09-17) and is
 *  hidden entirely unless the profile's server reports the extension. */
function ImageGenModelSettingsAccordion({
  profileId,
  modelId,
  supportsSamplers,
  samplers,
  backend,
  modelTemplate,
  disabled,
}: {
  profileId: string;
  modelId: string;
  supportsSamplers: boolean;
  samplers: ImageGenSamplerInfoValue[];
  /** The profile's backend discriminator (CG-B2) — ONE prop, the pane's
   *  guard trio derived inside: a1111 (extensions probe → ADetailer), the
   *  local family a1111+comfyui (scheduler catalog), comfyui (DiT
   *  sidecars). Booleans would permit stale combos; the enum cannot. */
  backend: ImageGenBackendValue;
  /** The picked model's workflow-template marker (comfyui dialect, from the
   *  chip body's fetched models list) — gates the DiT sidecar rows. */
  modelTemplate?: string;
  disabled: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [adOpen, setAdOpen] = useState(false);
  const [kreaOpen, setKreaOpen] = useState(false);
  const [overlay, setOverlay] = useState<ImageGenModelSettingsOverlayValue | null>(null);
  const [extensions, setExtensions] = useState<string[] | null>(null);
  // IF-6 (comfy dialect): null = probe pending or failed (block hidden);
  // a settled array (possibly empty) = the probe answered.
  const [faceDetectors, setFaceDetectors] = useState<string[] | null>(null);
  const [schedulers, setSchedulers] = useState<ImageGenSchedulerInfoValue[] | null>(null);
  const [saveError, setSaveError] = useState(false);
  // DiT sidecar lists (CG-B2, comfyui + krea2-dit only): null = not fetched
  // yet; a settled list/failure survives gate flips (fetched ONCE per
  // profile while the accordion lives — the pane's one-shot cache fill).
  const [sidecars, setSidecars] = useState<ImageGenDitSidecars | null>(null);
  const [sidecarsFailed, setSidecarsFailed] = useState(false);

  const isA1111 = backend === IMAGE_GEN_BACKENDS.A1111;
  const isComfy = backend === IMAGE_GEN_BACKENDS.ComfyUI;
  // The LOCAL dialect family (CG-B2 — the pane's guardIsLocalDialect twin):
  // both dialects serve the schedulers route (PG-3/CG-A3).
  const isLocalDialect =
    backend === IMAGE_GEN_BACKENDS.A1111 || backend === IMAGE_GEN_BACKENDS.ComfyUI;
  const isDit = backend === IMAGE_GEN_BACKENDS.ComfyUI && modelTemplate === "krea2-dit";
  // Krea 2 generative controls (IF-11) — the krea backend's OWN models
  // only (krea/krea-2/*; the aggregator's third-party models have no
  // creativity/slider surface — the backend filters by schema anyway).
  const isKreaTwo = backend === IMAGE_GEN_BACKENDS.Krea && modelId.startsWith("krea/");

  // Overlay load — keyed by (profileId, modelId); null until first load.
  useEffect(() => {
    let cancelled = false;
    setOverlay(null);
    void getImageGenModelSettings(profileId, modelId)
      .then((row) => {
        if (!cancelled) setOverlay(row?.settings ?? {});
      })
      .catch(() => {
        if (!cancelled) setOverlay({});
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, modelId]);

  // Extension probe — A1111 dialect only; a failed probe hides ADetailer
  // (feature absence, not an error surface).
  useEffect(() => {
    if (!isA1111) {
      setExtensions(null);
      return;
    }
    let cancelled = false;
    setExtensions(null);
    void listImageGenExtensions(profileId)
      .then((names) => {
        if (!cancelled) setExtensions(names ?? []);
      })
      .catch(() => {
        if (!cancelled) setExtensions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, isA1111]);

  // Face-detector chain probe (IF-6) — ComfyUI dialect only: the Impact
  // Pack chain (FaceDetailer node + face bbox models) discovered live. A
  // FAILED probe hides the block (the extensions precedent); an ANSWERED
  // probe with an empty list renders it disabled + hint (the plan's honest
  // unavailable ruling — the extension probe has no such twin because
  // absence there is just absence).
  useEffect(() => {
    if (!isComfy) {
      setFaceDetectors(null);
      return;
    }
    let cancelled = false;
    setFaceDetectors(null);
    void listImageGenFaceDetectors(profileId)
      .then((detectors) => {
        if (!cancelled) setFaceDetectors(detectors ?? []);
      })
      .catch(() => {
        if (!cancelled) setFaceDetectors(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, isComfy]);

  // Scheduler list (PG-3/CG-B2) — the schedule-type catalog for the dropdown
  // next to the sampler, on the LOCAL dialect family (a1111 + comfyui —
  // the pane's gate; both dialects serve the schedulers route); fetched on
  // the accordion's own profile (the extensions-probe twin — failure =
  // empty options, not an error).
  useEffect(() => {
    if (!isLocalDialect) {
      setSchedulers(null);
      return;
    }
    let cancelled = false;
    setSchedulers(null);
    void listImageGenSchedulers(profileId)
      .then((list) => {
        if (!cancelled) setSchedulers(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setSchedulers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, isLocalDialect]);

  // DiT sidecar lists (CG-B2): reset on profile switch (the overlay-load
  // twin), then fill ONCE while the DiT rows are visible — a settled
  // list/failure is never refetched within the profile (the pane's one-shot
  // cache-fill rule). Failure = the failed hint, not a crash (the loras
  // precedent).
  useEffect(() => {
    setSidecars(null);
    setSidecarsFailed(false);
  }, [profileId]);
  useEffect(() => {
    if (!isDit || sidecars !== null || sidecarsFailed) return;
    let cancelled = false;
    void listImageGenDitSidecars(profileId)
      .then((row) => {
        if (!cancelled) setSidecars(row ?? { encoders: [], vaes: [] });
      })
      .catch(() => {
        if (!cancelled) setSidecarsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, isDit, sidecars, sidecarsFailed]);

  const hasAdetailer =
    isA1111
      ? extensions !== null && hasAdetailerExtension(extensions)
      : faceDetectors !== null && faceDetectors.length > 0;
  // IF-6 (comfy dialect): the probe ANSWERED but the Impact Pack chain is
  // absent — the block renders as a disabled label + the install hint
  // (the plan's "honestly unavailable" ruling), never silently missing.
  const adetailerUnavailable =
    !isA1111 && faceDetectors !== null && faceDetectors.length === 0;
  // The picker vocabulary (IF-6): the A1111 twin keeps its static preset
  // list (the extension validates server-side); comfy rides the DISCOVERED
  // face bbox models — one code path per dialect, same overlay fields.
  const adetailerOptions = isA1111
    ? IMAGE_GEN_ADETAILER_FACE_MODELS.map((m) => ({ id: m, label: m }))
    : (faceDetectors ?? []).map((m) => ({ id: m, label: m }));
  const adetailerFallback = isA1111
    ? IMAGE_GEN_ADETAILER_DEFAULT_MODEL
    : (faceDetectors ?? [])[0] ?? "";

  /** Merge a patch into the overlay and persist it (the overlay row is the
   *  whole truth — every edit writes the full merged settings; an undefined
   *  patch value clears the field back to inherit — JSON drops the key). */
  function commit(patch: Partial<ImageGenModelSettingsOverlayValue>) {
    setOverlay((prev) => {
      const next = { ...(prev ?? {}), ...patch };
      void upsertImageGenModelSettings(profileId, modelId, next)
        .then(() => setSaveError(false))
        .catch(() => setSaveError(true));
      return next;
    });
  }

  if (overlay === null) {
    return (
      <div className="flex h-8 items-center justify-center px-1.5" data-testid="image-gen-ft-model-settings-loading">
        <span className="text-[calc(var(--ui-fs)-3px)] text-t3">…</span>
      </div>
    );
  }

  const steps = overlay.steps;
  const cfgScale = overlay.cfgScale;
  const clipSkip = overlay.clipSkip;
  const seed = overlay.seed;
  const sampler = overlay.sampler;
  const scheduler = overlay.scheduler;
  const encoderName = overlay.encoderName;
  const vaeName = overlay.vaeName;
  const adetailer = overlay.adetailer === true;
  const adetailerModel = overlay.adetailerModel;

  // T1 (TWIN_UNIFICATION step 1): the sampler dropdown's definition —
  // gate, options, label, commit — lives in model-controls; this surface
  // keeps only the renderer (one data source, many consumers).
  const samplerControl = buildSamplerControl({
    supportsSamplers,
    samplers,
  });

  return (
    <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-model-settings">
      <button
        type="button"
        data-testid="image-gen-ft-model-settings-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between rounded-md px-1.5 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
      >
        <span>{t("image_gen_model_settings")}</span>
        <Icons.Caret direction={open ? "d" : "u"} />
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-1.5" data-testid="image-gen-ft-model-settings-body">
          {samplerControl && (
            <div className="flex flex-col gap-1.5">
              <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t(samplerControl.labelKey)}</span>
              <DropdownSelect
                value={sampler ?? ""}
                options={translateModelOptions(samplerControl.options, t)}
                onChange={(id) => commit(samplerControl.commit(id))}
                disabled={disabled}
                triggerTestId="image-gen-ft-overlay-sampler"
              />
            </div>
          )}

          {/* Schedule type (PG-3/CG-B2) — right under the sampler, on the
              LOCAL dialect family (a1111 + comfyui — both serve the
              schedulers route; cloud dialects have no scheduler surface).
              Empty = the server's own default; commits the overlay like
              every field here (one source of truth with the pane). */}
          {isLocalDialect && (
            <div className="flex flex-col gap-1.5">
              <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_scheduler_label")}</span>
              <DropdownSelect
                value={scheduler ?? ""}
                options={[
                  { id: "", label: t("image_gen_sampler_auto") },
                  ...(schedulers ?? []).map((s) => ({ id: s.name, label: s.label ?? s.name })),
                ]}
                onChange={(id) => commit(id === "" ? { scheduler: undefined } : { scheduler: id })}
                disabled={disabled}
                triggerTestId="image-gen-ft-overlay-scheduler"
              />
            </div>
          )}

          {/* DiT sidecar fields (CG-B2, comfyui + krea2-dit only — the
              pane's DiT rows in the popover's vertical-stack idiom (the
              popover's w-full form-shaped triggers are correct here):
              text encoder + VAE ride the SAME per-model overlay the pane
              edits. Auto = the adapter's canonical resolution (CF5's honest
              Auto, not a hidden default — the {id: ""} entry drives the
              unset trigger, `defaultOption` is the pickable list entry);
              a stored value outside the live list stays pickable (the
              since-removed-files rule). */}
          {isDit && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_encoder_label")}</span>
                <DropdownSelect
                  value={encoderName ?? ""}
                  defaultOption={t("image_gen_sidecar_auto")}
                  options={[
                    { id: "", label: t("image_gen_sidecar_auto") },
                    ...(sidecars?.encoders ?? []).map((name) => ({ id: name, label: name })),
                    ...(encoderName !== undefined && !(sidecars?.encoders ?? []).includes(encoderName)
                      ? [{ id: encoderName, label: encoderName }]
                      : []),
                  ]}
                  onChange={(id) => commit(id === "" ? { encoderName: undefined } : { encoderName: id })}
                  disabled={disabled}
                  triggerTestId="image-gen-ft-overlay-encoder"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_vae_label")}</span>
                <DropdownSelect
                  value={vaeName ?? ""}
                  defaultOption={t("image_gen_sidecar_auto")}
                  options={[
                    { id: "", label: t("image_gen_sidecar_auto") },
                    ...(sidecars?.vaes ?? []).map((name) => ({ id: name, label: name })),
                    ...(vaeName !== undefined && !(sidecars?.vaes ?? []).includes(vaeName)
                      ? [{ id: vaeName, label: vaeName }]
                      : []),
                  ]}
                  onChange={(id) => commit(id === "" ? { vaeName: undefined } : { vaeName: id })}
                  disabled={disabled}
                  triggerTestId="image-gen-ft-overlay-vae"
                />
              </div>
              {sidecarsFailed && (
                <span
                  data-testid="image-gen-ft-sidecars-failed"
                  className="px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4"
                >
                  {t("image_gen_sidecars_failed")}
                </span>
              )}
            </>
          )}

          <SliderField
            label={t("image_gen_steps_label")}
            value={steps ?? IMAGE_GEN_PARAM_RANGES.steps.min}
            min={IMAGE_GEN_PARAM_RANGES.steps.min}
            max={IMAGE_GEN_PARAM_RANGES.steps.max}
            step={IMAGE_GEN_PARAM_RANGES.steps.step}
            onChange={(value) => commit({ steps: value })}
            disabled={disabled}
            rangeTestId="image-gen-range-overlay-steps"
          />
          <SliderField
            label={t("image_gen_cfg_label")}
            value={cfgScale ?? IMAGE_GEN_PARAM_RANGES.cfgScale.min}
            min={IMAGE_GEN_PARAM_RANGES.cfgScale.min}
            max={IMAGE_GEN_PARAM_RANGES.cfgScale.max}
            step={IMAGE_GEN_PARAM_RANGES.cfgScale.step}
            onChange={(value) => commit({ cfgScale: value })}
            disabled={disabled}
            rangeTestId="image-gen-range-overlay-cfg"
          />
          <SliderField
            label={t("image_gen_clip_skip_label")}
            value={clipSkip ?? IMAGE_GEN_PARAM_RANGES.clipSkip.min}
            min={IMAGE_GEN_PARAM_RANGES.clipSkip.min}
            max={IMAGE_GEN_PARAM_RANGES.clipSkip.max}
            step={IMAGE_GEN_PARAM_RANGES.clipSkip.step}
            onChange={(value) => commit({ clipSkip: value })}
            disabled={disabled}
            rangeTestId="image-gen-range-overlay-clip"
          />

          <div className="flex flex-col gap-1.5">
            <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_seed_label")}</span>
            <TextInput
              value={seed === undefined ? "" : String(seed)}
              onChange={(e) => {
                const raw = e.target.value.trim();
                commit(raw === "" || Number.isNaN(Number(raw)) ? { seed: undefined } : { seed: Number(raw) });
              }}
              placeholder="—"
              disabled={disabled}
              aria-label={t("image_gen_seed_label")}
              data-testid="image-gen-ft-overlay-seed"
            />
          </div>

          {saveError && (
            <span className="text-[calc(var(--ui-fs)-3px)] text-danger">{t("image_gen_overlay_save_failed")}</span>
          )}

          {/* Krea 2 generative controls (IF-11) — nested accordion (the
              ADetailer idiom) on the krea backend's own models only.
              Creativity defaults to the POLICY value "raw" (authored
              full-form prompts — the vendor default would expand them);
              sliders default to 0 which IS the vendor-neutral unsent —
              every field still commits the overlay like its neighbors. */}
          {isKreaTwo && (
            <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-krea">
              <button
                type="button"
                data-testid="image-gen-ft-krea-header"
                aria-expanded={kreaOpen}
                onClick={() => setKreaOpen((v) => !v)}
                className="flex w-full cursor-pointer items-center justify-between rounded-md border border-border bg-s3 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
              >
                <span>{t("image_gen_krea_section")}</span>
                <Icons.Caret direction={kreaOpen ? "d" : "u"} />
              </button>
              {kreaOpen && (
                <div className="flex flex-col gap-2 px-0.5" data-testid="image-gen-ft-krea-body">
                  <div className="flex flex-col gap-1.5">
                    <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_krea_creativity")}</span>
                    <SegmentedControl
                      value={overlay.krea?.creativity ?? "raw"}
                      options={[
                        { value: "raw", label: t("image_gen_krea_creativity_raw") },
                        { value: "low", label: t("image_gen_krea_creativity_low") },
                        { value: "medium", label: t("image_gen_krea_creativity_medium") },
                        { value: "high", label: t("image_gen_krea_creativity_high") },
                      ]}
                      onChange={(value) => commit({ krea: { ...(overlay.krea ?? {}), creativity: value } })}
                      disabled={disabled}
                      wrap
                      mobileFill
                      mobileSelect
                      ariaLabel={t("image_gen_krea_creativity")}
                    />
                  </div>
                  <SliderField
                    label={t("image_gen_krea_intensity")}
                    value={overlay.krea?.intensity ?? 0}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(value) => commit({ krea: { ...(overlay.krea ?? {}), intensity: value } })}
                    disabled={disabled}
                    rangeTestId="image-gen-range-krea-intensity"
                  />
                  <SliderField
                    label={t("image_gen_krea_complexity")}
                    value={overlay.krea?.complexity ?? 0}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(value) => commit({ krea: { ...(overlay.krea ?? {}), complexity: value } })}
                    disabled={disabled}
                    rangeTestId="image-gen-range-krea-complexity"
                  />
                  <SliderField
                    label={t("image_gen_krea_movement")}
                    value={overlay.krea?.movement ?? 0}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(value) => commit({ krea: { ...(overlay.krea ?? {}), movement: value } })}
                    disabled={disabled}
                    rangeTestId="image-gen-range-krea-movement"
                  />
                </div>
              )}
            </div>
          )}

          {/* ADetailer — NESTED inside the samplers accordion (owner
              2026-09-17); the whole block is hidden unless the server
              reports the chain (A1111: the extension probe; comfy: the
              discovered face bbox models, IF-6). A comfy probe that ANSWERED
              empty renders the disabled label + install hint instead. */}
          {adetailerUnavailable ? (
            <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-adetailer">
              <div className="flex w-full items-center justify-between rounded-md border border-border bg-s3 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t3">
                <span>{t("image_gen_adetailer")}</span>
              </div>
              <span
                className="font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-t3"
                data-testid="image-gen-ft-adetailer-missing"
              >
                {t("image_gen_adetailer_missing_hint")}
              </span>
            </div>
          ) : hasAdetailer && (
            <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-adetailer">
              <button
                type="button"
                data-testid="image-gen-ft-adetailer-header"
                aria-expanded={adOpen}
                onClick={() => setAdOpen((v) => !v)}
                className="flex w-full cursor-pointer items-center justify-between rounded-md border border-border bg-s3 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
              >
                <span>{t("image_gen_adetailer")}</span>
                <Icons.Caret direction={adOpen ? "d" : "u"} />
              </button>
              {adOpen && (
                <div className="flex flex-col gap-2 px-0.5" data-testid="image-gen-ft-adetailer-body">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t2">{t("image_gen_adetailer")}</span>
                    <Toggle
                      checked={adetailer}
                      onChange={(checked) => commit({ adetailer: checked })}
                      disabled={disabled}
                      aria-label={t("image_gen_adetailer")}
                    />
                  </div>
                  {adetailer && (
                    <div className="flex flex-col gap-1.5">
                      <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_adetailer_model")}</span>
                      <DropdownSelect
                        value={adetailerModel ?? adetailerFallback}
                        options={adetailerOptions}
                        onChange={(id) => commit({ adetailerModel: id })}
                        disabled={disabled}
                        triggerTestId="image-gen-ft-adetailer-model"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
