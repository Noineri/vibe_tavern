// NAI-6b: the image-gen prompt-family row (ImagePromptFamilyRow) plus its
// label/source-key helpers, the stock-set preselect resolver, and the
// dialect adaptation + note helpers — extracted from ImageGenPane.tsx for
// the file-size ratchet (a move, not a fork). The sampler-set editor and the
// shared primitives remain the pane's own surface.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT, type TFunc } from "../../../../i18n/context.js";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GEN_STOCK_SAMPLER_SET_IDS, adaptSamplerSetPayloadToTarget, type SetFieldNote } from "@vibe-tavern/domain";
import { Icons } from "../../../shared/icons.js";
import { CustomTooltip, TooltipProvider } from "../../../shared/Tooltip.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import type {
  ImageGenFamilyDetectionAttemptValue,
  ImageGenFamilyDetectionSourceValue,
  ImageGenSamplerSet,
  ImagePromptFamilyInfoValue,
  ImagePromptFamilyValue,
} from "@vibe-tavern/api-contracts";
import {
  detectImageGenProfileFamily,
  listImageGenSamplerSets,
  listImagePromptFamilies,
  setImageGenProfileFamily,
} from "../../../../api/image-gen-api.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

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

export function ImagePromptFamilyRow({ imageGen }: { imageGen: ImageGenHook }) {
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

  // NAI-6b: the backend's own default prompt family (the backend-default
  // resolution tier). Read from the STATIC capability table — the same
  // single source the server resolver reads (image-gen-adapter passes
  // IMAGE_GEN_BACKEND_CAPABILITIES[backend].defaultPromptFamily) — never
  // from the save-time capability mirror, which strips this field. The
  // PERSISTED profile's backend governs, matching the generation-time
  // resolver's read of the same persisted profile.
  const backendDefaultFamily = IMAGE_GEN_BACKEND_CAPABILITIES[record.backend].defaultPromptFamily ?? null;

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
        ) : backendDefaultFamily !== null ? (
          <>
            <span
              data-testid="image-gen-family-backend-default"
              className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium leading-[1.5] text-accent"
            >
              {tDynamic(familyLabelKey(backendDefaultFamily))}
            </span>
            <span className="font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-t3">
              {t("image_gen_family_source_backend-default")}
            </span>
          </>
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
export async function adaptSetPayloadForTarget(
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
export function composeSetFieldNotes(
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
