import { Icons } from "./icons.js";

interface ConnectionProbeStatusProps {
  /** Probe outcome: `true` renders the success badge, `false` the failure badge. */
  ok: boolean;
  /** Caller-owned test ids — STT and TTS keep their existing badges. */
  successTestId: string;
  failureTestId: string;
  /** Already-localized badge text — callers keep their own i18n keys. */
  successText: string;
  failureText: string;
}

/** Shared level-1 probe-result badges (P11).
 *
 * The STT and TTS success/failure blocks are mechanically identical apart
 * from test ids. The surrounding test cards are intentionally not shared:
 * TTS gates its card on key/voice and adds a listen button, while STT and
 * the LLM header use different shells and actions. */
export function ConnectionProbeStatus({
  ok,
  successTestId,
  failureTestId,
  successText,
  failureText,
}: ConnectionProbeStatusProps): React.ReactElement {
  if (ok) {
    return (
      <div className="mt-3" data-testid={successTestId}>
        <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success">
          <Icons.Check />
          {successText}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-3" data-testid={failureTestId}>
      <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
        <Icons.Close />
        {failureText}
      </span>
    </div>
  );
}
