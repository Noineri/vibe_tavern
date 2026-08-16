/**
 * ExperiencePreview — the editor's disconnected visual preview (IR-63).
 *
 * Renders a {@link VisualStarter}'s source in an {@link ExperienceFrame} and
 * pushes one of its package-provided projected fixtures (setup / ordinary /
 * pending / error / completed) so an author can see how the visual looks across
 * every phase without playing a whole session. A phase switcher (trusted
 * chrome, outside the frame) picks the fixture.
 *
 * Disconnect invariant: preview actions NEVER reach a production session. The
 * frame's onAction is captured into a local preview log (the last clicked
 * action is shown under the frame), never forwarded to a store or the API. This
 * is what lets an author click around a starter safely — the preview is a
 * look-and-feel surface, not a live session. IR-71's real client store owns
 * authoritative actions; the preview deliberately does not.
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import type { FixturePhase, VisualStarter } from "./starters/types.js";

/** The phases the preview can show, in switcher order. */
export const PREVIEW_PHASES: readonly FixturePhase[] = [
  "setup",
  "ordinary",
  "pending",
  "error",
  "completed",
];

export interface ExperiencePreviewProps {
  readonly starter: VisualStarter;
  readonly initialPhase?: FixturePhase;
  readonly className?: string;
}

export function ExperiencePreview(props: ExperiencePreviewProps) {
  const { starter, initialPhase, className } = props;
  const { t, tDynamic } = useT();
  const [phase, setPhase] = useState<FixturePhase>(initialPhase ?? "ordinary");
  const [ready, setReady] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const frameRef = useRef<ExperienceFrameHandle>(null);

  // Push the current fixture into the frame whenever the phase changes or the
  // frame completes its handshake. onAction is a DISCONNECTED logger — it never
  // reaches a production session (see the disconnect invariant above).
  useEffect(() => {
    if (!ready) return;
    const fixture = starter.fixtures[phase];
    const handle = frameRef.current;
    if (!handle || !fixture) return;
    handle.sendState({
      state: fixture.state,
      actions: fixture.actions.map((a) => ({
        type: a.type,
        ...(a.label !== undefined ? { label: a.label } : {}),
      })),
      revision: fixture.revision,
      status: fixture.status,
      ...(fixture.flavor !== undefined ? { flavor: fixture.flavor } : {}),
    });
    // Phase-specific host signals so the visual's pending/error hooks fire too.
    if (phase === "pending") handle.sendPending("typing");
    else if (phase === "error") {
      handle.sendError("protocol_error", "preview: simulated error", { revision: fixture.revision });
    } else handle.sendPending("idle");
  }, [phase, ready, starter]);

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="experience-preview">
      {/* Trusted phase switcher — outside the sandboxed frame. */}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Preview phase">
        {PREVIEW_PHASES.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={p === phase}
            onClick={() => setPhase(p)}
            className={cn(
              "rounded px-2 py-1 text-xs",
              p === phase
                ? "bg-neutral-200 text-neutral-900"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700",
            )}
            data-testid={`experience-preview-phase-${p}`}
          >
            {tDynamic(`experience_preview_phase_${p}`)}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-neutral-700 bg-neutral-950 p-2">
        <ExperienceFrame
          ref={frameRef}
          visualSource={starter.source}
          sessionId={`preview-${starter.id}`}
          initialRevision={starter.fixtures[phase].revision}
          onReady={() => setReady(true)}
          onAction={(a: ExperienceActionDto) => setLastAction(a.type)}
          onError={() => {}}
        />
      </div>
      {/* The disconnected action log — proof preview clicks go nowhere else. */}
      <p className="text-xs text-neutral-500" data-testid="experience-preview-log">
        {lastAction
          ? `${t("experience_preview_last_action")}: ${lastAction}`
          : t("experience_preview_disconnected")}
      </p>
    </div>
  );
}
