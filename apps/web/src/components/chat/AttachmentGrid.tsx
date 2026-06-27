import React, { useCallback, useRef, useState } from "react";
import { useKeyDown } from "../../hooks/use-key-down.js";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useT } from "../../i18n/context.js";
import { toast } from "sonner";

interface Attachment {
  id?: string;
  assetId: string;
  type: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
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
  const { t } = useT();
  const [index, setIndex] = useState(initialIndex);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
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

  const persistDescription = useCallback((description: string) => {
    if (!messageId || !att?.id) return;
    // Update canonical message data so the change survives lightbox close/reopen
    // and reflects in the thumbnail caption. localDescription is just an
    // optimistic overlay for the current lightbox session.
    const updateMessage = useSnapshotStore.getState().updateMessage;
    const nextAttachments = attachments.map((a) => ({
      id: a.id!,
      assetId: a.assetId,
      type: a.type,
      name: a.name,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      description: a.id === att.id ? description : a.description,
    }));
    updateMessage(messageId, { attachments: nextAttachments });
    setLocalDescription((prev) => ({ ...prev, [index]: description }));
  }, [messageId, att?.id, attachments, index]);

  const saveDescription = useCallback(async () => {
    if (!messageId || !att?.id) return;
    setSaving(true);
    try {
      const { updateAttachmentDescription } = await import("../../app-client.js");
      await updateAttachmentDescription("_", messageId, att.id, editText);
      persistDescription(editText);
      setEditing(false);
    } catch (err) {
      console.error("Failed to save attachment description:", err);
    } finally {
      setSaving(false);
    }
  }, [messageId, att?.id, editText, persistDescription]);

  const regenerateDescription = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!messageId || !att?.id) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRegenerating(true);
    try {
      const { regenerateAttachmentDescription } = await import("../../app-client.js");
      const { description } = await regenerateAttachmentDescription("_", messageId, att.id, { signal: ac.signal });
      persistDescription(description);
    } catch (err) {
      if (!ac.signal.aborted) console.error("Failed to regenerate attachment description:", err);
    } finally {
      setRegenerating(false);
      abortRef.current = null;
    }
  }, [messageId, att?.id, persistDescription]);

  const cancelRegenerate = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    abortRef.current?.abort();
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!messageId || !att?.id) return;
    setConfirmDeleteOpen(false);
    // Optimistic: drop the attachment from canonical message data so the grid
    // re-renders without it at once. Each attachment owns a unique assetId, so
    // there's no cross-message ref to preserve.
    const remaining = attachments.filter((a) => a.id !== att.id);
    const updateMessage = useSnapshotStore.getState().updateMessage;
    updateMessage(messageId, {
      attachments: remaining.map((a) => ({
        id: a.id!,
        assetId: a.assetId,
        type: a.type,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        description: a.description,
      })),
    });
    // If we just removed the last one, close the lightbox (the grid hides itself).
    if (remaining.length === 0) { onClose(); return; }
    // Otherwise clamp the index if we deleted the tail item.
    if (index > remaining.length - 1) setIndex(remaining.length - 1);
    try {
      const { deleteAttachment } = await import("../../app-client.js");
      await deleteAttachment("_", messageId, att.id);
      toast.success(t("attachment_deleted"));
    } catch (err) {
      console.error("Failed to delete attachment:", err);
      toast.error(t("attachment_delete_failed"));
    }
  }, [messageId, att?.id, attachments, index, onClose, t]);

  useKeyDown("Escape", onClose, { enabled: !!att && !editing });

  if (!att) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={editing ? undefined : onClose}
    >
      {/* Close button */}
      <div className="absolute right-4 top-4 z-10 flex gap-2">
        {!editing && messageId && att.id && (
          <>
            <button
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
              onClick={startEdit}
              title={currentDescription ? "Edit description" : "Add description"}
            >
              <Icons.edit className="h-4 w-4" />
            </button>
            {att.type === "image" && (
              regenerating ? (
                <button
                  className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-danger/80 text-on-danger transition-colors hover:bg-danger active:scale-95"
                  onClick={cancelRegenerate}
                  title={t("cancel_regenerate_title")}
                >
                  <Icons.Close className="h-4 w-4" />
                </button>
              ) : (
                <button
                  className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
                  onClick={regenerateDescription}
                  title={t("regenerate_description_title")}
                >
                  <Icons.regen />
                </button>
              )
            )}
            <button
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-danger active:scale-95"
              onClick={() => setConfirmDeleteOpen(true)}
              title={t("delete_attachment_title")}
            >
              <Icons.del className="h-4 w-4" />
            </button>
          </>
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
      <div className="flex max-h-full w-full max-w-2xl flex-col items-center gap-3 overflow-y-auto p-2" onClick={(e) => e.stopPropagation()}>
        {att.type === "image" && (
          <img
            src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`}
            alt={att.name || "Attachment full view"}
            className="max-h-[80vh] w-auto max-w-full shrink-0 rounded-md object-contain shadow-2xl"
          />
        )}

        {/* Description area */}
        {regenerating && (
          <div className="w-full rounded-lg bg-white/10 px-4 py-2.5 text-center text-sm text-white/50">
            {t("regenerating_description")}
          </div>
        )}
        {currentDescription && !editing && !regenerating && (
          <div className="w-full rounded-lg bg-white/10 px-4 py-2.5 text-center text-sm leading-relaxed text-white/80">
            {currentDescription}
          </div>
        )}
        {!currentDescription && !editing && !regenerating && messageId && att.id && (
          <div className="w-full text-center text-xs text-white/30">
            {t("no_attachment_description_hint")}
          </div>
        )}

        {/* Edit mode */}
        {editing && (
          <div className="flex w-full flex-col gap-2">
            <AutoTextarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full rounded-lg bg-white/10 px-3 py-2 text-sm leading-relaxed text-white outline-none ring-1 ring-white/20 focus:ring-accent"
              style={{}}
              maxHeight={400}
              placeholder={t("describe_attachment_placeholder")}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex justify-end gap-2">
              <button
                className="cursor-pointer rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/20"
                onClick={() => setEditing(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent transition-colors hover:bg-accent/80 disabled:opacity-50"
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

      {confirmDeleteOpen && (
        <DestructiveConfirmModal
          title={t("attachment_delete_title")}
          body={t("attachment_delete_msg")}
          confirmLabel={t("delete")}
          onConfirm={() => { void confirmDelete(); }}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
    </div>
  );
}
