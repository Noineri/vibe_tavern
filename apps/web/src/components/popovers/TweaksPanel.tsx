import React from 'react';
import { Toggle } from '../shared/Toggle.js';

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
  t: (key: string) => string;
}

export function TweaksPanel({ settings, setSetting, t }: TweaksPanelProps) {
  return (
    <div className="fixed right-4 top-[68px] z-[300] w-[260px] rounded-lg border border-border2 bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.45)]" style={{padding:'12px'}}>
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("settings_interface")}</div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("twDark")}</span>
        <Toggle checked={settings.theme === 'dark'} onChange={checked => setSetting('theme', checked ? 'dark' : 'light')} />
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("twFontSize")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none" style={{paddingLeft:'7px',paddingRight:'7px'}} value={settings.fontSize} onChange={e => setSetting('fontSize', parseInt(e.target.value))}>
          <option value={17}>{t("twSmall")}</option>
          <option value={18}>{t("twMedium")}</option>
          <option value={19}>{t("twLarge")}</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("twUiFontSize")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none" style={{paddingLeft:'7px',paddingRight:'7px'}} value={settings.uiFontSize} onChange={e => setSetting('uiFontSize', parseInt(e.target.value))}>
          <option value={16}>{t("twSmall")}</option>
          <option value={17}>{t("twMedium")}</option>
          <option value={18}>{t("twLarge")}</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("twWidth")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none" style={{paddingLeft:'7px',paddingRight:'7px'}} value={settings.messageWidth} onChange={e => setSetting('messageWidth', e.target.value as 'narrow' | 'medium' | 'wide')}>
          <option value="narrow">{t("twNarrow")}</option>
          <option value="medium">{t("twMedium")}</option>
          <option value="wide">{t("twWide")}</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("twLang")}</span>
        <select className="rounded border border-border bg-s2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 outline-none" style={{paddingLeft:'7px',paddingRight:'7px'}} value={settings.lang} onChange={e => setSetting('lang', e.target.value)}>
          <option value="en">EN</option>
          <option value="ru">RU</option>
        </select>
      </div>
    </div>
  );
}
