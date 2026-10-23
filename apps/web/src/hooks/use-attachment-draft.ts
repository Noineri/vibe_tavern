import { useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import { toast } from "sonner";
import { classifyAttachment, isTextMime, resolveAttachmentUploadMime, TEXT_MIME_TO_EXT } from "@vibe-tavern/domain";
import type { Attachment } from "@vibe-tavern/domain";
import { uploadAsset } from "../api/asset-api.js";
import { useT } from "../i18n/context.js";
import { randomUUID } from "../lib/uuid.js";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
// Shared with the unchanged RP voice-record path; includes MediaRecorder aliases.
export const VALID_AUDIO_TYPES = [
  "audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/m4a",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/flac",
];

export type DraftAttachmentKind = "image" | "audio" | "file";

export interface AttachmentDraftOptions {
  attachments: readonly Attachment[];
  add: (attachment: Attachment) => void;
  remove: (id: string) => void;
  allowedKinds: readonly DraftAttachmentKind[];
  /** Store-backed callers supply getState here for reads across awaits. Other
   *  callers use the ref, updated on every render and successful add. */
  getAttachments?: () => readonly Attachment[];
}

/** One picker/paste/drop path for every composer. The optional upload seam is
 *  the external network boundary, not a second implementation for tests. */
export function useAttachmentDraft(
  options: AttachmentDraftOptions,
  upload: typeof uploadAsset = uploadAsset,
) {
  const { t } = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const attachmentsRef = useRef(options.attachments);
  attachmentsRef.current = options.attachments;
  const pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const readAttachments = () => latest.current.getAttachments?.() ?? attachmentsRef.current;

  const acceptsMime = (mime: string) => (
    (latest.current.allowedKinds.includes("image") && IMAGE_TYPES.includes(mime))
    || (latest.current.allowedKinds.includes("audio") && VALID_AUDIO_TYPES.includes(mime))
    || (latest.current.allowedKinds.includes("file") && isTextMime(mime))
  );
  const accept = [
    ...(options.allowedKinds.includes("image") ? IMAGE_TYPES : []),
    ...(options.allowedKinds.includes("audio") ? VALID_AUDIO_TYPES : []),
    ...(options.allowedKinds.includes("file")
      ? [...Object.keys(TEXT_MIME_TO_EXT), ...new Set(Object.values(TEXT_MIME_TO_EXT).map((ext) => `.${ext}`))]
      : []),
  ].join(",");

  const addFiles = (files: File[]): Promise<void> => {
    const reserved: Array<{ file: File; mime: string }> = [];
    let limitReported = false;
    for (const file of files) {
      const mime = resolveAttachmentUploadMime(file.type, file.name);
      if (!acceptsMime(mime)) {
        toast.error(t("unsupported_image_format"));
      } else if (file.size > 20 * 1024 * 1024) {
        toast.error(t("file_too_large"));
      } else if (readAttachments().length + pending.current >= 5) {
        if (!limitReported) toast.error(t("max_attachments"));
        limitReported = true;
      } else {
        pending.current++;
        reserved.push({ file, mime });
      }
    }
    // Reserve before awaiting: overlapping picker/paste/drop calls count both
    // queued and uploading files. One queue preserves input order across calls.
    const task = queue.current.then(async () => {
      for (const { file, mime } of reserved) {
        try {
          const { assetId, tokenCount } = await upload(file);
          const type = classifyAttachment(mime);
          const attachment: Attachment = {
            id: randomUUID(), assetId, type,
            ...(type === "audio" ? { purpose: "voice" as const } : {}),
            name: file.name, mimeType: mime, sizeBytes: file.size,
            ...(tokenCount !== undefined ? { tokenCount } : {}),
          };
          attachmentsRef.current = [...readAttachments(), attachment];
          latest.current.add(attachment);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Upload failed");
        } finally {
          pending.current--;
        }
      }
    });
    queue.current = task;
    return task;
  };

  const handleFileSelected = (file: File) => addFiles([file]);
  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void addFiles(files);
  };
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && acceptsMime(resolveAttachmentUploadMime(file.type, file.name))) files.push(file);
    }
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };
  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer.types.includes("Files")) setIsDragOver(true);
  };
  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
  };
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    void addFiles(Array.from(event.dataTransfer.files ?? []));
  };

  return {
    fileInputRef, accept, addFiles, handleFileSelected, onFileInputChange, handlePaste,
    isDragOver, handleDragOver, handleDragLeave, handleDrop,
    remove: (id: string) => {
      attachmentsRef.current = readAttachments().filter((attachment) => attachment.id !== id);
      latest.current.remove(id);
    },
  };
}
