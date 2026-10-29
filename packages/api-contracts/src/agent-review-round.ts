/** Pure review mechanics shared by the web stores and server turn persistence.
 * Extracted from experience-copilot-draft/apply and the CD-8 review hooks. */
import type { BufferProposal } from "./agent-proposal.js";
import type { AgentToolActivity, AgentReviewRound, AgentReviewBufferSnapshot, AgentDanglingCapture, AgentReviewEnvelope } from "./schemas/agent-review-round-schema.js";

export function isFinalizedReviewActivity(x: unknown): x is AgentToolActivity {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  return a.status === "done" && typeof a.toolCallId === "string" && typeof a.toolName === "string"
    && (a.target === "rules" || a.target === "visual") && typeof a.proposed === "string" && a.proposed.length > 0;
}

/** Script code may intentionally become empty. Keep the legacy mini-app guard
 * above nonempty and rules/visual-only rather than changing old migrations. */
export function isFinalizedCodeReviewActivity(x: unknown): x is AgentToolActivity {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  return a.status === "done" && typeof a.toolCallId === "string" && typeof a.toolName === "string"
    && a.target === "code" && typeof a.proposed === "string";
}

export function isPersistableAgentReviewActivity(x: unknown): x is AgentToolActivity {
  return isFinalizedReviewActivity(x) || isFinalizedCodeReviewActivity(x);
}

export type AgentBufferReviewKind = "experience" | "script";

export function finalizeBufferReviewActivities(activities: readonly AgentToolActivity[], kind: AgentBufferReviewKind): AgentToolActivity[] {
  const guard = kind === "script" ? isFinalizedCodeReviewActivity : isFinalizedReviewActivity;
  const byId = new Map<string, AgentToolActivity>();
  for (const activity of activities) if (guard(activity)) byId.set(activity.toolCallId, activity);
  return [...byId.values()];
}

/** Later duplicate wins without changing the first occurrence's position. */
export function finalizeReviewActivities(activities: readonly AgentToolActivity[]): AgentToolActivity[] {
  return finalizeBufferReviewActivities(activities, "experience");
}

/** Live aggregation deliberately also recognizes code targets as proposals;
 * only rules/visual are mapped here (the script host maps code separately). */
export function aggregateExperienceCopilotProposal(activities: readonly AgentToolActivity[]): BufferProposal {
  const byId = new Map<string, Pick<AgentToolActivity, "toolCallId" | "target" | "proposed" | "summary">>();
  for (const activity of activities) {
    if (activity.status !== "done" || !activity.target || !activity.proposed) continue;
    byId.set(activity.toolCallId, { toolCallId: activity.toolCallId, target: activity.target, proposed: activity.proposed, summary: activity.summary });
  }
  const finalized = [...byId.values()];
  const summaries = finalized.map((activity) => activity.summary).filter((summary): summary is string => typeof summary === "string" && summary.length > 0);
  if (finalized.length === 0) return { hasProposal: false, summaries: [] };
  let proposedRules: string | undefined;
  let proposedVisual: string | undefined;
  for (const activity of finalized) {
    if (activity.target === "rules") proposedRules = activity.proposed;
    if (activity.target === "visual") proposedVisual = activity.proposed;
  }
  return { hasProposal: true, ...(proposedRules !== undefined ? { proposedRules } : {}), ...(proposedVisual !== undefined ? { proposedVisual } : {}), summaries };
}

export function createEmptyAgentReviewRound(): AgentReviewRound {
  return { snapshots: [], nextSnapshotId: 1, acceptedRules: [], acceptedVisual: [], dismissedRules: [], dismissedVisual: [], rulesKey: null, visualKey: null, dangling: null };
}

export function appendAgentReviewSnapshot(round: AgentReviewRound, buffers: Omit<AgentReviewBufferSnapshot, "id">): AgentReviewRound {
  return { ...round, snapshots: [...round.snapshots, { ...buffers, id: round.nextSnapshotId }], nextSnapshotId: round.nextSnapshotId + 1 };
}

/** A remount or identical proposal preserves progress; a changed diff key does not. */
export function ensureAgentReviewKey(round: AgentReviewRound, buffer: "rules" | "visual", key: string | null): AgentReviewRound {
  if ((buffer === "rules" ? round.rulesKey : round.visualKey) === key) return round;
  return buffer === "rules"
    ? { ...round, rulesKey: key, acceptedRules: [], dismissedRules: [] }
    : { ...round, visualKey: key, acceptedVisual: [], dismissedVisual: [] };
}

export function captureAgentReviewProposal(proposal: BufferProposal, base: { rules: string; visual: string } | null, buffers: { rules: string; visual: string }): AgentDanglingCapture | null {
  if (!proposal.hasProposal) return null;
  return { rules: proposal.proposedRules, visual: proposal.proposedVisual, baseRules: base?.rules ?? buffers.rules, baseVisual: base?.visual ?? buffers.visual };
}

/** Reconcile diff identities after event projection, independently of React's
 * effect timing. A live buffer uses the latest checkpoint; dangling keeps its
 * original anchor. Script hosts select only the existing rules slot. */
export function updateAgentReviewKeys(round: AgentReviewRound, proposal: { proposedRules?: string; proposedVisual?: string }, buffers: readonly ("rules" | "visual")[] = ["rules", "visual"]): AgentReviewRound {
  const snapshot = round.snapshots.at(-1);
  for (const buffer of buffers) {
    const live = buffer === "rules" ? proposal.proposedRules : proposal.proposedVisual;
    const proposed = live ?? round.dangling?.[buffer];
    const base = live !== undefined ? snapshot?.[buffer] : buffer === "rules" ? round.dangling?.baseRules : round.dangling?.baseVisual;
    round = ensureAgentReviewKey(round, buffer, proposed === undefined ? null : `${base ?? ""}\0${proposed}`);
  }
  return round;
}

/** null means no review write, NOT deletion: a non-proposal turn must leave
 * the persisted round and its timestamp untouched. Never mutates its inputs. */
export function buildAgentReviewEnvelope(previous: AgentReviewEnvelope | null, activities: readonly AgentToolActivity[], buffers: { rules: string; visual: string }): AgentReviewEnvelope | null {
  const finalized = finalizeReviewActivities(activities);
  if (finalized.length === 0) return null;
  let round = previous?.round ?? createEmptyAgentReviewRound();
  const lastSnapshot = round.snapshots.at(-1) ?? null;
  const captured = captureAgentReviewProposal(aggregateExperienceCopilotProposal(previous?.activities ?? []), lastSnapshot, buffers);
  if (captured) round = { ...round, dangling: captured };
  round = appendAgentReviewSnapshot(round, buffers);
  const proposal = aggregateExperienceCopilotProposal(finalized);
  round = updateAgentReviewKeys(round, proposal);
  return { _v: 2, activities: finalized, round };
}
