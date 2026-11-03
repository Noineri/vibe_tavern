import type { ReactNode } from "react";
import { useT, type TFunc } from "../../i18n/context.js";
import { LOCALES, normalizeLocale } from "../../i18n/registry.js";
import { DEFAULT_THEME, THEMES, userThemeSlug } from "../../themes/registry.js";
import { useInterfaceSettingsStore } from "../../stores/interface-settings-store.js";
import { useUserThemesStore } from "../../stores/user-themes-store.js";
import { useScriptWarningsToggle } from "../../hooks/use-script-warnings-toggle.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { Toggle } from "../shared/Toggle.js";
import { Slider } from "../shared/slider.js";

// One definition of each option set; both quick-access layouts and the modal
// consume this body. Shell chrome, preview and navigation stay with callers.
const themeOptions = THEMES.map((theme) => {
  const Icon = Icons[theme.icon];
  return { value: theme.id, label: <Icon /> };
});
const languages = LOCALES.map((locale) => ({ id: locale.id, label: locale.label }));
const widthOptions = [
  { value: "narrow" as const, label: <Icons.widthNarrow /> },
  { value: "medium" as const, label: <Icons.widthMedium /> },
  { value: "wide" as const, label: <Icons.widthWide /> },
];
const fontFields: Array<{
  id: "fontSize" | "uiFontSize";
  labelKey: Parameters<TFunc>[0];
  max: number;
  icon: ReactNode;
  options: Array<{ value: string; label: ReactNode }>;
}> = [
  {
    id: "fontSize", labelKey: "tweaks_font_size", max: 22,
    icon: <span className="font-body text-[calc(var(--ui-fs)+2px)] font-bold">A</span>,
    options: [
      { value: "17", label: <span className="font-body text-[calc(var(--ui-fs)-3px)] font-semibold">Aa</span> },
      { value: "18", label: <span className="font-body text-[calc(var(--ui-fs)-1px)] font-semibold">Aa</span> },
      { value: "19", label: <span className="font-body text-[calc(var(--ui-fs)+1px)] font-semibold">Aa</span> },
    ],
  },
  {
    id: "uiFontSize", labelKey: "tweaks_ui_font_size", max: 20, icon: <Icons.Sliders />,
    options: [
      { value: "15", label: <span className="font-body text-[calc(var(--ui-fs)-4px)] font-semibold">Aa</span> },
      { value: "17", label: <span className="font-body text-[calc(var(--ui-fs)-1px)] font-semibold">Aa</span> },
      { value: "19", label: <span className="font-body text-[calc(var(--ui-fs)+2px)] font-semibold">Aa</span> },
    ],
  },
];

function SettingRow({ mobile, label, icon, stacked = false, spaced = false, children }: {
  mobile: boolean;
  label: string;
  icon?: ReactNode;
  stacked?: boolean;
  spaced?: boolean;
  children: ReactNode;
}) {
  if (!mobile) return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{label}</span>
      {children}
    </div>
  );
  const title = (
    <>
      {icon && <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-s2 text-t2">{icon}</div>}
      <span className="font-body text-[length:var(--ui-fs)] text-t1">{label}</span>
    </>
  );
  return (
    <div className={cn("px-5", spaced ? "pt-5 pb-2.5" : "py-2.5")}>
      {stacked ? (
        <>
          <div className={cn("flex items-center gap-3", spaced ? "mb-2.5" : "mb-2")}>{title}</div>
          {children}
        </>
      ) : (
        <div className="flex min-h-[48px] items-center justify-between gap-3">
          {icon ? <div className="flex items-center gap-3">{title}</div> : title}
          {children}
        </div>
      )}
    </div>
  );
}

