import { useT } from "../../i18n/context.js";
import { registerSettingsSection, SETTINGS_SECTION } from "../../lib/settings-section-registry.js";
import { Icons } from "../shared/icons.js";
import { InterfaceSettingsBody } from "./interface-settings-body.js";

export function InterfaceSettingsSection() {
  const { t } = useT();
  return (
    <section aria-label={t("settings_section_interface")}>
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("tweaks_title")}</div>
      <InterfaceSettingsBody />
    </section>
  );
}

export function registerInterfaceSettingsSection(): () => void {
  return registerSettingsSection({
    id: SETTINGS_SECTION.interface,
    icon: <Icons.Settings />,
    labelKey: "settings_section_interface",
    render: () => <InterfaceSettingsSection />,
  });
}
