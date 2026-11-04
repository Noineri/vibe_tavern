import { useLayoutEffect } from "react";
import { ProxySettingsSection, type ProxySettingsSectionProps } from "../src/components/settings/proxy-settings-section.js";
import { SettingsModal } from "../src/components/modals/SettingsModal.js";
import { TooltipProvider } from "../src/components/shared/Tooltip.js";
import { getSettingsSections, registerSettingsSection } from "../src/lib/settings-section-registry.js";

/** Real modal boundary shared by proxy characterization and section tests. */
export function ProxySettingsTestHost(props: ProxySettingsSectionProps) {
  useLayoutEffect(() => {
    const previous = getSettingsSections().find((section) => section.id === "network");
    const dispose = registerSettingsSection({ id: "network", icon: null, labelKey: "settings_section_network", render: () => <ProxySettingsSection {...props} /> });
    return () => { dispose(); if (previous) registerSettingsSection(previous); };
  }, [props]);
  return <TooltipProvider><SettingsModal /></TooltipProvider>;
}
