import { Icons } from "./icons.js";

interface ConnectionAutoKeyHintProps {
  /** Caller-owned test id (`tts-key-source-hint` / `stt-key-source-hint`). */
  testId: string;
  /** Already-localized hint text — callers keep their own i18n keys. */
  message: string;
}

/** Shared level-1 auto-key hint row (P11).
 *
 * The STT and TTS “key comes from provider X” rows are mechanically
 * identical: lock glyph, spacing, typography, and `{name}` interpolation.
 * Only the test id and localized sentence differ per tab, so they are props.
 * The LLM modal has no equivalent row and stays untouched. */
export function ConnectionAutoKeyHint({ testId, message }: ConnectionAutoKeyHintProps): React.ReactElement {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 font-ui text-[11px] text-t3" data-testid={testId}>
      <span className="[&_svg]:h-[12px] [&_svg]:w-[12px] shrink-0">
        <Icons.lock />
      </span>
      {message}
    </div>
  );
}
