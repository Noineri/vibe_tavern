/**
 * Breakout visual starter (IR-63, wave-6 realtime starter) — a neon canvas
 * arcade loop: steer the paddle with the arrow keys, bounce the ball, clear
 * the 8×4 brick wall.
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
import { BREAKOUT_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";

export { BREAKOUT_VISUAL_SOURCE };

/** 32 alive bricks, bit = row * 8 + col (mirrors the rules bit layout). */
const FULL_FIELD = 0xffffffff;

export const breakoutStarter: VisualStarter = {
  id: "breakout",
  label: "Breakout",
  description: "Realtime arcade loop: bounce the ball off the paddle and clear the brick wall — 3 balls, edge hits fly wide. Renders on the loop tick; the round commits once with the final score.",
  source: BREAKOUT_VISUAL_SOURCE,
  fixtures: {
    setup: { state: { score: 0, lives: 3, px: 0.5, ball: { x: 0.5, y: 0.85 }, bricks: FULL_FIELD, over: false, won: false }, actions: [{ type: "left" }, { type: "right" }], revision: 0, status: "active" },
    ordinary: { state: { score: 12, lives: 2, px: 0.62, ball: { x: 0.41, y: 0.52 }, bricks: 0x00ffff0f, over: false, won: false }, actions: [{ type: "left" }, { type: "right" }], revision: 120, status: "active" },
    pending: { state: { score: 12, lives: 2, px: 0.62, ball: { x: 0.44, y: 0.66 }, bricks: 0x00ffff0f, over: false, won: false }, actions: [{ type: "left" }, { type: "right" }], revision: 128, status: "active" },
    error: { state: { score: 3, lives: 1, px: 0.5, ball: { x: 0.74, y: 0.3 }, bricks: 0x0f0f0f0f, over: false, won: false }, actions: [{ type: "left" }, { type: "right" }], revision: 40, status: "active" },
    completed: { state: { score: 64, lives: 1, px: 0.5, ball: { x: 0.5, y: 0.6 }, bricks: 0, over: true, won: true }, actions: [], revision: 300, status: "completed" },
  },
};
