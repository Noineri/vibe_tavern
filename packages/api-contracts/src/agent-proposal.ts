/**
 * Agent proposals (AGENT_SHELL_PLAN, Wave 2 / AS-5) — the per-kind proposal
 * shapes a turn's tool activities aggregate into, shared between the backend
 * (which produces them) and the frontend (which reviews them).
 *
 * - `BufferProposal` is today's experience-copilot buffer shape, moved here
 *   verbatim from `apps/web/src/lib/experience-copilot-apply.ts` (which now
 *   aliases it as `ExperienceCopilotProposal`). It carries NO `kind`
 *   discriminator: the field set alone identifies it, and adding a required
 *   `kind: "buffer"` would churn the existing producer (`aggregate…Proposal`
 *   return sites) for no narrowing gain — the union narrows on the
 *   `RecordProposal.kind` literal instead (see `isRecordProposal`).
 * - `RecordProposal` is the NEW generic record-op proposal (create / update /
 *   delete over an arbitrary `recordType` with an opaque `payload: unknown`).
 *   The payload is deliberately untyped: the fallback card stringifies it
 *   defensively (try/catch — malformed payloads never crash review UI).
 */

/** Today's two-buffer proposal shape (verbatim move, no `kind` — see above). */
export interface BufferProposal {
  /** True iff at least one activity produced a proposal. */
  hasProposal: boolean;
  /** Last rules-target proposal text (undefined if none proposed this turn). */
  proposedRules?: string;
  /** Last visual-target proposal text (undefined if none proposed this turn). */
  proposedVisual?: string;
  /** Per-tool summaries in call order (the model's explanations, shown in the review bar). */
  summaries: string[];
}

/** A record-op proposal over an arbitrary record type. */
export interface RecordProposal {
  kind: "record";
  id: string;
  recordType: string;
  op: "create" | "update" | "delete";
  targetId?: string;
  payload: unknown;
  status: "pending" | "applied" | "rejected";
}

/** Any proposal an agent turn can produce. */
export type AgentProposal = BufferProposal | RecordProposal;

/**
 * Narrow an `AgentProposal` to the record shape. Buffer proposals carry no
 * `kind` field (see above), so the guard reads it structurally: only an
 * object whose `kind` is the `"record"` literal counts.
 */
export function isRecordProposal(proposal: AgentProposal): proposal is RecordProposal {
  return typeof proposal === "object" && proposal !== null && "kind" in proposal && proposal.kind === "record";
}
