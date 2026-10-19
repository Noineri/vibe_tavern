import type { AgentThreadContextEventKind, AgentThreadRpFrontier } from "@vibe-tavern/db";
import type { RpBranchViewMessage } from "./rp-branch-view.js";

/**
 * The RP sync diff (SIDECHAT_PLAN SC-2b) — PURE. New messages are detected
 * by id, never by position: a new message takes `max(position) + 1`
 * (message-store.ts addMessage) and deletes do not renumber, so deleting
 * the last synced message and writing a new one REUSES its position — a
 * position frontier would silently never sync the new message.
 * `frontier.selected` (id → frozen variantId, SC-1) is the only "already
 * synced" truth this diff consults.
 *
 * This module computes events + the next frontier; it never touches the
 * store, the db, a logger, the clock, or randomness — every input is a
 * parameter. SC-2c is the writer: it reads the frontier, builds the view
 * (SC-2a's readBranchAsModelSees) and the frozen-text lookup from the
 * thread's stored rp_sync / selection_changed payloads, calls
 * {@link computeRpSync}, then persists the returned events and frontier.
 */

/**
 * The kinds this diff can emit — members of db's AgentThreadContextEventKind
 * (SC-1's single vocabulary), narrowed to the two the RP sync owns.
 */
const RP_SYNC_EMITTED_KINDS = ["rp_sync", "selection_changed"] as const satisfies readonly AgentThreadContextEventKind[];

/** One emitted kind (derived; compiler-checked against SC-1's union). */
export type RpSyncEventKind = (typeof RP_SYNC_EMITTED_KINDS)[number];

/** One message inside an `rp_sync` payload — the model-facing projection of
 *  a view message. Explicit on purpose: the payload is the contract SC-3a
 *  renders into XML, so a view field added later must be DELIBERATELY
 *  copied here, never implicitly inherited. */
export interface RpSyncMessagePayload {
  id: string;
  position: number;
  role: RpBranchViewMessage["role"];
  authorName: string | null;
  variantId: string | null;
  text: string;
}

/**
 * `rp_sync` payload: the delta — every view message whose id was not in
 * `frontier.selected`, in position order. `fromPosition`/`toPosition`
 * bracket exactly that messages array (first/last synced position), NOT
 * `frontier.lastPosition + 1`: under the unit's motivating scenario
 * (delete-last-then-new) the reused position would make a lastPosition-based
 * `from` exceed `to`.
 */
export interface RpSyncPayload {
  fromPosition: number;
  toPosition: number;
  messages: RpSyncMessagePayload[];
}

/** The selected variant of one message, as frozen in an event payload. */
export interface RpVariantSelection {
  variantId: string;
  text: string;
}

/**
 * `selection_changed` payload: a message already in `frontier.selected`
 * whose view `variantId` differs. `previous` is the FROZEN pair — its text
 * comes from the caller's frozen-event payloads via
 * {@link FrozenVariantTextLookup}, never re-read from the live message
 * (an edit never fires; only a different selected variant does).
 */
export interface SelectionChangedPayload {
  messageId: string;
  position: number;
  previous: RpVariantSelection;
  current: RpVariantSelection;
}

/** An event this diff plans — SC-2c writes it (kind + payload) verbatim. */
export type RpSyncPlannedEvent =
  | { kind: "rp_sync"; payload: RpSyncPayload }
  | { kind: "selection_changed"; payload: SelectionChangedPayload };

/**
 * Supplies the FROZEN text of a (messageId, variantId) pair the frontier
 * claims was already synced — the previous text of a `selection_changed`
 * event. SC-2c builds it from the thread's stored rp_sync / selection_changed
 * payloads (both carry `{ messageId, variantId, text }` triples: rp_sync in
 * `messages`, selection_changed in `previous` AND `current` — a swipe chain
 * re-freezes each intermediate variant as some event's `current`).
 */
export type FrozenVariantTextLookup = (messageId: string, variantId: string) => string | null;

