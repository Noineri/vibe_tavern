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
 * profile + model pick, sampler (only when the profile's capabilities
 * `supportsSamplers`), positive prompt, negative prompt (only when
 * `supportsNegativePrompt` — the IG-13 gate). Everything edits the per-chat
 * draft in the image-gen chat store; the message popover folds the draft
 * into the NEXT generation's payload (positive → verbatim `prompt`, picks +
 * negative → `overrides`).
 */

import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { Icons } from "../shared/icons.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { SliderField } from "../shared/SliderField.js";
import { Toggle } from "../shared/Toggle.js";
import { TextInput } from "../shared/text-input.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { lblCls } from "../../lib/field-tokens.js";
import { cn } from "../../lib/cn.js";
import { templateDisplayLabel } from "../../lib/imagegen/template-labels.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import {
  listAllImageGenProfiles,
  listImageGenModels,
  listImageGenSamplers,
  listImageGenSchedulers,
  listImageGenExtensions,
  listImageGenLoras,
  listImageGenDitSidecars,
  getImageGenModelSettings,
  upsertImageGenModelSettings,
  type ImageGenModelEntry,
  type ImageGenProfileRecord,
  type ImageGenLora,
  type ImageGenDitSidecars,
} from "../../api/image-gen-api.js";
import type { ImageGenSamplerInfoValue, ImageGenSchedulerInfoValue, ImageGenModelSettingsOverlayValue, ImageGenBackendValue } from "@vibe-tavern/api-contracts";
import {
  IMAGE_GEN_BACKENDS,
  IMAGE_GEN_PARAM_RANGES,
  IMAGE_GEN_ADETAILER_FACE_MODELS,
  IMAGE_GEN_ADETAILER_DEFAULT_MODEL,
  hasAdetailerExtension,
} from "@vibe-tavern/domain";
import { EMPTY_IMAGE_GEN_DRAFT, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { ImageGenLoraSection } from "./ImageGenLoraSection.js";

export interface ImageGenFineTuningChipProps {
  chatId: string;
}

export function ImageGenFineTuningChip({ chatId }: ImageGenFineTuningChipProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const fineTuning = useImageGenChatStore((s) => s.fineTuningByChat[chatId] ?? false);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId]);
  const [open, setOpen] = useState(false);

  if (!fineTuning) return null;

  const hasPrompt = (draft?.prompt.trim() ?? "") !== "";

  const body = <ImageGenFineTuningBody chatId={chatId} />;

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
            className="glass-blur z-[220] flex max-h-[70vh] w-[300px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border2 bg-glass-bg p-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
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

