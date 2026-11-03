import * as Popover from "@radix-ui/react-popover";
import { useT } from '../../../i18n/context.js';
import { Icons } from '../../shared/icons.js';
import { useIsMobile } from '../../../hooks/use-mobile.js';
import { InterfaceSettingsBody } from '../interface-settings-body.js';
import { useModalStore } from '../../../stores/modal-store.js';
import { SETTINGS_SECTION } from '../../../lib/settings-section-registry.js';

interface TweaksPanelProps {
  onOpenMobileAccess: () => void;
  proxyCount?: number;
  defaultProxyName?: string | null;
  onOpenProxyManager?: () => void;
}

// ── Presentational body ────────────────────────────────────────────────
// Extracted from the Radix shell so the rendered rows (theme radios, font
// sizes, language DropdownSelect, …) are testable WITHOUT a Popover.Root
// ancestor and WITHOUT the Radix Portal — which does not mount in happy-dom
// (getBoundingClientRect reports 0×0, so the Popper never anchors; see the
// NOTE in LinkBindingPopover.test.tsx). `<TweaksPanel>` below wraps this body
// in `<Popover.Content>`; the body is what the rows-coverage test renders.

export function TweaksPanelBody({ onOpenMobileAccess, proxyCount = 0, defaultProxyName = null, onOpenProxyManager = () => {} }: TweaksPanelProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  return (
    <div className="glass-blur w-[280px] rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] p-3">
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("tweaks_title")}</div>

      <InterfaceSettingsBody />

      <div className="mt-2 border-t border-border2 pt-2">
        {!isMobile && (
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
        )}
        <div className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <span className="flex items-center gap-1.5 text-[calc(var(--ui-fs)-2px)] text-t2"><Icons.Globe />{t("proxies")}</span>
            <span className="block truncate pl-[19px] font-ui text-[calc(var(--ui-fs)-3px)] text-t4">{defaultProxyName ? t("proxy_status_default", { name: defaultProxyName }) : t("proxy_status_configured", { count: proxyCount })}</span>
          </div>
          <button type="button" className="rounded bg-accent px-2.5 py-1 text-[calc(var(--ui-fs)-3px)] text-on-accent hover:opacity-90" onClick={onOpenProxyManager}>{t("manage")}</button>
        </div>
      </div>
      <button
        type="button"
        className="mt-2 flex w-full cursor-pointer items-center justify-between gap-3 border-t border-border2 pt-3 pb-1 text-left text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:text-t1"
        onClick={() => useModalStore.getState().openSettings(SETTINGS_SECTION.interface)}
      >
        <span className="flex items-center gap-1.5"><Icons.Settings />{t("settings_all")}</span>
        <Icons.Caret direction="r" />
      </button>
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
