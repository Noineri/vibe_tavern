/**
 * CopilotPermissionCard (SC-23f) — the `read_message_prompt` permission card
 * in the copilot message feed: the model wants to read the exact RP prompt
 * that produced one reply, and the reply's prompt is the USER's material, so
 * the turn stops on the request and this card IS the permission gate ("Allow"
 * → the turn resumes with the prompt read; "Deny" → it resumes without it).
 *
 * fork #1 of AgentAskCard.tsx — the correspondence map (deviations named),
 * converged on the ask's AP-7 frame:
 * - Frame: the ask card's frame verbatim — the accent left rule (muted on
 *   the read-only receipts), the header row's layout and sizes, the title at
 *   the base ladder size in `text-t1` (muted on the receipts), the
 *   `--ui-fs` ladder throughout, phone targets ≥ 44 px.
 * - D1 icon: `Ic.eye` (a read request) instead of the ask's `Ic.help`.
 * - D2 title: a STATIC i18n line ("the assistant wants to read …") instead
 *   of the model's question (the request carries no question — the marker
 *   identifies the reply, not a query).
 * - D3 reply line: the reply's first line in an `OverflowTooltip`
 *   (truncating user data with the full text in the tooltip) + the
 *   "variant N · ≈N tokens" meta row (SC-23g's plural forms) instead of the
 *   option rows (there is nothing to choose — only to permit).
 * - D4 actions: two buttons — Allow (PRIMARY: the modal-footer's confirm
 *   idiom `bg-accent text-on-accent`, card-scaled to min-h-44) + Deny (the
 *   ask skip's ghost idiom) — instead of the option rows. Inline-row
 *   arithmetic (AD-022: RU runs 20–30% longer): Allow "Разрешить" ≈ 87px +
 *   Deny "Отказать" ≈ 68px + 6px gap ≈ 161px — fits the narrowest feed
 *   (~288px mobile content width) with margin, so the authored copy is NEVER
 *   truncated; only the reply line (user data) ellipsizes. The local
 *   `decided` guard covers the double-click before the optimistic flip
 *   re-renders (send-once); the dumb-card contract (the MessageList decides
 *   `interactive`) is the disabled-while-streaming rule.
 * - D5 resolved: muted receipts in the ask's receipt style (`→ Allowed` /
 *   `→ Denied` — the granted prompt text is NEVER rendered; the card gates
 *   the read, it does not display it) instead of the answer echo.
 * - Expired: the ask's shape verbatim (awaiting but superseded/streaming
 *   renders read-only, muted).
 *
 * States (`data-state`):
 * - `awaiting` — the interactive gate: title + reply line + meta + the two
 *   buttons. Each button sends its decision ONCE.
 * - `allowed` / `denied` — read-only muted receipts.
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
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border-y border-r border-l-2 border-border bg-surface px-2.5 py-2",
        state === "awaiting" ? "border-l-accent" : "border-l-border",
      )}
    >
      <div className="flex items-start gap-1.5">
        <span className={cn("mt-px shrink-0 leading-[1.45]", state === "awaiting" ? "text-accent" : "text-t4")}>
          <Ic.eye />
        </span>
        <span
          data-testid="copilot-permission-title"
          className={cn(
            "min-w-0 whitespace-normal break-words font-ui leading-snug",
            state === "awaiting" ? "text-[var(--ui-fs)] text-t1" : "text-[calc(var(--ui-fs)-2px)] text-t4",
          )}
        >
          {t("copilot_permission_title")}
        </span>
      </div>

      {state === "awaiting" && (
        <>
          {/* The reply's first line is the USER's RP text — page-translatable
              (owner follow-up 2026-10-24). `OverflowTooltip` owns its node,
              so the opt-in wraps it; the title / meta / buttons around it are
              our chrome and stay out. */}
          <div translate="yes" className="min-w-0">
            <OverflowTooltip
              text={permission.replyFirstLine ?? ""}
              side="top"
              className="font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-t2"
            />
          </div>
          <div
            data-testid="copilot-permission-meta"
            className="font-ui text-[calc(var(--ui-fs)-3px)] text-t4"
          >
            {t("copilot_permission_variant", { variant: permission.variantNumber })} · {t("copilot_permission_tokens", { tokens: permission.promptTokens, count: permission.promptTokens })}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="copilot-permission-allow"
              disabled={decided !== null}
              onClick={() => decide("allow")}
              className="flex min-h-[44px] items-center rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
            >
              {t("copilot_permission_allow")}
            </button>
            <button
              type="button"
              data-testid="copilot-permission-deny"
              disabled={decided !== null}
              onClick={() => decide("deny")}
              className="flex min-h-[44px] items-center rounded-md px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:bg-s2 hover:text-t2 disabled:opacity-50"
            >
              {t("copilot_permission_deny")}
            </button>
          </div>
        </>
      )}

      {state === "allowed" && (
        <div
          data-testid="copilot-permission-allowed"
          className="min-w-0 whitespace-normal break-words font-ui text-[var(--ui-fs)] leading-snug text-t1"
        >
          → {t("copilot_permission_allowed")}
        </div>
      )}
      {state === "denied" && (
        <div
          data-testid="copilot-permission-denied"
          className="font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          → {t("copilot_permission_denied")}
        </div>
      )}
      {state === "expired" && (
        <div
          data-testid="copilot-permission-expired"
          className="font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          {t("copilot_permission_expired")}
        </div>
      )}
    </div>
  );
}
