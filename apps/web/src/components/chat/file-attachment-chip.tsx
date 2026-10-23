import type { Attachment } from "@vibe-tavern/domain";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { formatBytes } from "./attachment-format.js";

/** One file shape for pending and sent attachments. The shell and thumbnail
 *  footprint match AttachmentPreview; only the file-name line may ellipsize. */
export function FileAttachmentChip({ attachment, onRemove }: {
  attachment: Attachment;
  onRemove?: (id: string) => void;
}) {
  const { t } = useT();
  const size = useIsMobile() ? 36 : 48;
  return (
    <div className="group relative flex shrink-0 items-center gap-2 rounded-lg border border-border2 bg-s2 p-1.5 shadow-sm transition-colors hover:bg-s3" data-testid="file-attachment-chip">
      <div className="flex shrink-0 items-center justify-center rounded-[5px] bg-s3 text-t2" style={{ width: size, height: size }}>
        <Icons.FileText />
      </div>
      <div className="flex min-w-0 flex-col justify-center pr-2">
        <span className="max-w-[120px] truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1" title={attachment.name}>
          {attachment.name}
        </span>
        {/* Keep the preview's 15px metadata line box (10px at 1.5 leading)
            while sizing the token text from the UI-font ladder. */}
        <span className="shrink-0 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-3px)] leading-[15px] text-t3">
          {attachment.tokenCount !== undefined
            ? t("attachment_tokens", { tokens: attachment.tokenCount.toLocaleString() })
            : formatBytes(attachment.sizeBytes)}
        </span>
      </div>
      {onRemove && (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-t2 shadow-sm transition-colors hover:bg-danger-dim hover:text-danger-text hover:border-danger"
          onClick={() => onRemove(attachment.id)}
        >
          <Icons.Close />
        </button>
      )}
    </div>
  );
}
