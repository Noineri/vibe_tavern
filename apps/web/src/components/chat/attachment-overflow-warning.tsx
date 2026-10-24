// forks: 1 — AttachmentVisionWarning (attachment-vision-warning.tsx).
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";

/** Shared warning copy/chrome; each responsive composer owns its placement. */
export function AttachmentOverflowWarning({ attachedTokens, freeTokens }: {
  attachedTokens: number;
  freeTokens: number;
}) {
  const { t } = useT();
  return (
    <div role="status" className="mb-2 flex min-w-0 items-start gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-warning-text">
      <span className="shrink-0"><Icons.Alert /></span>
      <span className="min-w-0 whitespace-normal break-words">
        {t("attachments_overflow_warning", { attached: attachedTokens.toLocaleString(), free: freeTokens.toLocaleString() })}
      </span>
    </div>
  );
}
