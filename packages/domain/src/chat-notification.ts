// ────────────────────────────────────────────────────────────────────────────
// Chat notifications — typed server→browser background events (W7 / SPC-7a)
// ────────────────────────────────────────────────────────────────────────────
// Per-chat SSE channel (GET /api/chats/:chatId/events, see
// services/api/.../chat-events-feature.ts) forwards these as
// `writeSSE({ event: kind, data })`. Auto-summary is the first producer; the
// transport is intentionally generic so future background events (script-error,
// insights-done, scene-ready…) ride the same channel by adding a variant of
// `ChatNotification` — no new endpoint.
//
// Lives in `packages/domain` (not services/api) so the EventMap augmentation is
// visible to EVERY workspace's typecheck. A `declare module` in a consuming
// package only augments for that package's compilation unit — cross-package
// consumers (apps/web) would not see the merged key. Keeping it next to the
// core EventMap is also more honest: this is an event definition.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-chat background notification, discriminated by `kind`. Carried over the
 * reusable SSE event channel. Each variant carries `chatId` so the route can
 * filter per-subscriber without unpacking the payload.
 *
 * `summary.skipped` is intentionally NOT a variant yet — the only candidate
 * (a disabled auto-summary config) is a deliberate user state, not an
 * in-the-moment surprise worth notifying. Add it when a genuinely
 * user-actionable skip reason exists.
 */
export type ChatNotification = {
  readonly chatId: string;
  readonly kind: "summary.generated";
  readonly summaryId: string;
  /** Human label of the summarized range, e.g. "T12–T30" (pre-formatted). */
  readonly label: string;
};

/**
 * Augment the core EventMap with the notification event. Relative module path
 * (`./event-bus.js`) resolves in-package — this file sits next to event-bus.ts.
 */
declare module "./event-bus.js" {
  interface EventMap {
    "chat.notification": ChatNotification;
  }
}
