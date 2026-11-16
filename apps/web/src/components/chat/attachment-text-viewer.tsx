import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { modalPanelCls } from "../shared/modal-helpers.js";
import { ScrollArea } from "../shared/scroll-area.js";

export function AttachmentTextViewer({ open, onClose, name, text, caption }: { open: boolean; onClose: () => void; name: string; text?: string | null; caption?: string }) {
  const { t } = useT();
  return (
      <Modal open={open} onClose={onClose} title={name}>
        <div className={cn(modalPanelCls, "flex max-h-[80dvh] w-[min(640px,calc(100vw-32px))] flex-col p-5")}>
          <div className="mb-4 flex items-start gap-3">
            <h2 className="min-w-0 flex-1 break-words font-ui text-[calc(var(--ui-fs)+2px)] font-medium text-t1">{name}</h2>
            <button type="button" aria-label={t("close")} className="cursor-pointer text-t3 transition-colors hover:text-t1" onClick={onClose}><Icons.Close /></button>
          </div>
          {caption !== undefined && <p className="mb-3 break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{caption}</p>}
          {/* CNR-8l: the summary body rides the shared thin vertical lane
              (3px rest / 5px hover) instead of the native 8px fallback —
              the panel's max-h-[80dvh] cap still bounds the region (the
              ScrollArea root shrinks inside the panel column), the
              typography scrolls with the text on the content element. */}
          <ScrollArea scrollbarSize="thin" data-testid="sent-file-summary-scroll" contentClassName="whitespace-pre-wrap break-words font-body text-[calc(var(--ui-fs))] text-t2">{text}</ScrollArea>
        </div>
      </Modal>
  );
}
