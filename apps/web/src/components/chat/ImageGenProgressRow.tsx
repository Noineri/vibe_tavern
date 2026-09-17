/**
 * In-flight generation progress row (IMAGE_GENERATION_PLAN PG-2) — the
 * launcher-bar pill next to the Fine-tuning chip. Renders ONLY while the
 * chat has a run outstanding (`runningByChat`), for every generation start
 * (menu or future surfaces), regardless of the Fine-tuning toggle.
 *
 * Two states by the run's START-time capability snapshot:
 * - live-progress run (A1111 dialect): the `/sdapi/v1/progress` poll drives
 *   a thin step bar + "42% · ~7s" + the optional live-preview thumb
 *   (`current_image`, present only when the server produces previews).
 * - cloud run: the plain "Generating…" pulse — cloud backends keep the
 *   current spinner (no progress APIs there; the polish report's
 *   constraint).
 *
 * Cloud backends have no progress surface, so the pill degrades to the
 * pulse rather than a fake 0%.
 */

import { useState } from "react";

import { useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useImageGenProgress } from "../../hooks/use-image-gen-progress.js";
import { useT } from "../../i18n/context.js";

export interface ImageGenProgressRowProps {
  chatId: string;
}

export function ImageGenProgressRow({ chatId }: ImageGenProgressRowProps) {
  const { t } = useT();
  const run = useImageGenChatStore((s) => s.runningByChat[chatId]);
  // Poll only while OUR run is in flight on a live-progress profile (the
  // global-per-instance cross-talk constraint lives in the hook gate).
  const snapshot = useImageGenProgress(run !== undefined, run?.liveProgress ? run.profileId : null);
  // A preview thumb that fails to decode hides itself instead of leaving a
  // broken image box (the wire preview's mime is not documented — render,
  // degrade quietly).
  const [previewHidden, setPreviewHidden] = useState(false);

  if (run === undefined) return null;

  const percent = snapshot !== null ? Math.round(snapshot.progress * 100) : 0;
  const etaSeconds = snapshot?.etaRelative !== undefined ? Math.round(snapshot.etaRelative) : null;
  const line = etaSeconds !== null ? `${percent}% · ~${etaSeconds}s` : `${percent}%`;
  const previewSrc = !previewHidden && snapshot?.previewBase64 !== undefined
    ? `data:image/png;base64,${snapshot.previewBase64}`
    : null;

  return (
    <div
      data-testid="image-gen-progress-row"
      aria-label={t("image_gen_generating")}
      className="glass-blur flex min-h-9 items-center gap-2 whitespace-nowrap rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 shadow-sm"
    >
      {run.liveProgress ? (
        <>
          <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-s3" data-testid="image-gen-progress-track">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              data-testid="image-gen-progress-bar"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span data-testid="image-gen-progress-line">{line}</span>
          {previewSrc !== null && (
            <img
              src={previewSrc}
              alt=""
              data-testid="image-gen-progress-preview"
              className="h-6 w-6 shrink-0 rounded-sm border border-border object-cover"
              onError={() => setPreviewHidden(true)}
            />
          )}
        </>
      ) : (
        <span className="flex items-center gap-1.5 text-accent animate-pulse">
          <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          {t("image_gen_generating")}
        </span>
      )}
    </div>
  );
}
