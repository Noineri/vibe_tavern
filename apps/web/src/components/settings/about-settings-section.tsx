import { useEffect, useState } from "react";
import { useT } from "../../i18n/context.js";
import { registerSettingsSection, SETTINGS_SECTION } from "../../lib/settings-section-registry.js";
import { Icons } from "../shared/icons.js";
import { Logo } from "../shared/Logo.js";
import { fetchRuntimeInfo, type RuntimeInfo } from "../../api/runtime-api.js";
import * as buildConfig from "../../build-config.js";
import { AboutUpdateBlock } from "./about-update-block.js";

/** Best-effort OS label for the header line; "" when nothing recognizable. */
function detectOsLabel(): string {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  const ua = navigator.userAgent;
  if (/android/i.test(ua) || /android/i.test(platform)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua) || /iphone|ipad|ipod/i.test(platform)) return "iOS";
  if (/win/i.test(platform) || /windows/i.test(ua)) return "Windows";
  if (/mac/i.test(platform)) return "macOS";
  if (/cros/i.test(platform)) return "ChromeOS";
  if (/linux/i.test(platform) || /linux/i.test(ua)) return "Linux";
  return "";
}

const INSTALL_KIND_KEYS = {
  standalone: "settings_about_install_standalone",
  "inno-setup": "settings_about_install_inno_setup",
  docker: "settings_about_install_docker",
  npm: "settings_about_install_npm",
  android: "settings_about_install_android",
  dev: "settings_about_install_dev",
} as const;

export function AboutSettingsSection() {
  const { t } = useT();
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await fetchRuntimeInfo();
        if (!cancelled) setRuntimeInfo(info);
      } catch {
        // Header falls back to the build-config version; the update block
        // runs its own fetch with its own failure handling.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const version = runtimeInfo?.currentVersion ?? buildConfig.APP_VERSION;
  const installKind = runtimeInfo?.installKind;
  const metaParts = [detectOsLabel(), installKind ? t(INSTALL_KIND_KEYS[installKind]) : ""].filter(Boolean);
  return (
    <section aria-label={t("settings_section_about")} className="space-y-6">
      <div className="flex items-center gap-3">
        <Logo className="h-11 w-11 shrink-0" />
        <div className="min-w-0">
          <div className="font-ui text-[calc(var(--ui-fs)+2px)] font-semibold text-t1">Vibe Tavern {version}</div>
          {metaParts.length > 0 && (
            <div className="mt-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{metaParts.join(" · ")}</div>
          )}
        </div>
      </div>
      <div className="border-t border-border2 pt-6">
        <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("settings_about_updates")}</div>
        <AboutUpdateBlock runtimeInfo={runtimeInfo} />
      </div>
    </section>
  );
}

export function registerAboutSettingsSection(): () => void {
  return registerSettingsSection({
    id: SETTINGS_SECTION.about,
    icon: <Icons.help />,
    labelKey: "settings_section_about",
    render: () => <AboutSettingsSection />,
  });
}
