/**
 * RecordProposalFallbackCard (AS-5) — the neutral review card for a record
 * proposal whose `recordType` has no registered renderer (or no host at all).
 * It NEVER crashes: an unknown `recordType` renders as-is, and the payload
 * preview is `JSON.stringify` inside try/catch — a circular/malformed payload
 * renders the `bad_payload` fallback, never a throw. Accept is DISABLED with
 * the unsupported-type hint (applying an unrendered op would commit blind).
 *
 * Chrome mirrors `CopilotActivityCard`/`CopilotAskCard` (neutral panel card,
 * status icon + title row, canon text ladder); the disabled Accept uses the
 * modal-footer confirm shape (which already carries `disabled:opacity-50`).
 *
 * forks: 1 — `ObjectiveProposalCard` (the sidechat's `recordType:
 * "objective"` renderer, SC-13c) clones this frame.
 */
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { codeQuoteCls } from "../../../lib/field-tokens.js";
import { Icons } from "../icons.js";
import { useT } from "../../../i18n/context.js";

export interface RecordProposalFallbackCardProps {
  proposal: RecordProposal;
  /** SC-13a: the thread the card resolves against (accept/reject land in
   *  SC-13c) — ignored by the fallback, which never touches the thread. */
  threadId: string;
}

/** Defensive payload preview: stringified JSON, or null when unrenderable. */
function previewPayload(payload: unknown): string | null {
  try {
    const text = JSON.stringify(payload, null, 2);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

export function RecordProposalFallbackCard({ proposal }: RecordProposalFallbackCardProps) {
  const { t } = useT();
  const opKey =
    proposal.op === "create"
      ? "agent.record_proposal.op.create"
      : proposal.op === "update"
        ? "agent.record_proposal.op.update"
        : "agent.record_proposal.op.delete";
  const preview = previewPayload(proposal.payload);
  const hint = t("agent.record_proposal.hint");

  return (
    <div
      data-testid="record-proposal-fallback-card"
      data-record-type={proposal.recordType}
      data-op={proposal.op}
      data-status={proposal.status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 leading-[1.45] text-t3"><Icons.FileText /></span>
        <span
          data-testid="record-proposal-fallback-title"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] font-medium leading-snug text-t2"
        >
          {t("agent.record_proposal.unsupported_title")} · {proposal.recordType} · {t(opKey)}
        </span>
        {proposal.status === "pending" && (
          <span
            data-testid="record-proposal-fallback-status"
            className="ml-1 shrink-0 rounded-full bg-accent/15 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)] text-accent"
          >
            {t("agent.record_proposal.status_pending")}
          </span>
        )}
      </div>

      {proposal.targetId !== undefined && (
        <div
          data-testid="record-proposal-fallback-target"
          className="min-w-0 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {proposal.targetId}
        </div>
      )}

      {/* The proposed payload is MODEL text — page-translatable (owner
          follow-up 2026-10-24); title / target / hint / accept are chrome. */}
      <div
        data-testid="record-proposal-fallback-payload"
        translate="yes"
        className={cn(codeQuoteCls, "max-h-40 overflow-auto")}
      >
        {preview ?? t("agent.record_proposal.bad_payload")}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="record-proposal-fallback-accept"
          disabled
          title={hint}
          className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
        >
          {t("agent.record_proposal.accept")}
        </button>
        <span
          data-testid="record-proposal-fallback-hint"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {hint}
        </span>
      </div>
    </div>
  );
}
