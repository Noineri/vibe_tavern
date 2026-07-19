/**
 * `<ImportPreviewModal>` — fullscreen-on-mobile Modal wrapper for the
 * preview-then-confirm step of the mobile character/chat import flow.
 *
 * Mounts after the native file picker (IF-3 `useMobileFilePicker`) returns a
 * parsed preview. The chrome mirrors the desktop `<ImportModalFrame>` in
 * `ImportModals.tsx` byte-for-byte (header with title/subtitle/close, scrollable
 * body, sticky footer) so the only visible difference between desktop and
 * mobile is the dropzone step that lives above the preview on desktop.
 *
 * The preview content itself is the caller's responsibility — pass a
 * `<CharacterImportPreview>` or `<ChatImportPreview>` (IF-2) as the `preview`
 * prop. This component owns no parsing or preview-shape knowledge.
 *
 * Plan unit IF-4 of `IMPORT_MOBILE_FLOW_PLAN.md`. IF-5 wires the mobile
 * orchestrators that mount this modal; IF-7 may later dedup the desktop
 * `<ImportModalFrame>` + `<ModalFooter>` against this shared chrome.
 */
import type { ReactNode } from "react";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { Modal } from "../../shared/Modal.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT } from "../../../i18n/context.js";

export interface ImportPreviewModalProps {
  title: string;
  subtitle: string;
  /** Parsed preview content (typically `<CharacterImportPreview>` / `<ChatImportPreview>`). */
  preview: ReactNode;
  /** When true, the confirm button is disabled and shows the busy label. */
  isImporting: boolean;
  /** Label shown on the confirm button when not busy (caller-provided, already translated). */
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /**
   * When false, the modal is hidden. Defaults to `true` so IF-5 callers can
   * mount-and-render without threading an explicit open flag — the parent
   * orchestrator controls visibility by mounting/unmounting the component.
   */
  open?: boolean;
}

/**
 * Local copy of the private `ModalFooter` in `ImportModals.tsx`.
 *
 * `ModalFooter` is not exported there (it is shared only between
 * `CharacterImportModal` / `ChatImportModal` inside that file). Importing it
 * would either require exporting it from `ImportModals.tsx` (a desktop-flow
 * surface change outside this unit's scope) or creating an import cycle.
 * Duplicating the ~10 lines of markup preserves desktop render output
 * byte-for-byte and records the dedup target for IF-7's measurement.
 *
 * The markup, class names, button order, labels (`t("cancel")`, `t("importing")`),
 * disabled/busy behavior, and `transition-all` / `disabled:opacity-45` classes
 * are byte-identical to the original.
 */
function PreviewModalFooter(props: {
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled: boolean;
  busy: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-3.5">
      <button
        type="button"
        className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
        onClick={props.onClose}
      >
        {t("cancel")}
      </button>
      <button
        type="button"
        className="h-[37px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45"
        disabled={props.disabled}
        onClick={props.onConfirm}
      >
        {props.busy ? t("importing") : props.confirmLabel}
      </button>
    </div>
  );
}

export function ImportPreviewModal({
  title,
  subtitle,
  preview,
  isImporting,
  confirmLabel,
  onConfirm,
  onClose,
  open = true,
}: ImportPreviewModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  return (
    <Modal open={open} onClose={onClose} title={title} description={subtitle}>
      <div
        className={cn(
          "flex flex-col overflow-hidden bg-surface",
          isMobile
            ? "w-full h-full"
            : "max-h-[calc(100vh-60px)] w-[500px] max-w-[calc(100vw-32px)] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]",
        )}
      >
        <div className={cn("shrink-0", isMobile ? "px-4 pt-4" : "px-5 pt-[18px]")}>
          <div className="flex items-start justify-between">
            <div>
              <div
                className={cn(
                  "mb-0.5 font-body font-medium text-t1",
                  isMobile ? "text-lg" : "text-[calc(var(--ui-fs)+4px)]",
                )}
              >
                {title}
              </div>
              <div
                className={cn(
                  "mb-3.5 font-ui text-t3",
                  isMobile ? "text-xs" : "text-[calc(var(--ui-fs)-2px)]",
                )}
              >
                {subtitle}
              </div>
            </div>
            <button
              type="button"
              className={cn(
                "flex shrink-0 cursor-pointer items-center justify-center text-t3 transition-all hover:bg-s2 hover:text-t1",
                isMobile ? "h-10 w-10 rounded-lg active:bg-s2" : "h-8 w-8 rounded-[5px]",
              )}
              onClick={onClose}
              aria-label={t("close")}
            >
              <Icons.Close />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{preview}</div>
        <PreviewModalFooter
          onClose={onClose}
          onConfirm={onConfirm}
          confirmLabel={confirmLabel}
          disabled={isImporting}
          busy={isImporting}
        />
      </div>
    </Modal>
  );
}
