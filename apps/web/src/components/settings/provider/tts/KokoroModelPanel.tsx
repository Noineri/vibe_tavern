/**
 * Kokoro engine-model panel — the explicit download button (owner request:
 * "а может, просто сделать явную кнопку скачивания?").
 *
 * States: idle → [Скачать модель] (accent outline button); downloading →
 * progress bar with live % and MB counters (aggregated per-file transformers
 * events via useKokoroModel); ready → check + "Готово" (no re-download, the
 * model lives in CacheStorage); error → danger text + Retry. The panel and
 * the preview share the client singleton, so a download started here is
 * joined (never duplicated) by an impatient Preview click.
 */

import { useT } from "../../../../i18n/context.js";
import { Ic } from "../../../shared/icons.js";
import { useKokoroModel } from "./use-kokoro-model.js";

export function KokoroModelPanel() {
  const { t } = useT();
  const model = useKokoroModel();

  if (model.state === "ready") {
    return (
      <div data-testid="tts-kokoro-model-ready" className="flex items-center gap-1.5 font-ui text-[12px] text-t3">
        <Ic.check />
        {t("tts_kokoro_model_ready")}
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
    <div className="flex flex-col gap-1" data-testid="tts-kokoro-model-idle">
      <button
        type="button"
        data-testid="tts-kokoro-model-download-btn"
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
        onClick={model.download}
      >
        <Ic.download />
        {t("tts_kokoro_model_download")}
      </button>
      {model.state === "error" && (
        <div className="flex flex-col gap-1.5">
          <div data-testid="tts-kokoro-model-error" className="font-ui text-[11px] text-danger">
            {t("tts_kokoro_model_failed")}: {model.error}
          </div>
          <button
            type="button"
            data-testid="tts-kokoro-model-retry-btn"
            className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            onClick={model.download}
          >
            {t("retry")}
          </button>
        </div>
      )}
    </div>
  );
}
