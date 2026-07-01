import type { ReactNode } from "react";

// ────────────────────────────────────────────────────────────────────────────
// Message Slot Registry
// ────────────────────────────────────────────────────────────────────────────
// Allows features (Insights, Memory, Attachments, etc.) to inject UI into
// message blocks without editing MessageBlock directly. Follows the same
// array + listeners pattern as build-panel-registry.ts.
//
// Slot IDs correspond to well-known injection points inside MessageShell.
// When no slots are registered (or all return visible: false), zero extra
// DOM is produced — keeping the "distraction-free" guarantee.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Named injection points inside a message shell.
 *
 * Layout order (top → bottom):
 *   after_reasoning    — after reasoning accordion, before message content
 *   tool_activity      — co-author tool-call cards (summary + proposed preview)
 *   before_content     — right before message text
 *   after_content      — right after message text
 *   before_metadata    — before time/tokens bar
 *   attachment_area    — where attachments render (after metadata)
 */
export type MessageSlotId =
  | "after_reasoning"
  | "tool_activity"
  | "before_content"
  | "after_content"
  | "before_metadata"
  | "attachment_area";

/**
 * Context passed to every message slot renderer and visibility check.
 * Populated by MessageShell from the current message + chat state.
 */
export interface MessageSlotContext {
  /** Chat the message belongs to. */
  chatId: string;
  /** Message being rendered. */
  messageId: string;
  /** Role of the message. */
  messageRole: "user" | "assistant" | "system" | "tool";
  /** Currently selected variant index. */
  variantIndex: number;
  /** Whether this message is currently streaming. */
  isStreaming: boolean;
  /**
   * Feature-specific data attached to the message.
   * Features store their per-message data here (e.g. summary badge text,
   * objective route, attachment list) keyed by feature id.
   */
  extras: Record<string, unknown>;
}

/**
 * Describes a slot renderer registered by a feature.
 */
export interface MessageSlotDescriptor {
  /** Unique id for this slot renderer (e.g. "insights-objective-route"). */
  id: string;
  /** Which named slot to render in. */
  slot: MessageSlotId;
  /**
   * React component to render at this slot position.
   * Only called when `visible` returns true.
   */
  render: (ctx: MessageSlotContext) => ReactNode;
  /**
   * Return false to skip rendering (zero DOM produced).
   * Checked on every render — can depend on runtime state.
   * Defaults to true if omitted.
   */
  visible?: (ctx: MessageSlotContext) => boolean;
  /**
   * Sort order within the same slot position (lower = rendered first).
   * Default is 0.
   */
  order?: number;
  /**
   * Which message roles this slot applies to.
   * Undefined = applies to all roles.
   */
  roles?: ("user" | "assistant" | "system" | "tool")[];
}

// ────────────────────────────────────────────────────────────────────────────
// Registry implementation
// ────────────────────────────────────────────────────────────────────────────

type Listener = () => void;

const slots: MessageSlotDescriptor[] = [];
const listeners: Set<Listener> = new Set();

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Register a message slot. If a slot with the same `id` already exists,
 * it is replaced. Returns an unsubscribe function.
 */
export function registerMessageSlot(descriptor: MessageSlotDescriptor): () => void {
  const idx = slots.findIndex((s) => s.id === descriptor.id);
  if (idx !== -1) slots[idx] = descriptor;
  else slots.push(descriptor);
  notify();
  return () => {
    const i = slots.indexOf(descriptor);
    if (i !== -1) slots.splice(i, 1);
    notify();
  };
}

/**
 * Returns all registered slot descriptors.
 */
export function getMessageSlots(): readonly MessageSlotDescriptor[] {
  return slots;
}

/**
 * Subscribe to changes in the slot registry.
 * Used by MessageShell to re-render when slots change.
 */
export function subscribeMessageSlots(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Get all slots for a given slot position, filtered by visibility and role,
 * sorted by order. Intended to be called from MessageShell during render.
 */
export function resolveMessageSlots(
  slotId: MessageSlotId,
  ctx: MessageSlotContext,
): readonly MessageSlotDescriptor[] {
  return slots
    .filter((s) => s.slot === slotId)
    .filter((s) => !s.roles || s.roles.includes(ctx.messageRole))
    .filter((s) => s.visible?.(ctx) !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
