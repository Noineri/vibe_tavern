/**
 * SidebarHeader — the brand + collapse/expand header bar shared by the RP
 * `Sidebar` and `CoauthorSidebar`. Extracted verbatim (E1, post-SF-4 dedup).
 *
 * Two variants selected by `sidebarCollapsed`: collapsed shows a logo-only
 * expand trigger; expanded shows the centered brand zone + a collapse button.
 * Zero behavior divergence between the two consumers.
 */
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Icons } from "../../shared/icons.js";
import { Logo } from "../../shared/Logo.js";
import type { TFn } from "./section-types.js";

export function SidebarHeader({
  sidebarCollapsed,
  setSidebarCollapsed,
  t,
}: {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  t: TFn;
}) {
  return (
    <div
      className={`flex h-[60px] shrink-0 items-center border-b border-border ${sidebarCollapsed ? "justify-center px-1.5" : "gap-2.5 px-3"}`}
    >
      {sidebarCollapsed ? (
        // Collapsed: the logo doubles as the brand mark and the expand
        // trigger (click to expand). Standard collapsed-sidebar pattern.
        <CustomTooltip content={t("sidebar_expand")} side="right">
          <button type="button"
            className="flex items-center rounded-md p-1 cursor-pointer text-t3 transition-[background,color] duration-100 hover:bg-s2 hover:text-t1"
            aria-label={t("sidebar_expand")}
            onClick={() => setSidebarCollapsed(false)}
          >
            <Logo className="h-[34px] w-[34px] shrink-0" />
          </button>
        </CustomTooltip>
      ) : (
        <>
          {/* Brand zone: fills everything left of the collapse button and
              centers its content within that zone — so the logo+text sit
              at the visual midpoint between the left edge and the button,
              not the geometric midpoint of the whole sidebar. */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2.5">
            <Logo className="h-[34px] w-[34px] shrink-0" />
            <span className="min-w-0 overflow-hidden whitespace-nowrap font-body text-[length:calc(var(--ui-fs)+1px)] font-medium tracking-[-0.01em] text-t1">{t("app_name")}</span>
          </div>
          <CustomTooltip content={t("sidebar_collapse")} side="right">
            <button type="button"
              className="iBtn shrink-0"
              aria-label={t("sidebar_collapse")}
              onClick={() => setSidebarCollapsed(true)}
            >
              <Icons.Caret direction="l" />
            </button>
          </CustomTooltip>
        </>
      )}
    </div>
  );
}
