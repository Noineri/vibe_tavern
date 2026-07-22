import type { ReactNode } from "react";
import type { DiceRollSnapshot, MessageVariant } from "@vibe-tavern/domain";

// ────────────────────────────────────────────────────────────────────────────
// Message Meta Registry
// ────────────────────────────────────────────────────────────────────────────
// Allows features to register metadata badges (model, preset, tokens,
// reasoning-duration, coauthor module+skill, future: insights objective,
// attachment count, branch name, …) that render in the message footer bar,
// WITHOUT editing MessageShell. Follows the same array + listeners pattern as
// message-slot-registry.ts and build-panel-registry.ts.
//
// Unlike slots, meta badges have no named injection position — they all render
// in a single horizontal row, ordered by `order`. When no badges are visible
// (none registered, or all return visible:false), zero badge DOM is produced;
// the leading timestamp + token-count span (always present, non-pluggable) is
// rendered by MessageShell itself, not by this registry.
//
// Provenance is variant-scoped: a badge reads from `ctx.variant` (the selected
// MessageVariant), because each variant is the unit of generation and carries
// its own modelId/presetId/reasoningDurationMs/coauthor fields. A message-level
// fallback is intentionally NOT provided — that would duplicate the source of
// truth and mask save-path bugs (see reports/MESSAGE_META_REGISTRY.md).
//
// EXCEPTION — `diceRolls` is message-owned, not variant provenance: a Dice
// result binds to the user message itself (not a generation variant), so its
// immutable snapshots travel on the message. The pending-user shell populates
// it from the active-generation capture (DICE-F9); committed user messages
// populate it from the server DTO; assistant/coauthor turns pass an explicit
// empty array. The descriptor that renders it is registered in
// `message-meta/dice-rolls.tsx` (DICE-F10).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to every meta badge renderer and visibility check.
 * Populated by MessageShell from the current message + selected variant.
 */
export interface MessageMetaContext {
  /** Chat the message belongs to. */
  chatId: string;
  /** Message being rendered. */
  messageId: string;
  /** Role of the message. */
  messageRole: "user" | "assistant" | "system" | "tool";
  /**
   * The currently selected variant — the unit of generation. Provenance fields
   * (modelId, presetId, reasoningDurationMs, coauthorModuleId, coauthorSkillId,
   * finishReason) live here. Null only when the message has no variants yet.
   */
  variant: MessageVariant | null;
  /** Currently selected variant index. */
  variantIndex: number;
  /** Whether this message is currently streaming. */
  isStreaming: boolean;
  /** Whether this is rendered inside a coauthor turn shell (turn-level aggregation). */
  isCoauthorTurn: boolean;
  /** Resolved preset name for the selected variant (variant.presetId → name). Null when none. */
  presetName: string | null;
  /** Message token count (not variant-derived; comes from the token counter). */
  tokenCount: number;
  /** Message creation timestamp (ISO string). */
  createdAt: string;
  /**
   * Message-owned Dice result snapshots bound to this user message (DICE-F9 /
   * DICE-F10). Required: every context constructor passes real rolls or an
   * explicit `[]` — committed user message (MessageBlock) reads the server DTO;
   * the pending-user shell reads the active-generation capture; assistant and
   * coauthor turns pass `[]`. The descriptor that renders it lives in
   * `message-meta/dice-rolls.tsx`. Immutable — script rename/disable/delete
   * never changes a historical snapshot.
   */
  diceRolls: DiceRollSnapshot[];
}

/**
 * Describes a meta badge registered by a feature.
 */
export interface MessageMetaDescriptor {
  /** Unique id for this badge (e.g. "provenance-model"). */
  id: string;
  /**
   * React node to render for this badge.
   * Only called when `visible` returns true.
   */
  render: (ctx: MessageMetaContext) => ReactNode;
  /**
   * Return false to skip rendering (zero DOM produced).
   * Checked on every render — can depend on runtime state.
   * Defaults to true if omitted.
   */
  visible?: (ctx: MessageMetaContext) => boolean;
  /**
   * Sort order within the meta row (lower = rendered earlier, after the
   * leading timestamp + token-count span). Default is 0.
   */
  order?: number;
  /**
   * Which message roles this badge applies to.
   * Undefined = applies to all roles.
   */
  roles?: ("user" | "assistant" | "system" | "tool")[];
}

// ────────────────────────────────────────────────────────────────────────────
// Registry implementation
// ────────────────────────────────────────────────────────────────────────────

type Listener = () => void;

const metas: MessageMetaDescriptor[] = [];
const listeners: Set<Listener> = new Set();

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Register a meta badge. If a badge with the same `id` already exists,
 * it is replaced (last-write-wins, enables HMR + idempotent re-registration).
 * Returns an unsubscribe function.
 */
export function registerMessageMeta(descriptor: MessageMetaDescriptor): () => void {
  const idx = metas.findIndex((m) => m.id === descriptor.id);
  if (idx !== -1) metas[idx] = descriptor;
  else metas.push(descriptor);
  notify();
  return () => {
    const i = metas.indexOf(descriptor);
    if (i !== -1) metas.splice(i, 1);
    notify();
  };
}

/**
 * Returns all registered meta descriptors (unfiltered).
 */
export function getMessageMetas(): readonly MessageMetaDescriptor[] {
  return metas;
}

/**
 * Subscribe to changes in the meta registry.
 * Used by MessageShell to re-render when badges are registered/unregistered.
 */
export function subscribeMessageMeta(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Get all meta badges applicable to the given context, filtered by visibility
 * and role, sorted by `order`. Intended to be called from MessageShell during
 * render. The leading timestamp + token-count span is NOT included here —
 * MessageShell renders those itself.
 */
export function resolveMessageMeta(ctx: MessageMetaContext): readonly MessageMetaDescriptor[] {
  return metas
    .filter((m) => !m.roles || m.roles.includes(ctx.messageRole))
    .filter((m) => m.visible?.(ctx) !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
