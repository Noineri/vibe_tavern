import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { monoCls } from "../../build/fields/field-styles.js";

export interface GuideCommandRowProps {
  /** The command text (copyable, mono). */
  command: string;
  /** Testid prefix so TTS/STT panels keep their own namespaces
   *  (`tts-help` → `tts-help-copy-…` / `tts-help-check-…`). */
  testPrefix: string;
  /** Stable row identity: `${guideId}-${stepId}-${index}`. */
  copyId: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  /** Manual done-mark (owner flow: paste → wait → tick). Never auto-set. */
  checked: boolean;
  onToggleChecked: () => void;
  /** A11y label for the check control. */
  checkLabel: string;
}

/** One setup-guide command row: [✓ checkbox] [mono command] [copy button].
 *  Shared by the TTS and STT local-server panels (owner request 2026-09-06:
 *  long installs make "which command did I already run" easy to lose — a
 *  manual green check per command is the self-service tracker). The command
 *  is dimmed once checked but stays fully readable and copyable (reinstall
 *  flows need it again). */
export function GuideCommandRow({
  command,
  testPrefix,
  copyId,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  checked,
  onToggleChecked,
  checkLabel,
}: GuideCommandRowProps): React.ReactNode {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={checkLabel}
        title={checkLabel}
        data-testid={`${testPrefix}-check-${copyId}`}
        onClick={onToggleChecked}
        className={cn(
          "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors",
          checked
            ? "border-success bg-success/15 text-success"
            : "border-s3 text-transparent hover:border-t3 hover:text-t4",
        )}
      >
        <Icons.Check />
      </button>
      <div
        className={cn(
          monoCls + " min-w-0 flex-1 whitespace-pre-wrap break-all",
          checked && "opacity-50",
        )}
      >
        {command}
      </div>
      <button
        type="button"
        data-testid={`${testPrefix}-copy-${copyId}`}
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
        onClick={onCopy}
      >
        <Icons.Copy />
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
