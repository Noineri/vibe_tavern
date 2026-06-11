import React, { useCallback, useState } from "react";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";

interface Attachment {
  id?: string;
  assetId: string;
  type: string;
  name?: string;
  description?: string | null;
}

export function AttachmentGrid({ attachments, messageId }: { attachments?: Attachment[]; messageId?: string }) {
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
            {att.description && (
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5 text-[9px] text-white/80 truncate">
                {att.description}
              </div>
            )}
          </button>
        ))}
      </div>

      {lightboxIndex !== null && (
        <Lightbox
          attachments={attachments}
          messageId={messageId}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

function Lightbox({ attachments, messageId, initialIndex, onClose }: { attachments: Attachment[]; messageId?: string; initialIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [localDescription, setLocalDescription] = useState<Record<number, string>>({});
  const att = attachments[index];

  const goNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
    setIndex((i) => (i + 1) % attachments.length);
  };

  const goPrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
    setIndex((i) => (i - 1 + attachments.length) % attachments.length);
  };

  const currentDescription = localDescription[index] ?? att?.description ?? "";

  const startEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(currentDescription);
    setEditing(true);
  }, [currentDescription]);

  const saveDescription = useCallback(async () => {
    if (!messageId || !att?.id) return;
    setSaving(true);
    try {
      const { updateAttachmentDescription } = await import("../../app-client.js");
      await updateAttachmentDescription("_", messageId, att.id, editText);
      setLocalDescription((prev) => ({ ...prev, [index]: editText }));
      setEditing(false);
    } catch {
      // silently fail — keep local state
    } finally {
      setSaving(false);
    }
  }, [messageId, att?.id, editText, index]);

  if (!att) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Close button */}
      <div className="absolute right-4 top-4 z-10 flex gap-2">
        {!editing && currentDescription && messageId && att.id && (
          <button
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
            onClick={startEdit}
            title="Edit description"
          >
            <Icons.edit className="h-4 w-4" />
          </button>
        )}
        <button
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
          onClick={onClose}
        >
          <Icons.Close className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation */}
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

      {/* Image + description */}
      <div className="flex max-h-full max-w-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {att.type === "image" && (
          <img
            src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`}
            alt={att.name || "Attachment full view"}
            className="max-h-[70vh] max-w-full rounded-md object-contain shadow-2xl"
          />
        )}

        {/* Description area */}
        {currentDescription && !editing && (
          <div className="mx-auto max-w-2xl rounded-lg bg-white/10 px-4 py-2.5 text-center text-sm leading-relaxed text-white/80">
            {currentDescription}
          </div>
        )}

        {/* Edit mode */}
        {editing && (
          <div className="mx-auto flex max-w-2xl flex-col gap-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/20 focus:ring-accent"
              rows={3}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex justify-end gap-2">
              <button
                className="cursor-pointer rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/20"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
                onClick={saveDescription}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        )}

        {/* Filename */}
        {att.name && (
          <span className="text-xs text-white/40">{att.name}</span>
        )}
      </div>
    </div>
  );
}
