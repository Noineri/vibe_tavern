import { brandId, isRecord, type ChatBranchId, type ChatId, type ExperienceCopilotThreadId } from "@vibe-tavern/domain";
import type {
	AgentThreadContextEventKind,
	AgentThreadRpFrontier,
	AgentThreadTimelineEntry,
	ExperienceCopilotStore,
} from "@vibe-tavern/db";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import { readBranchAsModelSees, type RpBranchViewDeps, type RpBranchViewMessage } from "./rp-branch-view.js";

/**
 * The RP sync diff (SIDECHAT_PLAN SC-2b) — PURE. New messages are detected
 * by id, never by position: a new message takes `max(position) + 1`
 * (message-store.ts addMessage) and deletes do not renumber, so deleting
 * the last synced message and writing a new one REUSES its position — a
 * position frontier would silently never sync the new message.
 * `frontier.selected` (id → frozen variantId, SC-1) is the only "already
 * synced" truth this diff consults.
 *
 * This module has two halves. `computeRpSync` is PURE: it never touches the
 * store, the db, a logger, the clock, or randomness — every input is a
 * parameter. `syncBeforeUserMessage` (SC-2c, kept beside it) is the impure
 * writer: it reads the thread's owner row, builds the view (SC-2a's
 * readBranchAsModelSees) and the frozen-text lookup from the thread's stored
 * rp_sync / selection_changed payloads, then applies the pure diff through
 * the store's ONE-transaction write.
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

// ─── The writer (SC-2c) ─────────────────────────────────────────────

/**
 * `syncBeforeUserMessage` was asked to sync a thread that is NOT chat-owned —
 * script-owned, draft, or no row at all. Only a chat-owned thread carries the
 * (chatId, branchId) owner pair an RP sync reads (SC-0a), so the request is
 * refused before any RP-chat read; this typed error is the refusal the
 * sidechat stream (SC-4b) branches on (same pattern as the agent-kind
 * registry's typed refusals).
 */
export class RpSyncThreadNotChatOwnedError extends Error {
  readonly code = "RP_SYNC_THREAD_NOT_CHAT_OWNED";
  constructor(readonly threadId: string) {
    super(
      `RP sync refused: thread "${threadId}" is not chat-owned ` +
        "(script-owned and draft threads have no RP branch to sync).",
    );
    this.name = "RpSyncThreadNotChatOwnedError";
  }
}

/** The stores/services the RP sync writer goes through: the SC-2a view deps
 *  plus the agent-thread store (thread row, stored frozen events, and the
 *  atomic sync write). */
export interface RpSyncDeps extends RpBranchViewDeps {
  experienceCopilot: Pick<ExperienceCopilotStore, "getById" | "listTimeline" | "applyRpSync">;
}

/** The frontier of a never-synced thread — SC-2b's initial contract: message
 *  positions are 0-based, so -1 precedes every message; nothing is selected. */
const NEVER_SYNCED_FRONTIER: AgentThreadRpFrontier = { lastPosition: -1, selected: {} };

/**
 * Build the frozen-text lookup from the thread's STORED frozen payloads
 * (SC-2c): every `rp_sync` event freezes its `messages[]` as
 * (messageId, variantId) → text, and every `selection_changed` event freezes
 * both its `previous` and `current` pairs (a swipe chain re-freezes each
 * intermediate variant as some event's current). Structurally invalid
 * payloads contribute nothing — the lookup is LENIENT by design, because
 * corruption surfaces where it matters: a needed-pair miss inside
 * {@link computeRpSync}, which throws rather than emit an event with a
 * silently omitted previous.
 */
