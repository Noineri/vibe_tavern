/**
 * Catch visual starter (IR-63, wave-6 realtime starter) — a canvas arcade
 * loop: steer the paddle with the arrow keys and catch the falling ball.
 *
 * Realtime pattern (REALTIME_EXPERIENCE_MODE_PLAN): the frame renders on the
 * loop's tick (`onTick` IS the frame — no requestAnimationFrame), feeds input
 * frame-locally from real keydown handlers via `actLocal`, and shows a
 * terminal card from `onRoundFinish`. The SAME source also hosts turn-mode
 * previews (the editor's fixture phases arrive through the connect onView
 * callback and a finished round arrives as a `completed` view), so a single
 * render function is shared by both paths.
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK.
 */
import type { VisualStarter } from "./types.js";
import { CATCH_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";

export { CATCH_VISUAL_SOURCE };

export const catchStarter: VisualStarter = {
  id: "catch",
  label: "Catch",
  description: "Realtime arcade loop: steer the paddle with the arrow keys and catch the falling ball. Renders on the loop tick; the round commits once with the final score.",
  source: CATCH_VISUAL_SOURCE,
  fixtures: {
    setup: { state: { score: 0, misses: 0, px: 0.5, ball: { x: 0.5, y: 0.04 }, over: false }, actions: [{ type: "left" }, { type: "right" }], revision: 0, status: "active" },
    ordinary: { state: { score: 2, misses: 1, px: 0.62, ball: { x: 0.41, y: 0.52 }, over: false }, actions: [{ type: "left" }, { type: "right" }], revision: 120, status: "active" },
    pending: { state: { score: 2, misses: 1, px: 0.62, ball: { x: 0.41, y: 0.66 }, over: false }, actions: [{ type: "left" }, { type: "right" }], revision: 128, status: "active" },
    error: { state: { score: 0, misses: 0, px: 0.5, ball: { x: 0.74, y: 0.3 }, over: false }, actions: [{ type: "left" }, { type: "right" }], revision: 40, status: "active" },
    completed: { state: { score: 7, misses: 3, px: 0.5, ball: { x: 0.5, y: 0.9 }, over: true }, actions: [], revision: 300, status: "completed" },
  },
};