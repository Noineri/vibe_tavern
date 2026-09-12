/**
 * Kokoro engine-model panel — variant picker + the explicit download button.
 *
 * Owner decision 2026-08-28: the download/compute trade-off is a USER choice,
 * two human-worded options (not dtype jargon):
 * - gpu: full model on WebGPU (~310 MB, fast — needs a WebGPU browser);
 * - cpu: lightweight model on the CPU (~90 MB, may be slower).
 * The gpu card shows a "Recommended" badge when WebGPU is available and a
 * disabled "not available in this browser" state when it is not. From the
 * ready state the variant can be switched (disposes the old model; the
 * browser cache keeps both copies).
 *
 * States: idle → picker + [Скачать модель]; downloading → progress bar with
 * live % and MB counters (aggregated per-file transformers events via
 * useKokoroModel); ready → check + active variant + [Сменить вариант]; error
 * → danger text + Retry. A gpu→cpu fallback surfaces as a warning line. The
 * panel and the preview share the client singleton, so a download started
 * here is joined (never duplicated) by an impatient Preview click.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useT } from "../../../../i18n/context.js";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useTtsPreview } from "./use-tts-preview.js";
import { Ic } from "../../../shared/icons.js";
import {
  autoKokoroVariant,
  KOKORO_VARIANTS,
  readStoredKokoroVariant,
  type KokoroModelVariant,
} from "../../../../lib/tts/kokoro/kokoro-load-options.js";
import { useKokoroModel } from "./use-kokoro-model.js";

const VARIANT_LABEL_KEYS = {
  gpu: "tts_kokoro_variant_gpu_name",
  cpu: "tts_kokoro_variant_cpu_name",
} as const;

function VariantCards({
  selected,
  onSelect,
  webgpuAvailable,
}: {
  selected: KokoroModelVariant;
  onSelect: (variant: KokoroModelVariant) => void;
  webgpuAvailable: boolean;
}): ReactNode {
  const { t } = useT();
  // Available option first; the unavailable gpu card drops to the end.
  const order: KokoroModelVariant[] = webgpuAvailable ? ["gpu", "cpu"] : ["cpu", "gpu"];
  return (
    <div className="flex flex-col gap-1.5" data-testid="tts-kokoro-variant-list">
      {order.map((id) => {
        const info = KOKORO_VARIANTS[id];
        const available = id !== "gpu" || webgpuAvailable;
        const isSelected = selected === id;
        return (
          <button
            key={id}
            type="button"
            data-testid={`tts-kokoro-variant-${id}`}
            disabled={!available}
            onClick={() => onSelect(id)}
            className={
              isSelected
                ? "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-accent bg-s2 px-3 py-2 text-left"
                : "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border bg-s1 px-3 py-2 text-left hover:bg-s2 disabled:pointer-events-none disabled:opacity-50"
            }
          >
            <span className="flex items-center gap-2 font-ui text-[12px] text-t1">
              {t(VARIANT_LABEL_KEYS[id])}
              {id === "gpu" && webgpuAvailable && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 font-ui text-[10px] text-accent">
                  {t("tts_kokoro_variant_recommended")}
                </span>
              )}
            </span>
            <span className="font-ui text-[11px] text-t3">
              {t(id === "gpu" ? "tts_kokoro_variant_gpu_hint" : "tts_kokoro_variant_cpu_hint")} ·{" "}
              {t("tts_kokoro_variant_size", { mb: info.approxMb })}
            </span>
            {!available && (
              <span className="font-ui text-[11px] text-t3">{t("tts_kokoro_variant_gpu_unavailable")}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function KokoroModelPanel() {
  const { t } = useT();
  const model = useKokoroModel();
  const preview = useTtsPreview();
  const prevStateRef = useRef(model.state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = model.state;
    if (prev === "downloading" && model.state === "ready" && preview.state === "idle") {
      preview.preview({
        backend: TTS_BACKEND.Kokoro,
        voiceId: "af_heart",
        speed: 1,
        config: null,
      });
    }
  }, [model.state, preview.state]);
  // "Switch variant" reveals the picker again from the ready state.
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<KokoroModelVariant>(
    () => readStoredKokoroVariant() ?? autoKokoroVariant(model.webgpuAvailable),
  );

  const downloadAndClose = (): void => {
    model.download(selected);
    setChoosing(false);
  };

  const picker = (
    <>
      <VariantCards selected={selected} onSelect={setSelected} webgpuAvailable={model.webgpuAvailable} />
      <button
        type="button"
        data-testid="tts-kokoro-model-download-btn"
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
        onClick={downloadAndClose}
      >
        <Ic.download />
        {t("tts_kokoro_model_download")}
      </button>
    </>
  );

  if (model.state === "ready") {
    return (
      <div data-testid="tts-kokoro-model-ready" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 font-ui text-[12px] text-t3">
          <Ic.check />
          {t("tts_kokoro_model_ready")}
        </div>
        {model.activeVariant !== null && (
          <div data-testid="tts-kokoro-model-active" className="font-ui text-[11px] text-t3">
            {t("tts_kokoro_model_active", { name: t(VARIANT_LABEL_KEYS[model.activeVariant]) })}
          </div>
        )}
        {model.fallbackNotice !== null && (
          <div data-testid="tts-kokoro-model-fallback" className="font-ui text-[11px] text-warning-text">
            {t("tts_kokoro_model_fell_back", { reason: model.fallbackNotice })}
          </div>
        )}
        {!choosing ? (
          <button
            type="button"
            data-testid="tts-kokoro-model-switch-btn"
            className="flex w-fit cursor-pointer items-center rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            onClick={() => setChoosing(true)}
          >
            {t("tts_kokoro_model_switch")}
          </button>
        ) : (
          picker
        )}
      </div>
    );
  }

  if (model.state === "downloading") {
    return (
      <div data-testid="tts-kokoro-model-downloading" className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 font-ui text-[11px] text-t3">
          <span>{t("tts_kokoro_model_downloading")}</span>
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
    <div className="flex flex-col gap-1.5" data-testid="tts-kokoro-model-idle">
      {picker}
      {model.state === "error" && (
        <div className="flex flex-col gap-1.5">
          <div data-testid="tts-kokoro-model-error" className="font-ui text-[11px] text-danger">
            {t("tts_kokoro_model_failed")}: {model.error}
          </div>
          <button
            type="button"
            data-testid="tts-kokoro-model-retry-btn"
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
