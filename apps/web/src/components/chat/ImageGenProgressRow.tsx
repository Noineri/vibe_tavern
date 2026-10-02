/**
 * In-flight generation progress row (IMAGE_GENERATION_PLAN PG-2 + MR-11's
 * honest phase timeline) — the launcher-bar pill next to the Fine-tuning
 * chip. Renders ONLY while the chat has a run outstanding
 * (`runningByChat`), for every generation start (menu or future surfaces),
 * regardless of the Fine-tuning toggle.
 *
 * MR-11 phase timeline — the pill narrates the run from the button press:
 * - "prompt" phase → "Writing prompt…" (the LLM assist is composing the
 *   prompt — both local and cloud runs show it);
 * - "starting" phase (and the pre-first-tick gap) → "Starting…" — queue /
 *   model load / warmup, never an inherited percent from a previous run;
 * - "steps" phase on a live-progress run → the thin step bar + "42% · ~7s"
 *   + the optional live-preview thumb (`current_image`, present only when
 *   the server produces previews);
 * - cloud runs past the prompt phase → the plain "Generating…" pulse
 *   (cloud backends have no steps surface; no fake percent, ever).
 *
 * IF-9 (owner 2026-09-22, locked): the pill's TAIL carries the explicit
 * Stop control — cancel sits where the generation is visible, in every
 * phase (prompt/starting/steps alike; local backends have NO timeout,
 * cancel is the only limit — the owner 2026-09-14 capability ruling that
 * first created Stop). The message-menu trigger no longer morphs; it
 * renders as itself, disabled, while a run is in flight.
 */

import { useState } from "react";

import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useImageGenProgress } from "../../hooks/use-image-gen-progress.js";
import { useT } from "../../i18n/context.js";

export interface ImageGenProgressRowProps {
  chatId: string;
}

export function ImageGenProgressRow({ chatId }: ImageGenProgressRowProps) {
  const { t } = useT();
  const run = useImageGenChatStore((s) => s.runningByChat[chatId]);
  const abortGeneration = useImageGenChatStore((s) => s.abortGeneration);
  // Poll for ANY active run (MR-11): the phase timeline is backend-agnostic
  // — cloud runs surface their prompt/starting phases through the same
  // endpoint; the steps fields arrive only for live-progress dialects (the
  // global-per-instance cross-talk constraint still gates the backend read
  // server-side: outside a run nothing is ever requested).
  const snapshot = useImageGenProgress(run !== undefined, run?.profileId ?? null);
  // A preview thumb that fails to decode hides itself instead of leaving a
  // broken image box (the wire preview's mime is not documented — render,
  // degrade quietly).
  const [previewHidden, setPreviewHidden] = useState(false);

  if (run === undefined) return null;

  const phase = snapshot?.phase;
  const showSteps = run.liveProgress && phase !== "prompt" && phase !== "starting" && snapshot !== null;
  const percent = snapshot?.progress !== undefined ? Math.round(snapshot.progress * 100) : 0;
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
      {phase === "prompt" ? (
        <PhasePulse label={t("image_gen_phase_prompt")} />
      ) : !run.liveProgress ? (
        <span className="flex items-center gap-1.5 text-accent animate-pulse">
          <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          {t("image_gen_generating")}
        </span>
      ) : showSteps ? (
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
        <PhasePulse label={t("image_gen_phase_starting")} />
      )}
      {/* IF-9: the run's own Stop — the pill tail, present in EVERY phase. */}
      <CustomTooltip content={t("image_gen_stop_tooltip")}>
        <button
          type="button"
          data-testid="image-gen-progress-stop"
          aria-label={t("image_gen_stop_tooltip")}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-accent transition-colors hover:bg-s2 [&_svg]:h-[18px] [&_svg]:w-[18px]"
          onClick={() => abortGeneration(chatId)}
        >
          <Icons.stopSquare />
        </button>
      </CustomTooltip>
    </div>
  );
}

/** A phase label inside the pill — the "Writing prompt…" / "Starting…"
 *  narration states (MR-11). Same pulse idiom as the cloud "Generating…"
 *  state, so all three non-steps states read as one family. */
function PhasePulse({ label }: { label: string }) {
  return (
    <span data-testid="image-gen-progress-phase" className="flex items-center gap-1.5 text-accent animate-pulse">
      <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
      {label}
    </span>
  );
}
