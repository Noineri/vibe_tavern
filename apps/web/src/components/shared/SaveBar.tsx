import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";

export type SaveState = "idle" | "saving" | "saved" | "error";

export const MIN_SAVING_DISPLAY_MS = 250;
export const SAVED_DISPLAY_MS = 1_600;

/**
 * Converts an editor's real `saving`/`dirty` state into readable visual
 * feedback. Fast local writes still show Saving for a minimum interval, then
 * Saved, while edits or failed saves return the button to idle immediately.
 */
export function useSaveFeedback(saving: boolean, dirty: boolean, resetKey?: string | number | null): SaveState {
  const [state, setState] = useState<SaveState>("idle");
  const wasSaving = useRef(false);
  const savingStartedAt = useRef(0);
  const previousResetKey = useRef(resetKey);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (completionTimer.current) clearTimeout(completionTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    completionTimer.current = null;
    savedTimer.current = null;
  };

  useEffect(() => {
    if (previousResetKey.current !== resetKey) {
      clearTimers();
      previousResetKey.current = resetKey;
      wasSaving.current = saving;
      savingStartedAt.current = saving ? Date.now() : 0;
      setState(saving ? "saving" : "idle");
      return;
    }

    if (saving) {
      if (!wasSaving.current) {
        clearTimers();
        savingStartedAt.current = Date.now();
      }
      wasSaving.current = true;
      setState("saving");
      return;
    }

    if (wasSaving.current) {
      wasSaving.current = false;
      if (dirty) {
        clearTimers();
        setState("idle");
        return;
      }
      const remainingSavingTime = Math.max(0, MIN_SAVING_DISPLAY_MS - (Date.now() - savingStartedAt.current));
      completionTimer.current = setTimeout(() => {
        setState("saved");
        completionTimer.current = null;
        savedTimer.current = setTimeout(() => {
          setState("idle");
          savedTimer.current = null;
        }, SAVED_DISPLAY_MS);
      }, remainingSavingTime);
      return;
    }

    if (dirty) {
      clearTimers();
      setState("idle");
    }
  }, [dirty, resetKey, saving]);

  useEffect(() => () => clearTimers(), []);

  return state;
}

interface SaveButtonProps {
  dirty: boolean;
  saveState: SaveState;
  onClick: () => void;
  label?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  size?: "compact" | "default" | "touch";
  resetKey?: string | number | null;
}

export function SaveButton({ dirty, saveState, onClick, label, disabled = false, className, style, size = "default", resetKey }: SaveButtonProps) {
  const { t } = useT();
  const feedbackState = useSaveFeedback(saveState === "saving", dirty, resetKey);
  const visualState = saveState === "error" ? "error" : feedbackState;
  const isSaving = visualState === "saving";
  const isSaved = visualState === "saved";
  const idleLabel = label || t("save_btn");
  const activeLabel = isSaving ? t("saving") : isSaved ? t("saved") : idleLabel;
  const isDisabled = disabled || !dirty || saveState === "saving" || isSaving;
  const sizeClass = size === "compact"
    ? "min-h-7 min-w-[108px] px-3.5 text-[calc(var(--ui-fs)-3px)]"
    : size === "touch"
      ? "min-h-10 min-w-[124px] px-4 text-sm"
      : "min-h-[37px] min-w-[124px] px-[21px] text-[calc(var(--ui-fs)-2px)]";

  return (
    <button
      type="button"
      aria-label={activeLabel}
      className={cn(
        "whitespace-nowrap rounded-md font-ui font-medium transition-[background-color,color,opacity,filter] duration-250",
        sizeClass,
        isSaved
          ? "cursor-default bg-success-dim text-success-text"
          : !isDisabled
            ? "cursor-pointer bg-accent text-on-accent hover:brightness-110"
            : "cursor-default bg-accent text-on-accent opacity-45",
        isSaving && "opacity-70",
        className,
      )}
      style={style}
      disabled={isDisabled}
      onClick={onClick}
    >
      <span aria-hidden="true" className="grid place-items-center">
        <span className={cn("[grid-area:1/1] transition-opacity duration-250", !isSaving && !isSaved ? "opacity-100" : "opacity-0")}>{idleLabel}</span>
        <span className={cn("[grid-area:1/1] transition-opacity duration-250", isSaving ? "opacity-100" : "opacity-0")}>{t("saving")}</span>
        <span className={cn("[grid-area:1/1] transition-opacity duration-250", isSaved ? "opacity-100" : "opacity-0")}>{t("saved")}</span>
      </span>
    </button>
  );
}

interface SaveBarProps extends SaveButtonProps {
  onReset?: () => void;
}

export function SaveBar({ onReset, className, ...buttonProps }: SaveBarProps) {
  const { t } = useT();
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-s2 px-3 py-1.5 text-[calc(var(--ui-fs)-3px)] text-t2">
      {buttonProps.dirty && <span>{t("unsaved_changes")}</span>}
      <SaveButton {...buttonProps} className={className} />
      {onReset && buttonProps.dirty && (
        <button type="button" className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1" onClick={onReset}>{t("cancel_btn")}</button>
      )}
    </div>
  );
}
