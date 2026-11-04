import { useState } from "react";
import { useT } from "../../i18n/context.js";
import type Resources from "../../i18n/resources.js";
import { registerSettingsSection, SETTINGS_SECTION } from "../../lib/settings-section-registry.js";
import { useSoundAlertsStore } from "../../stores/sound-alerts-store.js";
import { osNotificationsSupported, playSoundTest, primeSoundAlerts, requestOsPermission } from "../../lib/sound-alerts.js";
import { Icons } from "../shared/icons.js";
import { Toggle } from "../shared/Toggle.js";
import { SliderField } from "../shared/SliderField.js";

type EventToggleKey = "replyReady" | "imageReady" | "queueFinished" | "generationError";

/** The four owner-approved events (2026-10-06), in the plan's order. */
const EVENT_ROWS: Array<{ key: EventToggleKey; labelKey: keyof Resources["en"]; hintKey: keyof Resources["en"] }> = [
  { key: "replyReady", labelKey: "settings_sound_reply_ready", hintKey: "settings_sound_reply_ready_hint" },
  { key: "imageReady", labelKey: "settings_sound_image_ready", hintKey: "settings_sound_image_ready_hint" },
  { key: "queueFinished", labelKey: "settings_sound_queue_finished", hintKey: "settings_sound_queue_finished_hint" },
  { key: "generationError", labelKey: "settings_sound_generation_error", hintKey: "settings_sound_generation_error_hint" },
];

/** Compact canon action button (frontend skill): icon by meaning, one shape. */
const compactActionCls = "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-60";

function ToggleRow({ label, hint, checked, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[calc(var(--ui-fs)-2px)] text-t2">{label}</div>
        <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3">{hint}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

export function SoundAlertsSection() {
  const { t } = useT();
  const settings = useSoundAlertsStore((s) => s.settings);
  const setSetting = useSoundAlertsStore((s) => s.setSetting);
  const [osDenied, setOsDenied] = useState(() => osNotificationsSupported() && window.Notification.permission === "denied");

  // Every control here is a user gesture — the moment the browser allows audio.
  const onEventToggle = (key: EventToggleKey, checked: boolean) => {
    primeSoundAlerts();
    setSetting(key, checked);
  };

  const onOsToggle = async (checked: boolean) => {
    if (!checked) {
      setSetting("osNotifications", false);
      if (osNotificationsSupported()) setOsDenied(window.Notification.permission === "denied");
      return;
    }
    const permission = await requestOsPermission();
    if (permission === "granted") {
      setSetting("osNotifications", true);
      setOsDenied(false);
    } else {
      // Denied (or dismissed — nothing to show without permission): the toggle
      // returns to off, and an explicit denial gets the how-to-unblock hint.
      setSetting("osNotifications", false);
      setOsDenied(permission === "denied");
    }
  };

  return (
    <section aria-label={t("settings_section_sound")} className="space-y-6">
      <div>
        <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("settings_sound_block")}</div>
        {EVENT_ROWS.map((row) => (
          <ToggleRow
            key={row.key}
            label={t(row.labelKey)}
            hint={t(row.hintKey)}
            checked={settings[row.key]}
            onChange={(checked) => onEventToggle(row.key, checked)}
          />
        ))}
        <div className="py-2">
          {/* Store holds 0–1 (plan); the field scrubs whole percents. */}
          <SliderField
            label={t("settings_sound_volume")}
            value={Math.round(settings.volume * 100)}
            min={0}
            max={100}
            step={5}
            onChange={(value) => setSetting("volume", value / 100)}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={compactActionCls} onClick={() => playSoundTest(settings.volume)}>
            <Icons.speaker />
            {t("settings_sound_test")}
          </button>
        </div>
      </div>
      {/* Hidden wholesale where the API is absent (APK WebView check, plan
       * step 4) — an empty labeled block would read as broken. */}
      {osNotificationsSupported() && (
        <div className="border-t border-border2 pt-6">
          <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("settings_sound_notifications")}</div>
          <ToggleRow
            label={t("settings_sound_os_notifications")}
            hint={t(osDenied ? "settings_sound_os_denied_hint" : "settings_sound_os_notifications_hint")}
            checked={settings.osNotifications}
            onChange={(checked) => void onOsToggle(checked)}
          />
        </div>
      )}
    </section>
  );
}

export function registerSoundAlertsSection(): () => void {
  return registerSettingsSection({
    id: SETTINGS_SECTION.sound,
    icon: <Icons.speaker />,
    labelKey: "settings_section_sound",
    render: () => <SoundAlertsSection />,
  });
}
