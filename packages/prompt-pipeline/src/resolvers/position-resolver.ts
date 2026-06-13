/**
 * Mode-aware position resolution for prompt assembly.
 *
 * The single mode-sensitive seam of the pipeline. `buildLayers` is mode-blind:
 * it asks a {@link PositionResolver} whether a slot is enabled, what rank it
 * sorts at, and what zone/depth its layer lands in. The two implementations
 * encode the two preset modes:
 *
 * - **Simple** (`createSimpleResolver`): no canvas. Built-in slots are always
 *   enabled and ordered by `DEFAULT_PROMPT_ORDER`; custom injections are not
 *   assembled (the preset still stores them for 2-in-1 switching).
 * - **Advanced** (`createAdvancedResolver`): the canvas (`preset.promptOrder`)
 *   is the single source of truth for ordering, enabled state, and zones.
 *
 * One invariant holds in BOTH modes: `chatHistory` can never be disabled — it
 * carries container markup used for precise inject-depth placement.
 *
 * See `docs/architecture/prompt-pipeline.md` → "Mode-aware assembly".
 */

import type { PromptAssemblyContext, PromptLayer } from "../types.js";
import { createSimpleResolver } from "./simple-resolver.js";
import { createAdvancedResolver } from "./advanced-resolver.js";

/** Structural shape of a `preset.promptOrder` entry (mirrors the inline type). */
export type ResolverPromptOrderEntry = {
  identifier: string;
  enabled: boolean;
  order?: number;
  kind?: "built_in" | "custom";
  zone?: "before_chat" | "in_chat" | "after_chat";
  depth?: number | null;
};

export interface PositionResolver {
  /**
   * Whether a built-in slot participates in assembly.
   * Always `true` for `chatHistory` (cannot be disabled — carries depth markup)
   * and always `true` in simple mode (no canvas toggles for built-in slots).
   */
  enabled(identifier: string): boolean;
  /**
   * Sort rank for a slot. Simple: `fallback ?? DEFAULT_PROMPT_ORDER[id]`.
   * Advanced: canvas `entry.order` when present, else the same fallback chain.
   */
  rank(identifier: string, fallback?: number): number;
  /**
   * Apply zone + order + depth to a layer in place and return it.
   * Mutates `position`, `injectionDepth`, and `subPosition`.
   */
  position(layer: PromptLayer, identifier: string): PromptLayer;
  /** Whether custom injections are assembled (advanced mode only). */
  readonly includeCustomInjections: boolean;
  /**
   * Canvas entry for a world-info slot. Used by the lore block to place the WI
   * layer. Returns `undefined` in simple mode (canvas is not authoritative) so
   * the caller falls through to default inference.
   */
  worldInfoEntry(identifier: string): ResolverPromptOrderEntry | undefined;
}

/**
 * Build the resolver for a preset. Picks advanced when `preset.advancedMode`
 * is truthy, otherwise simple. A `null`/`undefined` preset yields simple mode.
 */
export function createResolver(preset: PromptAssemblyContext["preset"]): PositionResolver {
  return preset?.advancedMode
    ? createAdvancedResolver((preset.promptOrder ?? []) as ResolverPromptOrderEntry[])
    : createSimpleResolver();
}
