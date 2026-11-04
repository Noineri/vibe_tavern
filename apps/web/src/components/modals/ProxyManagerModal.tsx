import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";
import { ProxySettingsSection, type ProxySettingsSectionProps } from "../settings/proxy-settings-section.js";
import { SettingsSectionHost } from "../settings/settings-section-lifecycle.js";
import { Modal } from "../shared/Modal.js";
import { ScrollArea } from "../shared/scroll-area.js";
import { modalPanelCls } from "../shared/modal-helpers.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";

/** Transitional opener only; SM-4d removes it after registering the real Network section. */
export function ProxyManagerModal(props: ProxySettingsSectionProps) {
  const { t } = useT();
  const isOpen = useModalStore((state) => state.isProxyManagerOpen);
  if (!isOpen) return null;
  return <SettingsSectionHost onClose={() => useModalStore.getState().setIsProxyManagerOpen(false)}>
    {({ footer, requestClose }) => <Modal open onClose={requestClose}>
      <div className={cn(modalPanelCls, "flex h-[600px] w-[760px] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-60px)] flex-col")}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="font-ui text-[calc(var(--ui-fs)+2px)] text-t1">{t("proxy_manager_title")}</h2>
          <button type="button" aria-label={t("close")} className="text-t3 hover:text-t1" onClick={requestClose}><Icons.Close /></button>
        </div>
        <ScrollArea scrollbarSize="thin" className="flex-1" contentClassName="p-5"><ProxySettingsSection {...props} /></ScrollArea>
        {footer}
      </div>
    </Modal>}
  </SettingsSectionHost>;
}