function buildFrozenVariantTextLookup(entries: readonly AgentThreadTimelineEntry[]): FrozenVariantTextLookup {
  const texts = new Map<string, string>();
  const freeze = (messageId: unknown, variantId: unknown, text: unknown): void => {
    if (typeof messageId !== "string" || typeof variantId !== "string" || typeof text !== "string") return;
    texts.set(`${messageId}\u0000${variantId}`, text);
  };
  for (const entry of entries) {
    if (entry.rowType !== "event") continue;
    if (entry.kind === "rp_sync") {
      if (!isRecord(entry.payload) || !Array.isArray(entry.payload.messages)) continue;
      for (const message of entry.payload.messages) {
        if (!isRecord(message)) continue;
        freeze(message.id, message.variantId, message.text);
      }
    } else if (entry.kind === "selection_changed") {
      if (!isRecord(entry.payload)) continue;
      for (const pair of [entry.payload.previous, entry.payload.current]) {
        if (!isRecord(pair)) continue;
        freeze(entry.payload.messageId, pair.variantId, pair.text);
      }
    }
  }
  return (messageId, variantId) => texts.get(`${messageId}\u0000${variantId}`) ?? null;
}

/**
 * Sync the RP chat into the thread's frozen context before a sidechat message
 * send (SC-2c) — the writer the pure diff above expects. Steps: read the
 * chat + branch from the thread's OWN row (a script-owned, draft, or missing
 * thread is refused with {@link RpSyncThreadNotChatOwnedError} before any
 * RP-chat read), read the whole-branch view OUTSIDE any transaction (SC-2a —
 * macro/regex work with its own store reads; SQLite's synchronous runtime
 * forbids nesting that inside the write tx), build the frozen-text lookup from
 * the stored events, then apply the diff through ONE synchronous store
 * transaction (`ExperienceCopilotStore.applyRpSync`): frontier read →
 * computeRpSync → event appends + frontier write all commit together, so two
 * quick sends never duplicate a delta — the second sync computes against the
 * first's committed frontier and produces no events.
 *
 * Failure shapes, named:
 * - Not chat-owned (above): the typed refusal, thrown before any read.
 * - Frozen-history corruption — a message the frontier claims was synced has
 *   no frozen (id, variantId) text in the stored events: computeRpSync throws,
 *   the failure PROPAGATES, and NOTHING is written — no events, no frontier
 *   move (the whole diff lives inside the one transaction; a throw rolls it
 *   back). Residual race, accepted with the view-outside-tx shape: a swipe
 *   landing between this sync's view read and its transaction can surface the
 *   same way (the needed previous pair sits in a not-yet-visible event); the
 *   throw writes nothing, and the NEXT sync — fresh view, fresh events —
 *   succeeds.
 */
export async function syncBeforeUserMessage(
  deps: RpSyncDeps,
  threadId: ExperienceCopilotThreadId,
): Promise<void> {
  const thread = await deps.experienceCopilot.getById(threadId);
  // isChatOwnedAgentThread (SC-0b/SC-0f) narrows chatId + agentKind to
  // non-null; the store writes branchId together with them, so a null
  // branchId is row corruption — refused the same way, never read through.
  if (thread === null || !isChatOwnedAgentThread(thread) || thread.branchId === null) {
    throw new RpSyncThreadNotChatOwnedError(threadId);
  }

  // brandId at the consuming edge of the store projection — the owner columns
  // are plain strings on the row (ER-3), and this is the branded seam's
  // caller (same pattern as experience-context-service's session ids).
  const view = await readBranchAsModelSees(
    deps,
    brandId<ChatId>(thread.chatId),
    brandId<ChatBranchId>(thread.branchId),
  );
  // The owner pair came from the thread's own row; a null view means the owner
  // branch does not resolve. The FK cascade deletes the thread with its
  // branch, so this is unreachable outside the instant a concurrent branch
  // delete lands mid-sync — there is nothing left to sync either way.
  if (view === null) {
    throw new Error(
      `syncBeforeUserMessage: thread "${threadId}" owns chat ${thread.chatId} / branch ${thread.branchId}, ` +
        "but the branch does not resolve (deleted mid-sync?)",
    );
  }

  const timeline = await deps.experienceCopilot.listTimeline(threadId);
  const frozenLookup = buildFrozenVariantTextLookup(timeline);

  await deps.experienceCopilot.applyRpSync(threadId, (frontier) =>
    computeRpSync(frontier ?? NEVER_SYNCED_FRONTIER, view.messages, frozenLookup));
}