function ImageGenFineTuningBody({ chatId }: { chatId: string }) {
  const { t } = useT();
  const activeProfileId = useImageGenChatStore((s) => s.activeProfileIdByChat[chatId]);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setActiveProfile = useImageGenChatStore((s) => s.setActiveProfile);
  const setFineTuningDraft = useImageGenChatStore((s) => s.setFineTuningDraft);
  const clearFineTuningDraft = useImageGenChatStore((s) => s.clearFineTuningDraft);
  const running = useImageGenChatStore((s) => s.runningByChat[chatId]);

  const [profiles, setProfiles] = useState<ImageGenProfileRecord[] | null>(null);
  const [models, setModels] = useState<ImageGenModelEntry[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [samplers, setSamplers] = useState<ImageGenSamplerInfoValue[] | null>(null);
  const [loras, setLoras] = useState<ImageGenLora[] | null>(null);
  const [lorasFailed, setLorasFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listAllImageGenProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effective = profiles?.find((p) => p.id === activeProfileId) ?? profiles?.[0] ?? null;
  const effectiveId = effective?.id ?? null;
  const caps = effective?.capabilities ?? null;
  const supportsSamplers = caps?.supportsSamplers ?? false;
  const supportsNegative = caps?.supportsNegativePrompt ?? false;
  const supportsLoras = caps?.supportsLoras ?? false;

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

  if (profiles === null) {
    return (
      <div className="flex h-16 items-center justify-center px-3 text-[calc(var(--ui-fs)-2px)] text-t3">…</div>
    );
  }

  const busy = running !== undefined;

  // The LoRA section's auto-preselect anchor: the family of the model this
  // generation will actually run (the draft's pick, else the profile's).
  const effectiveModelId = draft.model ?? effective?.modelId;
  const modelFamily = models?.find((m) => m.id === effectiveModelId)?.family;
  // The PICKED model's own cache entry (comfyui dialect enrichment, CG-B2 —
  // the pane's selectedModelEntry twin): its `template` marker drives the
  // «Detected» readout under the picker and the accordion's DiT gate.
  const selectedModelEntry = models?.find((m) => m.id === draft.model) ?? null;

  return (
    <div className="flex flex-col gap-2.5 p-1" data-testid="image-gen-ft-body">
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

      {supportsSamplers && (
        <div className="flex flex-col gap-1.5 px-1.5" data-testid="image-gen-ft-sampler-row">
          <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_sampler_label")}</span>
          <DropdownSelect
            value={draft.sampler ?? ""}
            options={[
              { id: "", label: t("image_gen_sampler_auto") },
              ...(samplers ?? []).map((s) => ({ id: s.name, label: s.name })),
            ]}
            onChange={(id) => setFineTuningDraft(chatId, { sampler: id === "" ? undefined : id })}
            triggerTestId="image-gen-ft-sampler-select"
            disabled={busy || samplers === null}
          />
        </div>
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

      <div className="flex justify-end px-1.5">
        <button
          type="button"
          data-testid="image-gen-ft-clear"
          className="cursor-pointer rounded-md px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1"
          onClick={() => clearFineTuningDraft(chatId)}
        >
          {t("image_gen_chip_clear")}
        </button>
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
  const [overlay, setOverlay] = useState<ImageGenModelSettingsOverlayValue | null>(null);
  const [extensions, setExtensions] = useState<string[] | null>(null);
  const [schedulers, setSchedulers] = useState<ImageGenSchedulerInfoValue[] | null>(null);
  const [saveError, setSaveError] = useState(false);
  // DiT sidecar lists (CG-B2, comfyui + krea2-dit only): null = not fetched
  // yet; a settled list/failure survives gate flips (fetched ONCE per
  // profile while the accordion lives — the pane's one-shot cache fill).
  const [sidecars, setSidecars] = useState<ImageGenDitSidecars | null>(null);
  const [sidecarsFailed, setSidecarsFailed] = useState(false);

  const isA1111 = backend === IMAGE_GEN_BACKENDS.A1111;
  // The LOCAL dialect family (CG-B2 — the pane's guardIsLocalDialect twin):
  // both dialects serve the schedulers route (PG-3/CG-A3).
  const isLocalDialect =
    backend === IMAGE_GEN_BACKENDS.A1111 || backend === IMAGE_GEN_BACKENDS.ComfyUI;
  const isDit = backend === IMAGE_GEN_BACKENDS.ComfyUI && modelTemplate === "krea2-dit";

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

  const hasAdetailer = extensions !== null && hasAdetailerExtension(extensions);

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
          {supportsSamplers && (
            <div className="flex flex-col gap-1.5">
              <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_sampler_label")}</span>
              <DropdownSelect
                value={sampler ?? ""}
                options={[
                  { id: "", label: t("image_gen_sampler_auto") },
                  ...samplers.map((s) => ({ id: s.name, label: s.name })),
                ]}
                onChange={(id) => commit(id === "" ? { sampler: undefined } : { sampler: id })}
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
              pane's DiT rows in the popover's vertical-stack idiom; the
              300px popover makes w-full form-shaped triggers correct here):
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

          {/* ADetailer — NESTED inside the samplers accordion (owner
              2026-09-17); the whole block is hidden unless the server
              reports the extension. */}
          {hasAdetailer && (
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
                        value={adetailerModel ?? IMAGE_GEN_ADETAILER_DEFAULT_MODEL}
                        options={IMAGE_GEN_ADETAILER_FACE_MODELS.map((m) => ({ id: m, label: m }))}
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
