import { useState } from "react";
import type { PromptAttachment } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { FileAttachmentPresentation } from "../../chat/file-attachment-chip.js";
import { AttachmentTextViewer } from "../../chat/attachment-text-viewer.js";

export function AgentPromptAttachment({ attachment }: { attachment: PromptAttachment }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return <>
    <FileAttachmentPresentation name={attachment.displayName} status={t("prompt_attachment_included")} trailing={
      <button type="button" aria-label={t("prompt_attachment_view", { name: attachment.displayName })} className="absolute inset-0 cursor-pointer rounded-lg" onClick={() => setOpen(true)} />
    } />
    <AttachmentTextViewer open={open} onClose={() => setOpen(false)} name={attachment.displayName} text={attachment.promptText} caption={t("prompt_attachment_caption")} />
  </>;
}
