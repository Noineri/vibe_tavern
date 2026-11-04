import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { getNetworkSettingsBlocks, NETWORK_SETTINGS_ORDER, registerNetworkSettingsBlock, subscribeNetworkSettingsBlocks } from "../../lib/network-settings-registry.js";
import { registerSettingsSection, SETTINGS_SECTION } from "../../lib/settings-section-registry.js";
import { useModalStore } from "../../stores/modal-store.js";
import { Icons } from "../shared/icons.js";
import { MobileAccessSection } from "./mobile-access-section.js";
import { ProxySettingsSection, type ProxySettingsSectionProps } from "./proxy-settings-section.js";

const NetworkSettingsContext = createContext<ProxySettingsSectionProps | null>(null);
/** AppShell remains the sole owner of the proxy list/default and API callbacks. */
export function NetworkSettingsProvider({ value, children }: { value: ProxySettingsSectionProps; children: ReactNode }) {
  return <NetworkSettingsContext.Provider value={value}>{children}</NetworkSettingsContext.Provider>;
}
function NetworkProxySettings() {
  const props = useContext(NetworkSettingsContext);
  if (!props) throw new Error("Network settings require the AppShell proxy source");
  return <ProxySettingsSection {...props} />;
}

export function NetworkSettingsSection() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const registered = useSyncExternalStore(subscribeNetworkSettingsBlocks, getNetworkSettingsBlocks, getNetworkSettingsBlocks);
  const visible = registered.filter((block) => !block.platform || block.platform === (isMobile ? "mobile" : "desktop"));
  return <section aria-label={t("settings_section_network")} className="space-y-6">
    {visible.map((block, index) => <div key={block.id} data-network-settings-block={block.id} className={index > 0 ? "border-t border-border2 pt-6" : undefined}>{block.render()}</div>)}
  </section>;
}

export function openNetworkSettings(): void {
  useModalStore.getState().openSettings(SETTINGS_SECTION.network);
}

export function registerNetworkSettingsSection(): () => void {
  const disposers = [
    registerNetworkSettingsBlock({ id: "proxies", order: NETWORK_SETTINGS_ORDER.proxies, render: () => <NetworkProxySettings /> }),
    registerNetworkSettingsBlock({ id: "mobile-access", order: NETWORK_SETTINGS_ORDER.mobileAccess, platform: "desktop", render: () => <MobileAccessSection /> }),
    registerSettingsSection({ id: SETTINGS_SECTION.network, icon: <Icons.Globe />, labelKey: "settings_section_network", render: () => <NetworkSettingsSection /> }),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
