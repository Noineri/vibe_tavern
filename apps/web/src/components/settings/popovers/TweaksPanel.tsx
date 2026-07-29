import * as Popover from "@radix-ui/react-popover";
import { useT } from '../../../i18n/context.js';
import { LOCALES } from '../../../i18n/registry.js';
import { Icons } from '../../shared/icons.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { DropdownSelect } from '../../shared/DropdownSelect.js';
import { Toggle } from '../../shared/Toggle.js';
import { THEMES, type ThemeMode } from '../../../themes/registry.js';

interface TweaksSettings {
  theme: ThemeMode;
  fontSize: number;
  uiFontSize: number;
  messageWidth: 'narrow' | 'medium' | 'wide';
  lang: string;
  lavaBlobs: boolean;
}

interface TweaksPanelProps {
  settings: TweaksSettings;
  setSetting: <K extends keyof TweaksSettings>(key: K, value: TweaksSettings[K]) => void;
  onOpenMobileAccess: () => void;
}

// ── Presentational body ────────────────────────────────────────────────
// Extracted from the Radix shell so the rendered rows (theme radios, font
// sizes, language DropdownSelect, …) are testable WITHOUT a Popover.Root
// ancestor and WITHOUT the Radix Portal — which does not mount in happy-dom
// (getBoundingClientRect reports 0×0, so the Popper never anchors; see the
// NOTE in LinkBindingPopover.test.tsx). `<TweaksPanel>` below wraps this body
// in `<Popover.Content>`; the body is what the rows-coverage test renders.

export function TweaksPanelBody({ settings, setSetting, onOpenMobileAccess }: TweaksPanelProps) {
  const { t } = useT();

  // Theme options derive from the registry — a newly added theme appears
  // here automatically (no hardcoded icon list to keep in sync).
  const themeOptions = THEMES.map((tm) => {
    const Icon = Icons[tm.icon];
    return { value: tm.id, label: <Icon /> };
  });

  const fontSizeOptions = [
    { value: '17', label: <span className="font-body text-[11px] font-semibold">Aa</span> },
    { value: '18', label: <span className="font-body text-[13px] font-semibold">Aa</span> },
    { value: '19', label: <span className="font-body text-[15px] font-semibold">Aa</span> },
  ];

  const uiFontSizeOptions = [
    { value: '15', label: <span className="font-body text-[10px] font-semibold">Aa</span> },
    { value: '17', label: <span className="font-body text-[13px] font-semibold">Aa</span> },
    { value: '19', label: <span className="font-body text-[16px] font-semibold">Aa</span> },
  ];

  const widthOptions = [
    { value: 'narrow', label: <Icons.widthNarrow /> },
    { value: 'medium', label: <Icons.widthMedium /> },
    { value: 'wide', label: <Icons.widthWide /> },
  ];

  const langOptions = LOCALES.map((l) => ({ id: l.id, label: l.label }));

  return (
    <div className="glass-blur w-[280px] rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] p-3">
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("tweaks_title")}</div>

      {/* Theme */}
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_theme")}</span>
        <SegmentedControl
          value={settings.theme}
          options={themeOptions}
          onChange={v => setSetting('theme', v as ThemeMode)}
          compact
        />
      </div>

      {/* Lava blobs — relevant on lava themes (the WebGL lamp). */}
      {(settings.theme === 'dark-lava' || settings.theme === 'light-lava') && (
        <div className="flex items-center justify-between gap-3 py-2">
          <span className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("tweaks_lava_blobs")}</span>
          <Toggle checked={settings.lavaBlobs} onChange={(v) => setSetting('lavaBlobs', v)} />
        </div>
      )}

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

// ── Radix Popover shell ────────────────────────────────────────────────
// Desktop interface-settings popover. Migrated from a hand-rolled `fixed` div
// + document `mousedown` listener to the shared Radix Popover primitive every
// other settings popover already uses (QuickSwitchPopover, TokenCounterPopover,
// LinkBindingPopover — §9). Radix anchors Content to the Trigger (correct in
// every mode), plays enter/exit animation via Presence, and — critically for
// the nested language DropdownSelect — coordinates outside-click via the
// DismissableLayer stack: opening the inner Popover makes it topmost, so a
// click on a language option dismisses the inner FIRST and leaves this panel
// open. The old hand-rolled guard checked a `data-dropdown-select-content`
// attribute that DropdownSelect never actually emitted (dead guard), so a
// language click hit the portaled option (outside `panelRef`) and closed this
// panel before cmdk's `onSelect` could fire — the language could not be
// switched. Radix removes that race by construction; the guard is gone.

export function TweaksPanel(props: TweaksPanelProps) {
  return (
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="z-[300] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
      >
        <TweaksPanelBody {...props} />
      </Popover.Content>
    </Popover.Portal>
  );
}
