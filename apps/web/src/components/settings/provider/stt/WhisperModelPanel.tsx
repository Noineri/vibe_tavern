/**
 * Whisper browser-model download panel (audit P5) — a VERBATIM VISUAL CLONE
 * of `KokoroModelPanel.tsx` (the TTS reference): roster cards + the explicit
 * download button. Level-1 connection-card surface (governing rule: the
 * card holds the endpoint OR the browser-model download) — the level-2
 * model PICK stays in SttRecognitionSection; this panel is the DOWNLOAD.
 *
 * Owner decision mirrored from the kokoro panel: the download/compute
 * trade-off is a USER choice rendered as roster cards with human metadata
 * (label, ~MB size, English-only badge, Default badge, one-line hint).
 *
 * States: idle → cards + [Скачать модель]; downloading → progress bar with
 * live % and MB counters (aggregated per-file transformers events via
 * useWhisperModel); ready → check + active model + [Сменить модель];
 * error → danger text + Retry (the stall-watchdog message rides the error
 * state). Download/Switch also PERSISTS the pick into the profile config
 * (the kokoro twin persists its variant choice; here the choice lives in
 * config.model, written through updateConfigField). Named deviations from
 * the kokoro twin (pre-approved, audit-scoped): no WebGPU gate / fallback
 * line (kokoro-only seams), no auto-preview effect (whisper has no preview
 * lane — dictation joins the in-flight load instead).
 */

import { useEffect, useState, type ReactNode } from "react";

import {
  DEFAULT_WHISPER_MODEL_ID,
  findWhisperModel,
  WHISPER_MODELS,
} from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { Ic } from "../../../shared/icons.js";
import { configString, updateConfigField } from "./stt-form-helpers.js";
import { useWhisperModel } from "./use-whisper-model.js";
import { currentWhisperLane } from "../../../../lib/stt/whisper-client-instance.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

/** Roster ids contain slashes/dots — slug them for stable testids. */
function slug(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ModelCards({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (modelId: string) => void;
}): ReactNode {
  const { t } = useT();
  const lane = currentWhisperLane();
  return (
    <div className="flex flex-col gap-1.5" data-testid="stt-whisper-model-list">
      {WHISPER_MODELS.map((info) => {
        const isSelected = selected === info.id;
        return (
          <button
            key={info.id}
            type="button"
            data-testid={`stt-whisper-model-${slug(info.id)}`}
            onClick={() => onSelect(info.id)}
            className={
              isSelected
                ? "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-accent bg-s2 px-3 py-2 text-left"
                : "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border bg-s1 px-3 py-2 text-left hover:bg-s2"
            }
          >
            <span className="flex items-center gap-2 font-ui text-[12px] text-t1">
              {info.label}
              {info.id === DEFAULT_WHISPER_MODEL_ID && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 font-ui text-[10px] text-accent">
                  {t("stt_whisper_model_default")}
                </span>
              )}
              {info.englishOnly && (
                <span className="rounded bg-s3 px-1.5 py-0.5 font-ui text-[10px] text-t3">
                  {t("stt_whisper_model_english_only")}
                </span>
              )}
              <span
                data-testid="stt-whisper-model-lane"
                className="rounded bg-s3 px-1.5 py-0.5 font-ui text-[10px] text-t3"
              >
                {t(lane === "webgpu" ? "stt_whisper_lane_gpu" : "stt_whisper_lane_cpu")}
              </span>
            </span>
            <span className="font-ui text-[11px] text-t3">
              {/* GPU lane (WebGPU → fp16) downloads a different, larger file
               *  set — the size hint must describe what will ACTUALLY land
               *  (owner 2026-09-05), and the lane badge says which one. */}
              {info.hint} ·{" "}
              {t("stt_whisper_model_size", { mb: lane === "webgpu" ? info.approxMbGpu : info.approxMb })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function WhisperModelPanel({
  form,
  stt,
}: {
  form: SttProfileForm;
  stt: Pick<SttHook, "setForm">;
}) {
  const { t } = useT();
  const model = useWhisperModel();
  // "Switch model" reveals the picker again from the ready state.
  const [choosing, setChoosing] = useState(false);
  const configured = configString(form.config, "model");
  const [selected, setSelected] = useState<string>(() =>
    findWhisperModel(configured) !== null ? configured : DEFAULT_WHISPER_MODEL_ID,
  );
  // Dual-writer resync (differs from the kokoro twin — it has ONE picker):
  // the level-2 roster dropdown also writes config.model. Follow it while
  // the user is NOT mid-choice here, so [Скачать модель] can never download
  // and persist a model the user already replaced in level 2.
  useEffect(() => {
    if (!choosing) {
      setSelected(findWhisperModel(configured) !== null ? configured : DEFAULT_WHISPER_MODEL_ID);
    }
  }, [configured, choosing]);

  const downloadAndClose = (): void => {
    updateConfigField(stt, form, "model", selected);
    model.download(selected);
    setChoosing(false);
  };

  const picker = (
    <>
      <ModelCards selected={selected} onSelect={setSelected} />
      <button
        type="button"
        data-testid="stt-whisper-model-download-btn"
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
        onClick={downloadAndClose}
      >
        <Ic.download />
        {t("stt_whisper_model_download")}
      </button>
    </>
  );

  if (model.state === "ready") {
    const activeInfo = model.activeModel !== null ? findWhisperModel(model.activeModel) : null;
    return (
      <div data-testid="stt-whisper-model-ready" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 font-ui text-[12px] text-t3">
          <Ic.check />
          {t("stt_whisper_model_ready")}
        </div>
        {model.activeModel !== null && (
          <div data-testid="stt-whisper-model-active" className="font-ui text-[11px] text-t3">
            {t("stt_whisper_model_active", { name: activeInfo?.label ?? model.activeModel })}
          </div>
        )}
        {!choosing ? (
          <button
            type="button"
            data-testid="stt-whisper-model-switch-btn"
            className="flex w-fit cursor-pointer items-center rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            onClick={() => setChoosing(true)}
          >
            {t("stt_whisper_model_switch")}
          </button>
        ) : (
          picker
        )}
      </div>
    );
  }

  if (model.state === "downloading") {
    return (
      <div data-testid="stt-whisper-model-downloading" className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 font-ui text-[11px] text-t3">
          <span>{t("stt_whisper_model_downloading")}</span>
          <span className="tabular-nums">
            {model.pct !== null ? `${model.pct}%` : ""}
            {model.loadedMb !== null && model.totalMb !== null ? ` · ${model.loadedMb} / ${model.totalMb} MB` : ""}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-s3">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${model.pct ?? 0}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="stt-whisper-model-idle">
      {picker}
      {model.state === "error" && (
        <div className="flex flex-col gap-1.5">
          <div data-testid="stt-whisper-model-error" className="font-ui text-[11px] text-danger">
            {t("stt_whisper_model_failed")}: {model.error}
          </div>
          <button
            type="button"
            data-testid="stt-whisper-model-retry-btn"
            className="flex w-fit cursor-pointer items-center rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            onClick={downloadAndClose}
          >
            {t("retry")}
          </button>
        </div>
      )}
    </div>
  );
}
