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
 * DMT-32 (DIRECTOR_MESSAGE_TOOLS_PLAN): the `request_message_swipe` family
 * (`kind: "swipe"`, decoded by the ONE api-contracts decoder) extends this
 * same card with the editable instruction gate. The frame, typography
 * ladder, theme tokens and decision transport are the prompt-read
 * precedent's; the intentional differences ONLY:
 * - D6 title/icon: the swipe title + `Ic.sparkles` (a generation request)
 *   instead of the read's `Ic.eye`.
 * - D7 content: the target reply line (the read's reply-line idiom —
 *   `OverflowTooltip`, translate=yes) + the variant meta (no token
 *   estimate — the swipe marker carries none), then the instruction as an
 *   INLINE `AutoTextarea` labeled `copilot_permission_swipe_instruction_label`
 *   (`copilot_permission_swipe_instruction_aria`): the full text visible and
 *   editable WITHOUT opening any accordion, never ellipsized (user-authored
 *   copy) — instead of the prompt-token metadata.
 * - D8 actions: "Allow generation" (the read's primary idiom) + Reject (the
 *   ghost idiom), row `flex-wrap`. AD-022 budget on paper BEFORE markup, RU
 *   copy at the default `--ui-fs: 17` (strings live in ru.json under the
 *   keys): `copilot_permission_swipe_allow` ≈ 19 chars ≈ 165px text + 32px
 *   px-4 ≈ 197px; `copilot_permission_swipe_reject` ≈ 9 chars ≈ 78px + 24px
 *   px-3 ≈ 102px; pair + 6px gap ≈ 305px > the ~268px narrowest mobile
 *   content width (288px − card px-2.5) — the pair WRAPS at the worst case;
 *   each button alone fits with margin, targets stay min-h-[44px], and the
 *   field/actions stay in the normal flow the mobile keyboard scrolls to.
 *   Allow with an EMPTY field does not send: the
 *   `copilot_permission_swipe_instruction_required` line renders instead.
 * - D9 receipts: granted shows `→ copilot_permission_swipe_allowed_receipt`
 *   plus the APPROVED text (the row's final user-approved instruction —
 *   during the optimistic window the retained draft, which IS what was
 *   sent) under `copilot_permission_swipe_approved_label` — never a reset
 *   to the Director's draft, `whitespace-pre-wrap`, translate=yes (RP-bound
 *   user text). Denied/expired use the generation-specific copy. The
 *   receipt asserts only "sent to generation": the persisted row carries NO
 *   run outcome, so the card never claims a variant was saved (the actual
 *   variant appears in the RP chat, where the run writes it).
 * - D10 send failure: the anchor's optimistic flip rolls back on a
 *   pre-stream refusal; the card detects the rollback (a pending decision
 *   was seen, then cleared, while the persisted row still awaits) and
 *   returns to interactive with the `copilot_permission_swipe_send_failed`
 *   line — the user's draft STAYS in
 *   `stores/director-swipe-draft-store.ts` (keyed thread + tool call) so a
 *   retry cannot revert to the original text. Resolving the request
 *   (persisted granted/denied) clears the transient draft.
 *
 * The card itself is dumb: the MessageList decides `interactive` (last
 * activity of the thread + awaiting + no stream running) and resolves the
 * optimistic `pendingPermissionAnswer` override before passing `permission`
 * down. The swipe-family extras (`draftThreadKey`/`draftToolCallId`/
 * `pendingDecision`/`persistedStatus`) ride ONLY swipe renderers; the
 * prompt-read renderer passes none of them and its presentation is
 * unchanged.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentPermissionState } from "../../../stores/agent-turn-store.js";
import { useDirectorSwipeDraftStore } from "../../../stores/director-swipe-draft-store.js";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { AutoTextarea } from "../auto-textarea.js";
import { OverflowTooltip } from "../OverflowTooltip.js";
import { Ic } from "../icons.js";
import { useT } from "../../../i18n/context.js";

