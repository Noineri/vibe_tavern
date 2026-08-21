/**
 * Visual starter registry (IR-63). The six editable source skeletons a new
 * visual is copied from. The Build editor (IR-81) lists these in the "new
 * visual from starter" picker and copies the chosen `source` into a fresh
 * user-owned visual; the versioned VibeExperience SDK remains host-provided.
 *
 * Order is the canonical display order in the picker (Choice, Grid/Board, Card
 * Table, Conversation, Breakout, Blank) — Blank is last because it is the escape
 * hatch for experiences that do not fit the other five. Breakout is the wave-6
 * realtime loop starter (REALTIME_EXPERIENCE_MODE_PLAN): it renders on the
 * loop tick and feeds frame-local inputs, so it also serves as the reference
 * realtime visual.
 */
import type { VisualStarter } from "./types.js";
import { choiceStarter } from "./choice.js";
import { gridBoardStarter } from "./grid-board.js";
import { cardTableStarter } from "./card-table.js";
import { conversationStarter } from "./conversation.js";
import { breakoutStarter } from "./breakout.js";
import { blankStarter } from "./blank.js";

export type { VisualStarter } from "./types.js";

/** The six shipped starters in canonical picker order. */
export const VISUAL_STARTERS: readonly VisualStarter[] = [
  choiceStarter,
  gridBoardStarter,
  cardTableStarter,
  conversationStarter,
  breakoutStarter,
  blankStarter,
];

/** Look up a starter by id (returns undefined if not found). */
export function getVisualStarter(id: string): VisualStarter | undefined {
  return VISUAL_STARTERS.find((s) => s.id === id);
}

/** All starter source strings, for the no-internal-imports test sweep. */
export const VISUAL_STARTER_SOURCES: readonly string[] = VISUAL_STARTERS.map((s) => s.source);
