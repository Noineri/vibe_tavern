import React from "react";
import { Icons } from "../shared/icons.js";
import { useChatStore } from "../../stores/index.js";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

function formatBytes(bytes: number, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function AttachmentPreview() {
  const draftAttachments = useChatStore((s) => s.draftAttachments);
  const removeDraftAttachment = useChatStore((s) => s.removeDraftAttachment);
  const isMobile = useIsMobile();
  
  if (draftAttachments.length === 0) return null;

  return (
    <div className="flex w-full items-center gap-2 overflow-x-auto pb-2 pl-3 pr-3 pt-2 scrollbar-hide">
      {draftAttachments.map((att) => (
        <div key={att.id} className="group relative flex shrink-0 items-center gap-2 rounded-lg border border-border2 bg-s2 p-1.5 shadow-sm transition-colors hover:bg-s3">
          <img
            src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`}
            alt={att.name}
            className="rounded-[5px] object-cover"
            style={{ width: isMobile ? 36 : 48, height: isMobile ? 36 : 48 }}
          />
          <div className="flex flex-col justify-center max-w-[120px] pr-2">
            <span className="truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1" title={att.name}>
              {att.name}
            </span>
            <span className="font-ui text-[10px] uppercase tracking-wider text-t3">
              {formatBytes(att.sizeBytes)}
            </span>
          </div>
          <button
            type="button"
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-t2 shadow-sm transition-colors hover:bg-danger-dim hover:text-danger-text hover:border-danger"
            onClick={() => removeDraftAttachment(att.id)}
          >
            <Icons.Close />
          </button>
        </div>
      ))}
    </div>
  );
}
