import { useState } from "react";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { useT } from "../../i18n/context.js";
import { usePerSendPrefillStore } from "../../stores/per-send-prefill-store.js";

/**
 * Per-send prefill strip (LOCAL_SUPPORT_PLAN LS-4b; MOBILE-ONLY since LS-8).
 * A small collapsible strip OVER the input area that one-shot-overrides the
 * prompt preset's assistant prefill for the NEXT reply, then clears itself —
 * the preset value stays the persistent default (the strip is the same
 * function as the preset's prefill field, surfaced per-send). The desktop
 * input uses the LS-8 chip + in-frame bubble instead (owner design: the
 * mobile control row is too dense for another icon).
 *
 * Visibility is gated UPSTREAM (use-input-area → `perSendPrefillSupported`) on
 * the shared fail-closed capability resolution in @vibe-tavern/domain
 * (`resolvePerSendPrefillSupport` — local backends only, no cloud surfacing)
 * AND the active prompt preset's perSendPrefillEnabled toggle (LS-8). The
 * component renders null when unsupported — no dead chrome.
 *
 * The value is consumed by `handleSend` at send time (one-shot read + clear);
 * this component only writes it. Expansion state is local UI state.
 */
export function PerSendPrefillStrip({ supported }: { supported: boolean }) {
  const { t } = useT();
  const value = usePerSendPrefillStore((s) => s.value);
  const setValue = usePerSendPrefillStore((s) => s.setValue);
  const clear = usePerSendPrefillStore((s) => s.clear);
  const [expanded, setExpanded] = useState(false);

  if (!supported) return null;

  const armed = value !== null;

  return (
    <div className="mb-1.5" data-testid="per-send-prefill-strip">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {armed && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
          {t("per_send_prefill_toggle")}
          <Icons.Caret direction={expanded ? "u" : "d"} />
        </button>
        {armed && (
          <button
            type="button"
            className="flex h-7 cursor-pointer items-center rounded-md px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:text-t1"
            onClick={() => clear()}
          >
            {t("per_send_prefill_clear")}
          </button>
        )}
      </div>
      {/* LS-8: smooth open/close — a grid-rows collapse keeps the textarea
          mounted so the armed value survives expand/collapse cycles. */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0 }}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          <div className="mt-1.5 rounded-md border border-border bg-s2 px-2.5 py-2">
            <AutoTextarea
              className="w-full resize-none border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4"
              minRows={2}
              maxRows={8}
              value={value ?? ""}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t("prefill_placeholder")}
              aria-label={t("per_send_prefill_toggle")}
              data-testid="per-send-prefill-input"
            />
            <p className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("per_send_prefill_hint")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