export interface AgentPermissionCardProps {
  /** The permission state (already resolved through the optimistic override). */
  permission: AgentPermissionState;
  /** True only while this is the thread's last activity, still awaiting a
   *  decision, and no stream is running. Everything else renders read-only. */
  interactive: boolean;
  /** DMT-32: the swipe family's allow may carry the exact field text —
   *  `onDecision("allow", text)`; reject sends only the decision. The
   *  prompt-read family never passes a second argument. */
  onDecision?: (decision: "allow" | "deny", instruction?: string) => void;
  /** Swipe family ONLY (undefined for a prompt read): the request's draft
   *  identity — `agentThreadKey(kind, threadId)` + the tool call id the
   *  draft store namespaces unsubmitted edits by. */
  draftThreadKey?: string;
  draftToolCallId?: string;
  /** Swipe family ONLY: the in-flight decision override for THIS request
   *  (`null` when the rendered state is the persisted truth). Drives the
   *  rollback detection (D10). */
  pendingDecision?: "allow" | "deny" | null;
  /** Swipe family ONLY: the PERSISTED row's status before the override —
   *  the draft lifecycle keys off it, never off the optimistic flip. */
  persistedStatus?: AgentPermissionState["status"];
}

export function AgentPermissionCard({
  permission,
  interactive,
  onDecision,
  draftThreadKey,
  draftToolCallId,
  pendingDecision,
  persistedStatus,
}: AgentPermissionCardProps) {
  const { t } = useT();
  const isSwipe = permission.kind === "swipe";
  const [decided, setDecided] = useState<"allow" | "deny" | null>(null);
  // D10: a pre-stream refusal rolled the optimistic flip back — the card
  // returns to interactive and says so; the draft store keeps the edit.
  const [sendFailed, setSendFailed] = useState(false);
  // D8: Allow with an empty field is refused card-side (nothing was sent).
  const [instructionRequired, setInstructionRequired] = useState(false);
  const pending = pendingDecision ?? null;

  // DMT-32: the unsubmitted edit lives in the draft store (survives feed
  // virtualization/remounts); absent → the Director's proposed instruction.
  const storedDraft = useDirectorSwipeDraftStore((s) =>
    isSwipe && draftThreadKey !== undefined && draftToolCallId !== undefined
      ? s.draftsByThread[draftThreadKey]?.[draftToolCallId]
      : undefined,
  );
  const clearDraft = useDirectorSwipeDraftStore((s) => s.clearDraft);
  const setDraft = useDirectorSwipeDraftStore((s) => s.setDraft);

  // D10 rollback detection: a pending decision was SEEN (the flip landed)
  // and then cleared while the persisted row still awaits — the refusal.
  // Click → flip lands a tick later, so the trigger requires the flip to
  // have been observed first (sawPendingRef), never fires on the click
  // frame; a success never passes through here (the override holds, and the
  // persisted row resolves before any later override clear).
  const sawPendingRef = useRef(false);
  useEffect(() => {
    if (!isSwipe) return;
    if (decided === null) {
      sawPendingRef.current = false;
      return;
    }
    if (pending !== null) {
      sawPendingRef.current = true;
      return;
    }
    if (sawPendingRef.current && permission.status === "awaiting_permission") {
      sawPendingRef.current = false;
      setDecided(null);
      setSendFailed(true);
    }
  }, [decided, isSwipe, pending, permission.status]);

  // D9/Draft lifecycle: clear the transient draft when the PERSISTED row
  // resolves — never on the optimistic flip (a refusal must keep the edit).
  useEffect(() => {
    if (draftThreadKey === undefined || draftToolCallId === undefined) return;
    if (persistedStatus === "granted" || persistedStatus === "denied") {
      clearDraft(draftThreadKey, draftToolCallId);
    }
  }, [clearDraft, draftThreadKey, draftToolCallId, persistedStatus]);

  const state: "awaiting" | "allowed" | "denied" | "expired" =
    permission.status === "awaiting_permission"
      ? (interactive ? "awaiting" : "expired")
      : permission.status === "granted" ? "allowed" : "denied";

  const decide = (decision: "allow" | "deny") => {
    if (decided !== null || !onDecision) return;
    setDecided(decision);
    onDecision(decision);
  };

  // DMT-32 swipe decisions: send-once (the decided latch + the in-flight
  // override), the empty-field guard before any send, Reject sending ONLY
  // the decision (draft edits are never saved as an RP instruction on
  // reject — the wire refuses an instruction on deny anyway).
  const fieldText = storedDraft ?? permission.instruction ?? "";
  const decideSwipe = (decision: "allow" | "deny") => {
    if (decided !== null || pending !== null || !onDecision) return;
    if (decision === "allow") {
      if (fieldText.trim() === "") {
        setInstructionRequired(true);
        return;
      }
      setDecided("allow");
      onDecision("allow", fieldText);
      return;
    }
    setDecided("deny");
    onDecision("deny");
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
          {isSwipe ? <Ic.sparkles /> : <Ic.eye />}
        </span>
        <span
          data-testid="copilot-permission-title"
          className={cn(
            "min-w-0 whitespace-normal break-words font-ui leading-snug",
            state === "awaiting" ? "text-[var(--ui-fs)] text-t1" : "text-[calc(var(--ui-fs)-2px)] text-t4",
          )}
        >
          {isSwipe ? t("copilot_permission_swipe_title") : t("copilot_permission_title")}
        </span>
      </div>

      {state === "awaiting" && !isSwipe && (
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

      {state === "awaiting" && isSwipe && (
        <>
          {/* D7: the target reply line — the read's reply-line idiom (user
              data: page-translatable, ellipsizes with the full text in the
              tooltip) + the variant meta. */}
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
            {t("copilot_permission_variant", { variant: permission.variantNumber })}
          </div>
          {/* D7: the instruction — full text visible and editable INLINE
              (never ellipsized; the field grows, capped rows scroll
              internally). The draft store keeps the edit across remounts. */}
          <div className={cn(lblCls, "!mb-0")}>{t("copilot_permission_swipe_instruction_label")}</div>
          <AutoTextarea
            data-testid="copilot-permission-swipe-instruction"
            aria-label={t("copilot_permission_swipe_instruction_aria")}
            value={fieldText}
            minRows={2}
            maxRows={10}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setDraft(draftThreadKey ?? "", draftToolCallId ?? "", next);
              if (next.trim() !== "") setInstructionRequired(false);
            }}
          />
          {instructionRequired && (
            <div
              data-testid="copilot-permission-swipe-error"
              className="font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-danger"
            >
              {t("copilot_permission_swipe_instruction_required")}
            </div>
          )}
          {sendFailed && (
            <div
              data-testid="copilot-permission-swipe-send-failed"
              className="font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-danger"
            >
              {t("copilot_permission_swipe_send_failed")}
            </div>
          )}
          {/* D8: the wrapping action pair — see the D8 budget note above. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="copilot-permission-swipe-allow"
              disabled={decided !== null || pending !== null}
              onClick={() => decideSwipe("allow")}
              className="flex min-h-[44px] items-center rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50"
            >
              {t("copilot_permission_swipe_allow")}
            </button>
            <button
              type="button"
              data-testid="copilot-permission-swipe-reject"
              disabled={decided !== null || pending !== null}
              onClick={() => decideSwipe("deny")}
              className="flex min-h-[44px] items-center rounded-md px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:bg-s2 hover:text-t2 disabled:opacity-50"
            >
              {t("copilot_permission_swipe_reject")}
            </button>
          </div>
        </>
      )}

      {state === "allowed" && !isSwipe && (
        <div
          data-testid="copilot-permission-allowed"
          className="min-w-0 whitespace-normal break-words font-ui text-[var(--ui-fs)] leading-snug text-t1"
        >
          → {t("copilot_permission_allowed")}
        </div>
      )}
      {state === "allowed" && isSwipe && (
        <>
          <div
            data-testid="copilot-permission-swipe-allowed"
            className="min-w-0 whitespace-normal break-words font-ui text-[var(--ui-fs)] leading-snug text-t1"
          >
            → {t("copilot_permission_swipe_allowed_receipt")}
          </div>
          {/* D9: the APPROVED text — the final user-approved instruction the
              generation ran with (the persisted row's `instruction`; during
              the optimistic window the retained draft, which IS the sent
              text). Full text, pre-wrap, never truncated. */}
          <div className="min-w-0">
            <div className={lblCls}>{t("copilot_permission_swipe_approved_label")}</div>
            <div
              data-testid="copilot-permission-swipe-approved-text"
              translate="yes"
              className="min-w-0 whitespace-pre-wrap break-words font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-t2"
            >
              {fieldText}
            </div>
          </div>
        </>
      )}
      {state === "denied" && !isSwipe && (
        <div
          data-testid="copilot-permission-denied"
          className="font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          → {t("copilot_permission_denied")}
        </div>
      )}
      {state === "denied" && isSwipe && (
        <div
          data-testid="copilot-permission-swipe-denied"
          className="font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          → {t("copilot_permission_swipe_denied_receipt")}
        </div>
      )}
      {state === "expired" && (
        <div
          data-testid={isSwipe ? "copilot-permission-swipe-expired" : "copilot-permission-expired"}
          className="font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          {isSwipe ? t("copilot_permission_swipe_expired") : t("copilot_permission_expired")}
        </div>
      )}
    </div>
  );
}
