import React from 'react';
import { Toggle } from '../shared/Toggle.js';
import { useT } from '../../i18n/context.js';
import { Icons } from '../shared/icons.js';
import { useIsMobile } from '../../hooks/use-mobile.js';

interface TweaksSettings {
  theme: 'dark' | 'light';
  fontSize: number;
  uiFontSize: number;
  messageWidth: 'narrow' | 'medium' | 'wide';
  lang: string;
}

interface TweaksPanelProps {
  settings: TweaksSettings;
  setSetting: <K extends keyof TweaksSettings>(key: K, value: TweaksSettings[K]) => void;
  onOpenMobileAccess: () => void;
}

export function TweaksPanel({ settings, setSetting, onOpenMobileAccess }: TweaksPanelProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return (
    <div className="fixed right-4 top-[68px] z-[300] w-[260px] rounded-lg border border-border2 bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.45)] p-3">
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("tweaks_title")}</div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_dark_theme")}</span>
        <Toggle checked={settings.theme === 'dark'} onChange={checked => setSetting('theme', checked ? 'dark' : 'light')} />
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_font_size")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none pl-[7px] sel-arrow" value={settings.fontSize} onChange={e => setSetting('fontSize', parseInt(e.target.value))}>
          <option value={17}>{t("tweaks_small")}</option>
          <option value={18}>{t("tweaks_medium")}</option>
          <option value={19}>{t("tweaks_large")}</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_ui_font_size")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none pl-[7px] sel-arrow" value={settings.uiFontSize} onChange={e => setSetting('uiFontSize', parseInt(e.target.value))}>
          <option value={16}>{t("tweaks_small")}</option>
          <option value={17}>{t("tweaks_medium")}</option>
          <option value={18}>{t("tweaks_large")}</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_message_width")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none pl-[7px] sel-arrow" value={settings.messageWidth} onChange={e => setSetting('messageWidth', e.target.value as 'narrow' | 'medium' | 'wide')}>
          <option value="narrow">{t("tweaks_narrow")}</option>
          <option value="medium">{t("tweaks_medium")}</option>
          <option value="wide">{t("tweaks_wide")}</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_language")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none pl-[7px] sel-arrow" value={settings.lang} onChange={e => setSetting('lang', e.target.value)}>
          <option value="en">EN</option>
          <option value="ru">RU</option>
        </select>
      </div>
      <div className="mt-2 border-t border-border2 pt-2">
        <div className="flex items-center justify-between gap-3 py-2">
          <span className="flex items-center gap-1.5 text-[calc(var(--ui-fs)-2px)] text-t2">
            <Icons.Phone />
            {t("mobile_access")}
          </span>
          <button type="button"
            className="rounded bg-accent px-2.5 py-1 text-[calc(var(--ui-fs)-3px)] text-on-accent hover:opacity-90"
            onClick={onOpenMobileAccess}
          >{t("mobile_access_enable")}</button>
        </div>
      </div>
    </div>
  );
}
