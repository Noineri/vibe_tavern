import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { useCharacterStore, type ConfirmDialogTone } from "../../stores/character-store.js";
import { Modal } from "./Modal.js";

/** Shared core of the neutral-outline button chrome (the calm secondary) —
 *  ONLY the utilities every arm composes verbatim. Per-arm specifics (size,
 *  padding, text size/color, hover) stay in each arm: `cn` is join-only (no
 *  tailwind-merge), so a conflicting utility in the core would coexist with
 *  the arm's own and resolve by stylesheet order (CF13). Arms: `CANCEL_BTN_CLS`
 *  below and AP-18's `STARTER_BTN_CLS` (`agent-shell/AgentEmptyState.tsx`). */
export const SECONDARY_OUTLINE_CORE =
  "cursor-pointer rounded-md border border-border bg-transparent font-ui transition-colors";
/** Cancel / neutral-outline button chrome (also the calm secondary). */
const CANCEL_BTN_CLS = cn(SECONDARY_OUTLINE_CORE, "h-8 px-3.5 text-[calc(var(--ui-fs)-1px)] text-t3 duration-150 hover:text-t1");
/** Danger primary (the destructive default). */
const PRIMARY_DESTRUCTIVE_CLS =
  "h-8 cursor-pointer rounded-md border-0 bg-danger px-[18px] font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-on-danger transition-[filter] duration-100 hover:brightness-110";
/** Accent primary (the calm tone) — the app's primary-button canon. */
const PRIMARY_CALM_CLS =
  "h-8 cursor-pointer rounded-md border-0 bg-accent px-[18px] font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110";
/** Danger-outline secondary (the destructive default). */
const SECONDARY_DESTRUCTIVE_CLS =
  "h-8 cursor-pointer rounded-md border border-danger bg-transparent px-3.5 font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-danger transition-colors duration-150 hover:bg-danger/10";
/** Calm secondary: neutral, Cancel's outline style verbatim. */
const SECONDARY_CALM_CLS = CANCEL_BTN_CLS;

const PANEL_SINGLE_CLS = "w-[380px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl";
const PANEL_MULTI_CLS = "w-[440px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl";
const ROW_EXPLICIT_CLS = "flex flex-wrap justify-center gap-2.5";
const ROW_SHELL_SINGLE_CLS = "flex justify-center gap-2.5";

interface DestructiveConfirmModalProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional secondary destructive action (lesser scope than the primary).
   * Rendered as an outline-danger button between Cancel and the primary confirm.
   * Both fields must be provided together; omit both for a single-action confirm. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Visual tone (SC-21): `destructive` (default) renders danger throughout;
   * `calm` renders the accent primary + neutral secondary for non-dangerous
   * three-button confirms. Every existing caller omits it. */
  tone?: ConfirmDialogTone;
}

/** Generic destructive confirm — accepts explicit props for local use.
 *  Single-action by default; pass secondaryLabel + onSecondary for a dual-action
 *  variant (e.g. "delete this variant" vs "delete the whole message"). */
export function DestructiveConfirmModal(input: DestructiveConfirmModalProps) {
  const { t } = useT();
  const hasSecondary = Boolean(input.secondaryLabel) && Boolean(input.onSecondary);
  const tone = input.tone ?? "destructive";
  const primaryCls = tone === "calm" ? PRIMARY_CALM_CLS : PRIMARY_DESTRUCTIVE_CLS;
  const secondaryCls = tone === "calm" ? SECONDARY_CALM_CLS : SECONDARY_DESTRUCTIVE_CLS;
  return (
    <Modal open={true} onClose={input.onCancel} overlayClassName="z-[700]" hideOverlay>
      <div
        className={hasSecondary ? PANEL_MULTI_CLS : PANEL_SINGLE_CLS}
      >
        <div className="mb-2 text-[calc(var(--ui-fs)+2px)] leading-6 font-medium text-t1">
          {input.title}
        </div>
        <div className="mb-6 text-[calc(var(--ui-fs)-1px)] leading-[1.55] text-t3">
          {input.body}
        </div>
        <div className={ROW_EXPLICIT_CLS}>
          <button type="button"
            className={CANCEL_BTN_CLS}
            onClick={input.onCancel}
          >
            {t("cancel")}
          </button>
          {hasSecondary && (
            <button type="button"
              className={secondaryCls}
              onClick={input.onSecondary}
            >
              {input.secondaryLabel}
            </button>
          )}
          <button type="button"
            className={primaryCls}
            onClick={input.onConfirm}
          >
            {input.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Self-contained version that reads confirmDestroy from character store. */
export function ShellDestructiveConfirmModal() {
  const { t } = useT();
  const confirmDestroy = useCharacterStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  if (!confirmDestroy) return null;

  const tone = confirmDestroy.tone ?? "destructive";
  const hasSecondary = Boolean(confirmDestroy.secondaryLabel) && Boolean(confirmDestroy.onSecondary);
  const primaryCls = tone === "calm" ? PRIMARY_CALM_CLS : PRIMARY_DESTRUCTIVE_CLS;
  const secondaryCls = tone === "calm" ? SECONDARY_CALM_CLS : SECONDARY_DESTRUCTIVE_CLS;

  return (
    <Modal open={true} onClose={() => setConfirmDestroy(null)} overlayClassName="z-[700]" hideOverlay>
      <div
        className={hasSecondary ? PANEL_MULTI_CLS : PANEL_SINGLE_CLS}
      >
        <div className="mb-2 text-[calc(var(--ui-fs)+2px)] leading-6 font-medium text-t1">
          {confirmDestroy.title}
        </div>
        <div className="mb-6 text-[calc(var(--ui-fs)-1px)] leading-[1.55] text-t3">
          {confirmDestroy.body}
        </div>
        <div className={hasSecondary ? ROW_EXPLICIT_CLS : ROW_SHELL_SINGLE_CLS}>
          <button type="button"
            className={CANCEL_BTN_CLS}
            onClick={() => setConfirmDestroy(null)}
          >
            {t("cancel")}
          </button>
          {hasSecondary && (
            <button type="button"
              className={secondaryCls}
              onClick={() => {
                confirmDestroy!.onSecondary!();
                setConfirmDestroy(null);
              }}
            >
              {confirmDestroy.secondaryLabel}
            </button>
          )}
          <button type="button"
            className={primaryCls}
            onClick={() => {
              confirmDestroy!.onConfirm();
              setConfirmDestroy(null);
            }}
          >
            {confirmDestroy.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
