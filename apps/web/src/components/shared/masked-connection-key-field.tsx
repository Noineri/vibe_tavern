import { useState } from "react";
import { monoCls } from "../build/fields/field-styles.js";
import { Ic } from "./icons.js";

interface MaskedConnectionKeyFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  stored?: boolean;
  /** Caller-owned test ids — the rendered ids stay byte-identical. */
  fieldTestId: string;
  toggleTestId: string;
  statusTestId: string;
  /** Caller-resolved text for the existing i18n keys — no new copy is introduced here. */
  storedPlaceholder: string;
  storedStatus: string;
  showLabel: string;
  hideLabel: string;
}

/** Shared level-1 masked API-key field (P11).
 *
 * The STT and TTS key fields were mechanically identical forks: masked
 * write-only input, show/hide toggle, and an empty-keeps stored-key status
 * line. Callers resolve their existing localized strings and test ids; the
 * DOM contract is unchanged. The LLM header keeps its plain password field
 * because it has neither the toggle nor the stored-status line — unifying it
 * would change its markup, not share it. */
export function MaskedConnectionKeyField({
  value,
  onChange,
  placeholder,
  stored = false,
  fieldTestId,
  toggleTestId,
  statusTestId,
  storedPlaceholder,
  storedStatus,
  showLabel,
  hideLabel,
}: MaskedConnectionKeyFieldProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const emptyStored = value === "" && stored;
  return (
    <div className="relative mt-1">
      <input
        data-testid={fieldTestId}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={emptyStored ? storedPlaceholder : placeholder}
        className={monoCls + " w-full pr-10"}
      />
      <button
        type="button"
        data-testid={toggleTestId}
        aria-label={visible ? hideLabel : showLabel}
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-t3 hover:bg-s2 hover:text-t1"
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5">
          <Ic.eye />
        </span>
      </button>
      {emptyStored && (
        <div data-testid={statusTestId} className="mt-1 font-ui text-[11px] text-t4">
          {storedStatus}
        </div>
      )}
    </div>
  );
}
