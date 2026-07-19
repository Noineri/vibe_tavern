/**
 * `<ImportModalFooter>` — shared sticky footer for the import modal chrome.
 *
 * Extracted by IF-7 of `IMPORT_MOBILE_FLOW_PLAN.md` as the clean-win dedup of
 * the former private `ModalFooter` in `ImportModals.tsx` and the former local
 * `PreviewModalFooter` in `ImportPreviewModal.tsx` (render-byte-identical).
 *
 * Frame-level dedup (`<ImportModalFrame>` ↔ `<ImportPreviewModal>`) was
 * measured and rejected — see `decisions.md` under IF-7 for the four
 * structural divergences. Only the footer was a clean win.
 *
 * `disabled` and `busy` are independent and used differently by the two
 * consumers: desktop passes `disabled={!preview || isImporting}` because the
 * footer is mounted across dropzone/ST/parsing states where no preview exists
 * yet; mobile passes `disabled={isImporting}` only because the preview modal
 * is mounted solely once a preview exists. Both pass `busy={isImporting}` so
 * the label swaps to `t("importing")` during the import round-trip.
 */
import { useT } from "../../../i18n/context.js";

export interface ImportModalFooterProps {
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled: boolean;
  busy: boolean;
}

export function ImportModalFooter({
  onClose,
  onConfirm,
  confirmLabel,
  disabled,
  busy,
}: ImportModalFooterProps) {
  const { t } = useT();
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-3.5">
      <button
        type="button"
        className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
        onClick={onClose}
      >
        {t("cancel")}
      </button>
      <button
        type="button"
        className="h-[37px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45"
        disabled={disabled}
        onClick={onConfirm}
      >
        {busy ? t("importing") : confirmLabel}
      </button>
    </div>
  );
}
