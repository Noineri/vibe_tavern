import { useState } from "react";
import type { AgentThreadEventWire } from "@vibe-tavern/api-contracts";
import { Icons } from "../icons.js";
import { AnimatedDisclosure } from "../AnimatedDisclosure.js";
import { useT } from "../../../i18n/context.js";

/**
 * One frozen-context timeline separator (SIDECHAT_PLAN Wave 5 / SC-19b) — the
 * sidechat feed renders one per `AgentThreadEventWire`, right before its
 * anchor message (or at the end when the anchor is null).
 *
 * One slim centered line per event (the `── … ──` runs are part of the label
 * copy itself, owner 2026-10-21 — no invented chrome around it). The three
 * content-carrying kinds (`rp_sync`, `variants_attached`, `selection_changed`)
 * expand on click to the frozen content the assistant saw; `branch_forked`
 * carries nothing to show and never expands. The expanded body scrolls
 * internally (`max-h-64`, the digest card's precedent in
 * `AgentMessageBlock.tsx`) and never stretches the feed. The body opens
 * through the shared `AnimatedDisclosure` (AP-29 — the height+opacity motion
 * the lorebook accordion uses); its own sizing/scroll/chrome classes stay on
 * the inner element, never on the animated wrapper.
 */
export function AgentTimelineSeparator({ event }: { event: AgentThreadEventWire }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  // The label N is what the payload carries, nothing derived: the frozen
  // message count for `rp_sync` (the same rows the expanded body lists), the
  // variant count for `variants_attached`.
  let label: string;
  switch (event.kind) {
    case "rp_sync": {
      const n = event.payload.messages.length;
      label = t("sidechat_event_rp_sync", { n, count: n });
      break;
    }
    case "variants_attached":
      label = t("sidechat_event_variants_attached", { n: event.payload.variants.length });
      break;
    case "selection_changed":
      label = t("sidechat_event_selection_changed");
      break;
    case "branch_forked":
      label = t("sidechat_event_branch_forked");
      break;
  }

  // `branch_forked` maps `{ at }` only — no frozen content to show, so the
  // row is a static line (never a button, no caret, no toggle).
  if (event.kind === "branch_forked") {
    return (
      <div
        data-testid="timeline-separator"
        data-kind={event.kind}
        className="mx-auto w-full max-w-[85%] px-3 py-1 text-center font-ui text-[calc(var(--ui-fs)-3px)] text-t4"
      >
        {label}
      </div>
    );
  }

  return (
    <div data-testid="timeline-separator" data-kind={event.kind} className="mx-auto w-full max-w-[85%]">
      <button
        type="button"
        data-testid="timeline-separator-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 px-3 py-1 text-center font-ui text-[calc(var(--ui-fs)-3px)] text-t4 transition-colors hover:text-t2"
      >
        <span className="min-w-0">{label}</span>
        <Icons.Caret direction={expanded ? "u" : "d"} className="h-3 w-3 shrink-0" />
      </button>
      <AnimatedDisclosure open={expanded}>
        <div
          data-testid="timeline-separator-body"
          className="max-h-64 overflow-y-auto rounded-md bg-s3 p-2.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-msg-t1"
        >
          <SeparatorBody event={event} />
        </div>
      </AnimatedDisclosure>
    </div>
  );
}

/**
 * The frozen content the assistant saw, per kind — `branch_forked` never
 * reaches here (it has no expandable row). Only payload-carried content
 * renders: the sync diff's message texts, the attached variants with their
 * selected marker, the previous + current reply texts in order.
 */
function SeparatorBody({ event }: { event: Exclude<AgentThreadEventWire, { kind: "branch_forked" }> }) {
  const { t } = useT();
  switch (event.kind) {
    case "rp_sync":
      return (
        <div className="flex flex-col gap-2">
          {event.payload.messages.map((message) => (
            <div key={message.id}>
              {/* The caption is RP data (the message's author), never UI copy —
                  role-only rows carry no caption. */}
              {message.authorName && (
                <div className="mb-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{message.authorName}</div>
              )}
              <div className="whitespace-pre-wrap">{message.text}</div>
            </div>
          ))}
        </div>
      );
    case "variants_attached":
      return (
        <div className="flex flex-col gap-2">
          {event.payload.variants.map((variant, index) => (
            <div key={index}>
              {/* The selected marker reuses the chip copy the feed already
                  shows for the pending selection (`sidechat_chip_selected`). */}
              {variant.selected && (
                <div className="mb-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                  {t("sidechat_chip_selected", { n: index + 1 })}
                </div>
              )}
              <div className="whitespace-pre-wrap">{variant.text}</div>
            </div>
          ))}
        </div>
      );
    case "selection_changed":
      return (
        <div className="flex flex-col gap-2">
          <div className="whitespace-pre-wrap">{event.payload.previous.text}</div>
          <Icons.Caret direction="d" className="h-3 w-3 shrink-0 self-center text-t3" />
          <div className="whitespace-pre-wrap">{event.payload.current.text}</div>
        </div>
      );
  }
}