export function InterfaceSettingsBody({ mobile = false }: { mobile?: boolean }) {
  const { t, setLocale } = useT();
  const settings = useInterfaceSettingsStore((s) => s.settings);
  const setSetting = useInterfaceSettingsStore((s) => s.setSetting);
  const userThemes = useUserThemesStore((s) => s.themes);
  const warnings = useScriptWarningsToggle();
  const setLanguage = (value: string) => {
    const locale = normalizeLocale(value);
    setSetting("lang", locale);
    setLocale(locale);
  };

  return (
    <>
      <SettingRow mobile={mobile} spaced label={t("tweaks_theme")}>
        <SegmentedControl value={settings.theme} options={themeOptions} onChange={(value) => setSetting("theme", value)} compact={!mobile} mobileFill={mobile} ariaLabel={t("tweaks_theme")} />
      </SettingRow>
      {userThemes.length > 0 && (
        <SettingRow mobile={mobile} stacked label={t("user_theme_choice")} icon={<Icons.Settings />}>
          {/* Compact width budget: 256px content - ~90px RU label - 12px gap
              leaves ~154px for the field; filenames ellipsize only in the trigger,
              and the shared popup exposes their full wrapped value. */}
          <DropdownSelect
            value={userThemeSlug(settings.theme) ?? ""}
            options={userThemes.map((theme) => ({ id: theme.id, label: theme.name }))}
            defaultOption={t("user_theme_none")}
            onChange={(slug) => setSetting("theme", slug ? `user:${slug}` : DEFAULT_THEME)}
            className={mobile ? undefined : "min-w-0 flex-1"}
            searchable={false}
          />
        </SettingRow>
      )}
      {!mobile && (settings.theme === "dark-lava" || settings.theme === "light-lava") && (
        <SettingRow mobile={mobile} label={t("tweaks_lava_blobs")}>
          <Toggle checked={settings.lavaBlobs} onChange={(value) => setSetting("lavaBlobs", value)} aria-label={t("tweaks_lava_blobs")} />
        </SettingRow>
      )}
      {mobile && (
        <SettingRow mobile label={settings.showRail ? t("hide_rail") : t("show_rail")} icon={<Icons.Menu />}>
          <Toggle checked={settings.showRail} onChange={(value) => setSetting("showRail", value)} className="text-[calc(var(--ui-fs)+4px)]" aria-label={settings.showRail ? t("hide_rail") : t("show_rail")} />
        </SettingRow>
      )}
      {fontFields.map((field) => (
        <SettingRow key={field.id} mobile={mobile} stacked label={t(field.labelKey)} icon={field.icon}>
          {mobile ? (
            <Slider
              appearance="field" min={14} max={field.max} step={1}
              value={settings[field.id]} formatValue={(value) => `${value} px`}
              onValueChange={(value) => setSetting(field.id, Math.round(value))}
              aria-label={t(field.labelKey)}
            />
          ) : (
            <SegmentedControl value={String(settings[field.id])} options={field.options} onChange={(value) => setSetting(field.id, parseInt(value))} compact ariaLabel={t(field.labelKey)} />
          )}
        </SettingRow>
      ))}
      {!mobile && (
        <SettingRow mobile={mobile} label={t("tweaks_message_width")}>
          <SegmentedControl value={settings.messageWidth} options={widthOptions} onChange={(value) => setSetting("messageWidth", value)} compact ariaLabel={t("tweaks_message_width")} />
        </SettingRow>
      )}
      <SettingRow mobile={mobile} stacked spaced label={t("tweaks_language")} icon={<Icons.Help />}>
        {mobile ? (
          <div className="flex rounded-lg border border-border bg-s2 p-0.5">
            {languages.map((locale) => (
              <button key={locale.id} type="button"
                className={cn("flex flex-1 cursor-pointer items-center justify-center rounded-md py-2.5 font-ui text-[calc(var(--ui-fs)-3px)] transition-colors min-h-[40px]", settings.lang === locale.id ? "bg-surface text-t1 font-medium shadow-sm" : "text-t3 active:text-t2")}
                onClick={() => setLanguage(locale.id)}
              >{locale.label}</button>
            ))}
          </div>
        ) : (
          // The old w-[110px] fought DropdownSelect's baked w-full. Flexible
          // remainder sizing preserves the rendered footprint without a clash.
          <DropdownSelect value={settings.lang} options={languages} onChange={setLanguage} className="min-w-0 flex-1" searchable={false} />
        )}
      </SettingRow>
      <SettingRow mobile={mobile} label={t("tweaks_script_warnings")} icon={<Icons.alert />}>
        <Toggle checked={warnings.checked} onChange={warnings.onChange} aria-label={t("tweaks_script_warnings")} className={mobile ? "text-[calc(var(--ui-fs)+4px)]" : undefined} />
      </SettingRow>
    </>
  );
}
