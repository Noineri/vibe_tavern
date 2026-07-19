/**
 * `<CharacterImportMobile>` — mobile flow orchestrator for character import.
 *
 * Plan unit IF-5 of `IMPORT_MOBILE_FLOW_PLAN.md`. Wires the IF-3 hidden native
 * file picker, the IF-1 pure parse helper, the IF-2 presentational preview,
 * and the IF-4 preview-then-confirm modal chrome into one always-mounted
 * component that the mobile rail buttons (IF-6) drive via an imperative handle.
 *
 * Always-mounted by design: the rail holds a ref to this component and calls
 * `characterRef.current?.openPicker()` from any number of buttons. The hidden
 * `<input type="file">` is the only thing mounted initially; the preview modal
 * is conditionally rendered only after a file has been parsed successfully.
 *
 * Avatar URL lifecycle (mirrors the desktop `CharacterImportModal`):
 *   • replacement — picking a new file clears the prior preview; the effect
 *     cleanup below revokes the old URL when `preview.avatarUrl` changes;
 *   • close / confirm — `setPreview(null)` transitions the URL to undefined,
 *     running the same cleanup;
 *   • unmount — React fires the final cleanup with the current URL.
 * The new URL is never revoked before the preview renders: revocation only
 * fires when the URL transitions away (to null or to a different URL).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { toast } from "sonner";
import { useT } from "../../../i18n/context.js";
import { useMobileFilePicker } from "./use-mobile-file-picker.js";
import { parseCharacterFile, type CharacterPreview } from "./parse-import-file.js";
import { CharacterImportPreview } from "./ImportPreview.js";
import { ImportPreviewModal } from "./ImportPreviewModal.js";

export interface CharacterImportMobileProps {
  /** True while the backend is ingesting the confirmed file; disables confirm. */
  isImporting: boolean;
  /** Called with `[file]` when the user confirms the preview. */
  onImportFiles: (files: File[]) => void;
}

export interface CharacterImportMobileHandle {
  /** Open the native file picker. Wire to rail button `onClick`. */
  openPicker: () => void;
}

export const CharacterImportMobile = forwardRef<CharacterImportMobileHandle, CharacterImportMobileProps>(
  function CharacterImportMobile({ isImporting, onImportFiles }, ref) {
    const { t } = useT();
    const [preview, setPreview] = useState<CharacterPreview | null>(null);

    // Avatar URL lifecycle owner. Re-runs whenever the URL changes; the cleanup
    // of the previous render fires with the old URL, revoking it. Final unmount
    // fires the last cleanup. Byte-for-byte the desktop modal's effect.
    useEffect(() => () => {
      if (preview?.avatarUrl) URL.revokeObjectURL(preview.avatarUrl);
    }, [preview?.avatarUrl]);

    const handleFile = useCallback(
      async (file: File) => {
        // Clear any prior preview first — the effect cleanup above revokes the
        // old avatar URL when the state transitions to null. If parsing throws,
        // no new preview is set and no modal opens (per spec).
        setPreview(null);
        try {
          setPreview(await parseCharacterFile(file));
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t("import_error_read_card"));
        }
      },
      [t],
    );

    const { open, inputElement } = useMobileFilePicker({
      accept: ".png,.json,image/png,application/json",
      onFile: handleFile,
    });

    useImperativeHandle(ref, () => ({ openPicker: open }), [open]);

    function handleConfirm(): void {
      if (!preview || isImporting) return;
      onImportFiles([preview.file]);
      // Clearing transitions the URL to undefined → effect cleanup revokes.
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
            title={t("character_import_title")}
            subtitle={t("character_import_sub")}
            confirmLabel={t("add_to_library")}
            preview={<CharacterImportPreview preview={preview} />}
            isImporting={isImporting}
            onConfirm={handleConfirm}
            onClose={handleClose}
          />
        )}
      </>
    );
  },
);
