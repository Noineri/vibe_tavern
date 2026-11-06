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
import { Icons } from "../icons.js";
import { ScrollArea } from "../scroll-area.js";
import { CustomTooltip } from "../Tooltip.js";
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
          follow-up 2026-10-24); title / target / hint / accept are chrome.
          CNR-8h: the preview rides the thin ScrollArea lane (3px rest / 5px
          hover) instead of the native fallback. `codeQuoteCls` splits at this
          call site — its FRAME classes (rounded/border/bg) sit on the
          ScrollArea root so the frame stays fixed while the JSON scrolls
          (the native scroller's own border behaved the same), its TEXT
          classes (whitespace/padding/mono ladder) on the content div so the
          padding scrolls with the text. The token's other ceiling consumers
          (ScriptTester, TrackerConfig, the prompt panes) stay native until
          their own CNR-8 units. */}
      <ScrollArea
        scrollbarSize="thin"
        className="max-h-40 rounded-[6px] border border-border bg-s2"
      >
        <div
          data-testid="record-proposal-fallback-payload"
          translate="yes"
          className="min-w-0 whitespace-pre-wrap break-all p-2 font-mono text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2"
        >
          {preview ?? t("agent.record_proposal.bad_payload")}
        </div>
      </ScrollArea>

      <div className="flex items-center gap-2">
        <CustomTooltip content={hint}>
          <span tabIndex={-1} className="inline-flex">
            <button
              type="button"
              data-testid="record-proposal-fallback-accept"
              disabled
              className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
            >
              {t("agent.record_proposal.accept")}
            </button>
          </span>
        </CustomTooltip>
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
