/**
 * Built-in experience catalog — single source of truth for app-owned,
 * auto-seeded interactive experiences.
 *
 * Each entry pairs a rules source (interactive script) with a visual source and
 * the stable keys the seed service uses to make them idempotent. The SOURCE
 * STRINGS themselves live in `@vibe-tavern/domain` (`builtin-experiences.ts`)
 * so the frontend creation-wizard starters and this backend catalog reference
 * one copy with no drift — the `services/api` barrel re-exports the whole server
 * graph (hono/ai-sdk/drizzle), which the frontend cannot import at runtime
 * without breaking its bundle, so the shared strings live in the zero-dep leaf
 * instead. This module owns only the seed METADATA.
 *
 * Consumed by `seed-service.ts` (BE-3) via the startup hook (BE-4). The UI
 * identifies built-ins by `script.extensions.builtinId`, never by importing
 * this module, so it is intentionally NOT re-exported from the `services/api`
 * barrel.
 */
import {
  BREAKOUT_RULES_SOURCE,
  BREAKOUT_VISUAL_SOURCE,
  CONVERSATION_RULES_SOURCE,
  CONVERSATION_VISUAL_SOURCE,
  DURAK_ALT_VISUAL_SOURCE,
  DURAK_CLASSIC_VISUAL_SOURCE,
  DURAK_RULES_SOURCE,
} from "@vibe-tavern/domain/builtins";

export interface BuiltinExperienceVisual {
  readonly stableKey: string;
  readonly name: string;
  readonly source: string;
}

/** One app-owned built-in experience. */
export interface BuiltinExperienceEntry {
  /** Stable built-in id — also `extensions.builtinId` and the `creationIntentId` suffix (`"builtin:<id>"`). */
  readonly id: string;
  /** Human-readable script name. */
  readonly displayName: string;
  /** One-line description (script description). */
  readonly description: string;
  /** The manifest id declared inside the rules source. */
  readonly manifestId: string;
  /** The interactive rules script source (self-contained JS body). */
  readonly rulesSource: string;
  /** Visual modules in binding order; the first is the default. */
  readonly visuals: readonly BuiltinExperienceVisual[];
}

/**
 * The shipped built-in experiences, in canonical display order. Frozen — the
 * seed service reads this; it is never mutated at runtime.
 */
export const BUILTIN_EXPERIENCE_CATALOG: readonly BuiltinExperienceEntry[] = Object.freeze([
  Object.freeze({
    id: "conversation",
    displayName: "Conversation",
    description:
      "A messenger with your profile, characters bound to model seats, and one-on-one or group chats; each character replies through its own model while you wait.",
    manifestId: "model_conversation",
    rulesSource: CONVERSATION_RULES_SOURCE,
    visuals: Object.freeze([
      Object.freeze({ stableKey: "builtin:conversation", name: "Messenger", source: CONVERSATION_VISUAL_SOURCE }),
    ]),
  }),
  Object.freeze({
    id: "breakout",
    displayName: "Breakout (Realtime)",
    description:
      "A realtime arcade loop with power-ups: bounce the ball off the paddle and clear the brick wall (3 balls). Demonstrates update(context, dt), frame-local actLocal inputs, seeded randomness and a replay-verified realtime commit.",
    manifestId: "breakout_arcade",
    rulesSource: BREAKOUT_RULES_SOURCE,
    visuals: Object.freeze([
      Object.freeze({ stableKey: "builtin:breakout", name: "Breakout (Realtime)", source: BREAKOUT_VISUAL_SOURCE }),
    ]),
  }),
  Object.freeze({
    id: "durak",
    displayName: "Durak",
    description:
      "Durak against the bot: 24/36/52-card deck, match to N wins, lowest-trump opening, four bot personalities, adaptive play.",
    manifestId: "durak",
    rulesSource: DURAK_RULES_SOURCE,
    visuals: Object.freeze([
      Object.freeze({ stableKey: "builtin:durak:classic", name: "Classic table", source: DURAK_CLASSIC_VISUAL_SOURCE }),
      Object.freeze({ stableKey: "builtin:durak:alternative", name: "Alternative table", source: DURAK_ALT_VISUAL_SOURCE }),
    ]),
  }),
]);

/** Look up a built-in experience by id (returns undefined if not found). */
export function getBuiltinExperience(id: string): BuiltinExperienceEntry | undefined {
  return BUILTIN_EXPERIENCE_CATALOG.find((entry) => entry.id === id);
}
