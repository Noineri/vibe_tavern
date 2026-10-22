/**
 * CopilotPermissionCard (SC-23f) — the `read_message_prompt` permission card
 * in the copilot message feed: the model wants to read the exact RP prompt
 * that produced one reply, and the reply's prompt is the USER's material, so
 * the turn stops on the request and this card IS the permission gate ("Allow"
 * → the turn resumes with the prompt read; "Deny" → it resumes without it).
 *
 * fork #1 of AgentAskCard.tsx — the correspondence map (deviations named):
 * - Frame: the ask card's slot and frame verbatim (outer flex-col card, the
 *   header row shape, `data-state`, the dumb-card contract — the MessageList
 *   decides `interactive` and resolves the optimistic override first).
 * - D1 icon: `Ic.eye` (a read request) instead of the ask's `Ic.help`.
 * - D2 title: a STATIC i18n line ("the assistant wants to read …") instead
 *   of the model's question (the request carries no question — the marker
 *   identifies the reply, not a query).
 * - D3 reply line: the reply's first line in an `OverflowTooltip`
 *   (truncating user data with the full text in the tooltip) instead of the
 *   option chips (there is nothing to choose — only to permit).
 * - D4 meta line: "variant N · ≈N tokens" (two interpolated i18n keys)
 *   instead of the free-text input row.
 * - D5 actions: two buttons — Allow (PRIMARY: the modal-footer's confirm
 *   idiom `bg-accent text-on-accent`, card-scaled to h-7) + Deny (the ask
 *   skip's ghost idiom) — instead of textarea + send + skip. Inline-row
 *   arithmetic (AD-022: RU runs 20–30% longer): Allow "Разрешить" ≈ 87px +
 *   Deny "Отказать" ≈ 68px + 6px gap ≈ 161px — fits the narrowest feed
 *   (~288px mobile content width) with margin, so the authored copy is NEVER
 *   truncated; only the reply line (user data) ellipsizes.
 * - D6 resolved: static labels ("Allowed" / "Denied") instead of the answer
 *   echo (the granted prompt text is NEVER rendered — the card gates the
 *   read, it does not display it).
 * - Expired: the ask's shape verbatim (awaiting but superseded/streaming
 *   renders read-only, no buttons).
 *
 * States (`data-state`):
 * - `awaiting` — the interactive gate: title + reply line + meta + the two
 *   buttons. Each button sends its decision ONCE (the local `decided` guard
 *   covers the double-click before the optimistic flip re-renders).
 * - `allowed` / `denied` — read-only: the decision label.
 * - `expired` — the request was never decided and a LATER activity exists
 *   (or a turn streams); read-only muted.
 *
 * The card itself is dumb: the MessageList decides `interactive` (last
 * activity of the thread + awaiting + no stream running) and resolves the
 * optimistic `pendingPermissionAnswer` override before passing `permission`
 * down.
 */
import { useState } from "react";
import type { AgentPermissionState } from "../../../stores/agent-turn-store.js";
import { cn } from "../../../lib/cn.js";
import { OverflowTooltip } from "../OverflowTooltip.js";
import { Ic } from "../icons.js";
import { useT } from "../../../i18n/context.js";

export interface AgentPermissionCardProps {
  /** The permission state (already resolved through the optimistic override). */
  permission: AgentPermissionState;
  /** True only while this is the thread's last activity, still awaiting a
   *  decision, and no stream is running. Everything else renders read-only. */
  interactive: boolean;
  onDecision?: (decision: "allow" | "deny") => void;
}

export function AgentPermissionCard({ permission, interactive, onDecision }: AgentPermissionCardProps) {
  const { t } = useT();
  const [decided, setDecided] = useState<"allow" | "deny" | null>(null);

  const state: "awaiting" | "allowed" | "denied" | "expired" =
    permission.status === "awaiting_permission"
      ? (interactive ? "awaiting" : "expired")
      : permission.status === "granted" ? "allowed" : "denied";

  const decide = (decision: "allow" | "deny") => {
    if (decided !== null || !onDecision) return;
    setDecided(decision);
    onDecision(decision);
  };

  return (
    <div
      data-testid="copilot-permission-card"
      data-state={state}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className={cn("mt-px shrink-0 leading-[1.45]", state === "awaiting" ? "text-accent" : "text-t4")}>
          <Ic.eye />
        </span>
        <span
          data-testid="copilot-permission-title"
          className="min-w-0 whitespace-normal break-words font-ui text-[12px] leading-snug text-t2"
        >
          {t("copilot_permission_title")}
        </span>
      </div>

      {state === "awaiting" && (
        <>
          <OverflowTooltip
            text={permission.replyFirstLine ?? ""}
            side="top"
            className="font-ui text-[12px] leading-snug text-t2"
          />
          <div
            data-testid="copilot-permission-meta"
            className="font-ui text-[11px] text-t4"
          >
            {t("copilot_permission_variant", { variant: permission.variantNumber })} · {t("copilot_permission_tokens", { tokens: permission.promptTokens })}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="copilot-permission-allow"
              disabled={decided !== null}
              onClick={() => decide("allow")}
              className="flex h-7 items-center rounded-md bg-accent px-3 font-ui text-[12px] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
            >
              {t("copilot_permission_allow")}
            </button>
            <button
              type="button"
              data-testid="copilot-permission-deny"
              disabled={decided !== null}
              onClick={() => decide("deny")}
              className="rounded-md px-2 py-1 font-ui text-[11px] text-t3 transition-colors hover:bg-s2 hover:text-t2 disabled:opacity-50"
            >
              {t("copilot_permission_deny")}
            </button>
          </div>
        </>
      )}

      {state === "allowed" && (
        <div
          data-testid="copilot-permission-allowed"
          className="flex items-center gap-1.5 font-ui text-[11px] text-success-text"
        >
          <Ic.check />
          {t("copilot_permission_allowed")}
        </div>
      )}
      {state === "denied" && (
        <div
          data-testid="copilot-permission-denied"
          className="flex items-center gap-1.5 font-ui text-[11px] italic text-t4"
        >
          <Ic.close />
          {t("copilot_permission_denied")}
        </div>
      )}
      {state === "expired" && (
        <div
          data-testid="copilot-permission-expired"
          className="font-ui text-[11px] italic text-t4"
        >
          {t("copilot_permission_expired")}
        </div>
      )}
    </div>
  );
}
