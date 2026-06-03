import React, { useEffect, useRef } from 'react';
import { useT } from '../../../i18n/context.js';
import { Icons } from '../../shared/icons.js';
import { useIsMobile } from '../../../hooks/use-mobile.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { DropdownSelect } from '../../shared/DropdownSelect.js';

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

export function TweaksPanel({ settings, setSetting, onOpenMobileAccess, onClose }: TweaksPanelProps & { onClose?: () => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isMobile) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('[data-dropdown-select-content="true"]')) return;
      if (panelRef.current && !panelRef.current.contains(target)) {
        onClose?.();
      }
    }
    // Delay to avoid the same click that opened the panel
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClick); };
  }, [isMobile, onClose]);

  if (isMobile) return null;

  const themeOptions = [
    { value: 'light', label: <Icons.sun /> },
    { value: 'dark', label: <Icons.moon /> },
  ];

  const fontSizeOptions = [
    { value: '17', label: <span className="font-body text-[11px] font-semibold">Aa</span> },
    { value: '18', label: <span className="font-body text-[13px] font-semibold">Aa</span> },
    { value: '19', label: <span className="font-body text-[15px] font-semibold">Aa</span> },
  ];

  const uiFontSizeOptions = [
    { value: '16', label: <span className="font-body text-[11px] font-semibold">Aa</span> },
    { value: '17', label: <span className="font-body text-[13px] font-semibold">Aa</span> },
    { value: '18', label: <span className="font-body text-[15px] font-semibold">Aa</span> },
  ];

  const widthOptions = [
    { value: 'narrow', label: <Icons.widthNarrow /> },
    { value: 'medium', label: <Icons.widthMedium /> },
    { value: 'wide', label: <Icons.widthWide /> },
  ];

  const langOptions = [
    { id: 'en', label: 'English' },
    { id: 'ru', label: 'Русский' },
  ];

  return (
    <div ref={panelRef} className="fixed right-4 top-[68px] z-[300] w-[280px] rounded-lg border border-border2 bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.45)] p-3">
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("tweaks_title")}</div>

      {/* Theme */}
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_theme")}</span>
        <SegmentedControl
          value={settings.theme}
          options={themeOptions}
          onChange={v => setSetting('theme', v as 'dark' | 'light')}
          compact
        />
      </div>

      {/* Message font size */}
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_font_size")}</span>
        <SegmentedControl
          value={String(settings.fontSize)}
          options={fontSizeOptions}
          onChange={v => setSetting('fontSize', parseInt(v))}
          compact
        />
      </div>

      {/* UI font size */}
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_ui_font_size")}</span>
        <SegmentedControl
          value={String(settings.uiFontSize)}
          options={uiFontSizeOptions}
          onChange={v => setSetting('uiFontSize', parseInt(v))}
          compact
        />
      </div>

      {/* Message width */}
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_message_width")}</span>
        <SegmentedControl
          value={settings.messageWidth}
          options={widthOptions}
          onChange={v => setSetting('messageWidth', v as 'narrow' | 'medium' | 'wide')}
          compact
        />
      </div>

      {/* Language */}
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_language")}</span>
        <DropdownSelect
          value={settings.lang}
          options={langOptions}
          onChange={v => setSetting('lang', v)}
          className="w-[110px]"
          searchable={false}
        />
      </div>

      <div className="mt-2 border-t border-border2 pt-2">
        <div className="flex items-center justify-between gap-3 py-2">
          <span className="flex items-center gap-1.5 text-[calc(var(--ui-fs)-2px)] text-t2">
            <Icons.phone />
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
