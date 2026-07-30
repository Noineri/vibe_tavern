/**
 * `<ChatImportMobile>` — mobile flow orchestrator for chat history import.
 *
 * Plan unit IF-5 of `IMPORT_MOBILE_FLOW_PLAN.md`. Mirrors
 * `<CharacterImportMobile>` for the `.jsonl` chat-history path: wires the IF-3
 * hidden native file picker, the IF-1 `parseChatFile` helper, the IF-2
 * `ChatImportPreview`, and the IF-4 `<ImportPreviewModal>` chrome.
 *
 * Always-mounted: the rail holds a ref and calls
 * `chatRef.current?.openPicker()` from any number of buttons. No avatar URL
 * lifecycle (chat previews carry no object URLs) — only the preview state
 * transitions on pick / close / confirm.
 *
 * Props mirror the character orchestrator and stay compatible with the desktop
 * `<ChatImportModal>` callbacks (`isImporting`, `onImportFiles`). The desktop
 * chat modal additionally accepts `activeChatId` but never reads it inside the
 * body, so it is omitted here; IF-6 branches on `useIsMobile()` anyway because
 * the imperative-handle API is structurally different from the desktop's
 * mount-on-demand modal.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "../../../i18n/context.js";
import { useMobileFilePicker } from "./use-mobile-file-picker.js";
import { parseChatFile, type ChatPreview } from "./parse-import-file.js";
import { ChatImportPreview } from "./ImportPreview.js";
import { ImportPreviewModal } from "./ImportPreviewModal.js";

export interface ChatImportMobileProps {
  /** True while the backend is ingesting the confirmed file; disables confirm. */
  isImporting: boolean;
  /** Called with `[file]` when the user confirms the preview. */
  onImportFiles: (files: File[]) => void;
}

export interface ChatImportMobileHandle {
  /** Open the native file picker. Wire to rail button `onClick`. */
  openPicker: () => void;
}

export const ChatImportMobile = forwardRef<ChatImportMobileHandle, ChatImportMobileProps>(
  function ChatImportMobile({ isImporting, onImportFiles }, ref) {
    const { t } = useT();
    const [preview, setPreview] = useState<ChatPreview | null>(null);
    // Monotonic pick generation: only the latest selection may commit its
    // parse result. `mountedRef` additionally blocks commits after unmount.
    const pickIdRef = useRef(0);
    const mountedRef = useRef(true);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    const handleFile = useCallback(
      async (file: File) => {
        // Clear any prior preview first. If parsing throws, no new preview is
        // set and no modal opens (per spec).
        const pickId = ++pickIdRef.current;
        setPreview(null);
        try {
          const parsed = await parseChatFile(file);
          if (!mountedRef.current || pickId !== pickIdRef.current) return;
          setPreview(parsed);
        } catch (err) {
          if (!mountedRef.current || pickId !== pickIdRef.current) return;
          toast.error(err instanceof Error ? err.message : t("import_error_read_chat"));
        }
      },
      [t],
    );

    const { open, inputElement } = useMobileFilePicker({
      accept: ".jsonl",
      onFile: handleFile,
    });

    useImperativeHandle(ref, () => ({ openPicker: open }), [open]);

    function handleConfirm(): void {
      if (!preview || isImporting) return;
      onImportFiles([preview.file]);
      setPreview(null);
    }

    function handleClose(): void {
      setPreview(null);
    }

    return (
      <>
        {inputElement}
        {preview && (
          <ImportPreviewModal
            title={t("chat_import_title")}
            subtitle={t("chat_import_sub")}
            confirmLabel={t("confirm_import")}
            preview={<ChatImportPreview preview={preview} />}
            isImporting={isImporting}
            onConfirm={handleConfirm}
            onClose={handleClose}
          />
        )}
      </>
    );
  },
);
