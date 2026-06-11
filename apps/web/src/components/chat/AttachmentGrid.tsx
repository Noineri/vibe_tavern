import React, { useState } from "react";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";

// Minimal definition to avoid depending on @vibe-tavern/domain directly if it causes issues,
// but usually we can import Attachment from domain.
interface Attachment {
  id?: string;
  assetId: string;
  type: string;
  name?: string;
}

export function AttachmentGrid({ attachments }: { attachments?: Attachment[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (!attachments || attachments.length === 0) return null;

  return (
    <>
      <div className="mt-2.5 flex flex-wrap gap-2 select-none">
        {attachments.map((att, idx) => (
          <button
            key={att.id || att.assetId}
            type="button"
            className="group relative flex h-24 w-auto cursor-zoom-in overflow-hidden rounded-lg border border-border/50 bg-s2/50 shadow-sm transition-all hover:border-accent hover:shadow-md active:scale-[0.98]"
            onClick={() => setLightboxIndex(idx)}
          >
            {att.type === "image" ? (
              <img
                src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`}
                alt={att.name || "Attached image"}
                className="h-full w-auto min-w-16 object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
                draggable={false}
              />
            ) : (
              <div className="flex h-full w-24 flex-col items-center justify-center gap-1 text-t3 group-hover:text-t1">
                <Icons.plug />
                <span className="max-w-[80%] truncate text-[10px] uppercase">{att.type}</span>
              </div>
            )}
          </button>
        ))}
      </div>

      {lightboxIndex !== null && (
        <Lightbox
          attachments={attachments}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

function Lightbox({ attachments, initialIndex, onClose }: { attachments: Attachment[], initialIndex: number, onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const att = attachments[index];

  const goNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex((i) => (i + 1) % attachments.length);
  };

  const goPrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex((i) => (i - 1 + attachments.length) % attachments.length);
  };

  if (!att) return null;

  return (
    <div 
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="absolute right-4 top-4 z-10 flex gap-4">
        <button 
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95" 
          onClick={onClose}
        >
          <Icons.Close className="h-5 w-5" />
        </button>
      </div>

      {attachments.length > 1 && (
        <>
          <button 
            className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95" 
            onClick={goPrev}
          >
            <Icons.Caret direction="l" className="h-6 w-6" />
          </button>
          <button 
            className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95" 
            onClick={goNext}
          >
            <Icons.Caret direction="r" className="h-6 w-6" />
          </button>
        </>
      )}

      {att.type === "image" && (
        <img
          src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`}
          alt={att.name || "Attachment full view"}
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
