import { attachmentPromptTokens } from "@vibe-tavern/domain";
import { estimateTokens, separatorSideForCurrentModel } from "./compaction.js";
import type { RecentMessage } from "./types.js";

/**
 * ONE derivation of the history piece format (TOKEN_COUNT_ONCE_PLAN TC-3):
 * `formatRecentMessages` (the text sent to the model) and `countHistoryTokens`
 * (the number shown and budgeted) both build every piece through this
 * function, so the counted pieces and the sent text can never drift apart.
 */
export function formatHistoryPiece(role: string, content: string): string {
  return `${role.toUpperCase()}: ${content.trim()}`;
}

/** The existing text-only history representation; attachment content stays on
 *  its message for the executor, never copied into the history layer's text. */
export function formatRecentMessages(messages: ReadonlyArray<RecentMessage>): string {
  return messages
    .map((message) => formatHistoryPiece(message.role, message.content))
    .join("\n\n");
}

/**
 * A non-last piece ending in whitespace breaks the "before" side's leading
 * separator merge: in the joined string the piece's trailing whitespace
 * merges with the "\n\n" that the decomposition glued to the NEXT piece, so
 * neither per-piece form contains the merge (measured OFF +1 per such piece:
 * claude on any JS-whitespace ending incl. NBSP; p50k on newline-family
 * endings). This is a real class, not an exotic one — an EMPTY message's
 * piece is "ROLE: " (the role label's own trailing space), and co-author
 * content is formatted verbatim, never trimmed. The "after" side needs no
 * guard: its piece+"\n\n" form contains whatever merges at that boundary,
 * and the next piece always starts with a role-label letter — every content
 * class measured exact (all whitespace endings, punctuation, emoji, JSON).
 *
 * ONE derivation of the predicate, deliberately uniform across "before"-side
 * tokenizers (p50k's narrower newline-only breakage does NOT get a narrower
 * predicate). O(pieces) per probe — fine by design, not micro-optimized.
 */
const ENDS_WITH_WHITESPACE = /\s$/;

/** Whether the "before" decomposition is safe for these pieces: no piece
 *  except the last (which has no separator after it) ends with whitespace. */
function beforeSideDecomposable(pieces: ReadonlyArray<string>): boolean {
  for (let i = 0; i < pieces.length - 1; i += 1) {
    if (ENDS_WITH_WHITESPACE.test(pieces[i])) return false;
  }
  return true;
}

/**
 * The separator arithmetic every history counter shares (RP and co-author
 * alike): pieces joined with "\n\n", counted per piece on the active
 * tokenizer's MEASURED side so each piece form is encoded once and then read
 * from the layered cache forever after (TC-2). One derivation — the co-author
 * counter in services/api maps its own pieces through this function.
 *
 * - "after": Σ count(piece_i + "\n\n") over every message but the newest, +
 *   count(newest). A growing compaction suffix only PREPENDS a new
 *   non-negative term, so the suffix cost never decreases.
 * - "before": count(oldest) + Σ count("\n\n" + piece_i) over the rest —
 *   guarded: when a non-last piece ends with whitespace (see
 *   beforeSideDecomposable) the whole assembly falls back to the joined
 *   count, exact by construction (exact-or-not-used, never approximate).
 * - null (unmeasured tokenizer, or no side answer injected): today's joined
 *   count, byte for byte.
 *
 * Exactness against the joined count is not assumed — it is fixture-pinned
 * per tokenizer and content class; a tokenizer without that pin never enters
 * this decomposition.
 *
 * planHistoryCompaction monotonicity across MIXED probes (some suffixes
 * decomposed, others guarded-joined, as the suffix grows past a
 * whitespace-ending piece): whatever the form, the counted value of a suffix
 * always equals count(joined(suffix)) — decomposed exactly when pinned,
 * guarded-joined by construction. Growing the suffix prepends
 * "ROLE: …\n\n" to that joined string, which for every real tokenizer adds
 * at least the role label's tokens (never zero — the label is non-empty even
 * for empty content) while the single new junction can absorb at most the
 * boundary tokens on either side; the fixtures pin this net-nonnegative
 * delta for both sides (tokenizer-side-exactness monotonicity rails).
 */
export function countHistoryPieces(pieces: ReadonlyArray<string>): number {
  if (pieces.length === 0) return 0;
  const side = separatorSideForCurrentModel();
  if (side === null) {
    return estimateTokens(pieces.join("\n\n"));
  }
  if (side === "after") {
    let total = 0;
    for (let i = 0; i < pieces.length - 1; i += 1) {
      total += estimateTokens(pieces[i] + "\n\n");
    }
    return total + estimateTokens(pieces[pieces.length - 1]);
  }
  if (!beforeSideDecomposable(pieces)) {
    return estimateTokens(pieces.join("\n\n"));
  }
  let total = estimateTokens(pieces[0]);
  for (let i = 1; i < pieces.length; i += 1) {
    total += estimateTokens("\n\n" + pieces[i]);
  }
  return total;
}

/** One history cost for compaction and the trace/meter: the exact formatted
 *  message text plus visible file weights. Attachments are filtered upstream. */
export function countHistoryTokens(messages: ReadonlyArray<RecentMessage>): number {
  return countHistoryPieces(messages.map((message) => formatHistoryPiece(message.role, message.content)))
    + messages.reduce((total, message) => total + attachmentPromptTokens(message.attachments, estimateTokens), 0);
}
