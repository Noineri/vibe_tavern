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
} from "@vibe-tavern/domain/builtins";

/** One app-owned built-in experience. */
export interface BuiltinExperienceEntry {
  /** Stable built-in id — also `extensions.builtinId` and the `creationIntentId` suffix (`"builtin:<id>"`). */
  readonly id: string;
  /** Human-readable name (used for both the script and the visual). */
  readonly displayName: string;
  /** One-line description (script description). */
  readonly description: string;
  /** The manifest id declared inside the rules source. */
  readonly manifestId: string;
  /** Stable key for idempotent visual ensure (`ensureVisualByKey`). */
  readonly visualStableKey: string;
  /** The interactive rules script source (self-contained JS body). */
  readonly rulesSource: string;
  /** The visual module source (self-contained HTML/CSS/JS). */
  readonly visualSource: string;
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
      "A human and model conversation: the human replies, the AI replies in turn. The compact messenger built-in (validates the delivery pipeline).",
    manifestId: "model_conversation",
    visualStableKey: "builtin:conversation",
    rulesSource: CONVERSATION_RULES_SOURCE,
    visualSource: CONVERSATION_VISUAL_SOURCE,
  }),
  Object.freeze({
    id: "breakout",
    displayName: "Breakout (Realtime)",
    description:
      "A realtime arcade loop: bounce the ball off the paddle, clear the brick wall — 3 balls, edge hits fly wide. The wave-6 realtime starter.",
    manifestId: "breakout_arcade",
    visualStableKey: "builtin:breakout",
    rulesSource: BREAKOUT_RULES_SOURCE,
    visualSource: BREAKOUT_VISUAL_SOURCE,
  }),
]);

/** Look up a built-in experience by id (returns undefined if not found). */
export function getBuiltinExperience(id: string): BuiltinExperienceEntry | undefined {
  return BUILTIN_EXPERIENCE_CATALOG.find((entry) => entry.id === id);
}