/** The diff's result: events to append + the frontier to store (wholesale). */
export interface RpSyncDiff {
  events: RpSyncPlannedEvent[];
  frontier: AgentThreadRpFrontier;
}

/**
 * Compute the RP sync diff between a frozen frontier and the current view.
 *
 * Event order (stable, documented): one `rp_sync` first when there are new
 * messages, then `selection_changed` entries in ascending message position.
 *
 * Frontier rules:
 * - `selected` keys only GROW: a message deleted after sync stays selected
 *   with its frozen variantId — frozen history is never re-contextualized.
 * - For every message present in the view, `selected[id]` tracks the view's
 *   current variantId (a swiped message must not re-fire next sync).
 * - `lastPosition` never regresses: it is `max(previous, highest newly
 *   synced position)` — an empty delta keeps it, and a late-appearing
 *   lower-position message (e.g. a summary range lifted after an earlier
 *   sync) does not pull the marker back. The marker exists for separators
 *   and summaries (SC-3a), which need the forward edge, not the lowest gap.
 *
 * Degenerate shapes (never produced by the insert path — every insert
 * creates a variant, and deleteVariant refuses to remove the last one):
 * a view message with `variantId: null` is synced into `rp_sync` as-is but
 * NOT frozen into `selected` (SC-1's map is id → variantId string), so it
 * re-syncs until it gains a variant; a message already in `selected` whose
 * view variantId is null fires nothing and keeps its frozen entry (null
 * means "no variants", not "a different variant was chosen").
 *
 * A selection change whose frozen text the lookup cannot supply THROWS: the
 * frontier claims the pair was synced, so a miss is frozen-history
 * corruption, and silently omitting `previous` would change what the model
 * is shown. The caller (SC-2c) owns the recovery.
 */
export function computeRpSync(
  frontier: AgentThreadRpFrontier,
  view: readonly RpBranchViewMessage[],
  frozenLookup: FrozenVariantTextLookup,
): RpSyncDiff {
  // The view is documented position-ordered (SC-2a sorts), but the event
  // contracts below are cheap to make self-sustaining — sort a local copy.
  const ordered = [...view].sort((a, b) => a.position - b.position);

  // New = id absent from the frontier's selected map — ids, never positions.
  const newMessages = ordered.filter((message) => frontier.selected[message.id] === undefined);

  const events: RpSyncPlannedEvent[] = [];

  if (newMessages.length > 0) {
    const first = newMessages[0]!;
    const last = newMessages[newMessages.length - 1]!;
    events.push({
      kind: "rp_sync",
      payload: {
        fromPosition: first.position,
        toPosition: last.position,
        messages: newMessages.map((message): RpSyncMessagePayload => ({
          id: message.id,
          position: message.position,
          role: message.role,
          authorName: message.authorName,
          variantId: message.variantId,
          text: message.text,
        })),
      },
    });
  }

  for (const message of ordered) {
    const frozenVariantId = frontier.selected[message.id];
    // Absent → it was just synced above; null → "no variants", not a swipe.
    if (frozenVariantId === undefined || message.variantId === null) continue;
    if (message.variantId === frozenVariantId) continue;

    const previousText = frozenLookup(message.id, frozenVariantId);
    if (previousText === null) {
      throw new Error(
        `computeRpSync: frozen text missing for message ${message.id} variant ${frozenVariantId} — ` +
          "the frontier claims it was synced, but the frozen events do not carry its text",
      );
    }

    events.push({
      kind: "selection_changed",
      payload: {
        messageId: message.id,
        position: message.position,
        previous: { variantId: frozenVariantId, text: previousText },
        current: { variantId: message.variantId, text: message.text },
      },
    });
  }

  // The next frontier: keys only grow; values track the view where present.
  const selected: Record<string, string> = { ...frontier.selected };
  for (const message of ordered) {
    if (message.variantId !== null) selected[message.id] = message.variantId;
  }

  const lastPosition = newMessages.length > 0
    ? Math.max(frontier.lastPosition, newMessages[newMessages.length - 1]!.position)
    : frontier.lastPosition;

  return { events, frontier: { lastPosition, selected } };
}
