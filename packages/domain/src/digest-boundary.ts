/**
 * Digest-boundary resolution (CM-5) — the SINGLE source of truth for what a
 * compaction digest covers. Born in services/api's agent-prompt.ts; moved to
 * the domain leaf (AP-8, AGENT_SHELL_POLISH) so the db package's turn-delete
 * store sibling reads the SAME derivation (dependency direction forbids
 * packages/db importing services/api, and a second hand-written derivation of
 * the anchor overload would be a copy #2 defect). services/api keeps compat
 * re-exports in agent-prompt.ts — the canonical home is here.
 *
 * A compaction digest REPLACES older messages in the MODEL window only — the
 * UI keeps rendering the full history. The digest message (role === "digest")
 * stores the id of the FIRST KEPT message in its `toolCallId` column (a
 * soft-link overload — that column is otherwise only used for tool-result
 * correlation). Everything strictly before the anchor is covered (dropped
 * from the model window), the anchor and everything after it is kept. Both
 * the stream (pre-split before assembly), the compaction service (what to
 * summarize), and the turn delete (the floor it must refuse to delete
 * through) consume this helper.
 *
 * Pure — no I/O, no imports.
 */

/** The message column that carries the digest's boundary anchor. On a digest
 *  message (role === "digest"), `toolCallId` holds the id of the FIRST KEPT
 *  message; a dangling anchor (kept message deleted) degrades to no-drop, never
 *  wrong-side. See `resolveDigestBoundary`. */
export const AGENT_DIGEST_ANCHOR_FIELD = "toolCallId" as const;

/** Structural view of a stored message sufficient to resolve the digest
 *  boundary. Accepts the store's message rows and the wire shape — only
 *  `id`/`role`/`content`/`toolCallId` are read. */
export interface DigestBoundaryMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly toolCallId: string | null;
}

/** Result of resolving the digest boundary over a thread's message list.
 *  Generic so the caller's concrete message type (store message rows)
 *  survives — the stream and compaction service both need it to feed the history
 *  converter unchanged. */
export interface AgentDigestBoundary<T extends DigestBoundaryMessage = DigestBoundaryMessage> {
  /** The LAST digest message, or null when the thread has never compacted. */
  readonly lastDigest: T | null;
  /** Messages strictly before the last digest's anchor — the covered prefix to
   *  DROP from the model window. Excludes the last digest itself; older digest
   *  messages are simply part of this dropped prefix. */
  readonly covered: readonly T[];
  /** Messages from the anchor onward — the keep-window that survives into the
   *  model window. Excludes the last digest itself. */
  readonly kept: readonly T[];
}

/** Resolve the digest boundary (CM-5): find the LAST digest message and split
 *  the list at its anchor. See the module comment above for the semantics.
 *
 *  - No digest → `{ lastDigest: null, covered: [], kept: all }`.
 *  - Anchor found → everything strictly before the anchor is `covered`; the
 *    anchor onward is `kept` (both exclude the last digest itself).
 *  - Anchor DANGLING (id not in the loaded set) → degrade to no-drop: `covered`
 *    is empty, `kept` is every non-digest message (never wrong-side; logged).
 *
 *  Pure — no store access; the caller supplies the loaded message list. */
export function resolveDigestBoundary<T extends DigestBoundaryMessage>(
  messages: readonly T[],
): AgentDigestBoundary<T> {
  let lastDigestIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "digest") {
      lastDigestIdx = i;
      break;
    }
  }
  if (lastDigestIdx === -1) {
    return { lastDigest: null, covered: [], kept: [...messages] };
  }

  const lastDigest = messages[lastDigestIdx];
  const anchor = lastDigest.toolCallId;
  // Default (dangling / no anchor) = drop nothing — the digest still renders,
  // but every non-digest message stays in the window (degraded, never wrong-side).
  let keepFrom = 0;
  if (anchor) {
    const anchorIdx = messages.findIndex((m) => m.id === anchor);
    if (anchorIdx >= 0) {
      keepFrom = anchorIdx;
    } else {
      console.error(
        `[digest-boundary] dangling digest anchor '${anchor}' on digest '${lastDigest.id}' — treating as no-drop`,
      );
    }
  }

  const covered = messages.slice(0, keepFrom).filter((m) => m.id !== lastDigest.id);
  const kept = messages.slice(keepFrom).filter((m) => m.id !== lastDigest.id);
  return { lastDigest, covered, kept };
}
