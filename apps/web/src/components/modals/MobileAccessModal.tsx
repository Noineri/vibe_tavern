import { useT } from "../../i18n/context.js";
import { MobileAccessSection } from "../settings/mobile-access-section.js";
import { Modal } from "../shared/Modal.js";
import { Icons } from "../shared/icons.js";

/** Transitional opener; removed once the real Network section is wired. */
export function MobileAccessModal({ open, onClose, onDisabled }: { open: boolean; onClose: () => void; onDisabled: () => void }) {
  const { t } = useT();
  if (!open) return null;
  return <Modal open onClose={onClose}>
    <div className="glass-blur-under w-[360px] overflow-hidden rounded-lg border border-border2 p-5 shadow-xl">
      <div className="mb-4 flex justify-end">
        <button type="button" aria-label={t("close")} onClick={onClose} className="text-t3 hover:text-t1"><Icons.Close /></button>
      </div>
      <MobileAccessSection onDisabled={() => { onDisabled(); onClose(); }} />
    </div>
  </Modal>;
}
