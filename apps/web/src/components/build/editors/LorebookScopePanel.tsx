import type { ReactNode } from "react";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import type { TFunc } from "../../../i18n/locale-helpers.js";
import type { Tab } from "./use-lorebook-editor-state.js";
import type { Scope } from "./LorebookAccordion.js";

interface LorebookScopePanelProps {
  isMobile: boolean;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  tab: Tab;
  mobileOwnerFilter?: ReactNode;
  t: TFunc;
}

interface LorebookScopeBreadcrumbProps {
  scope: Scope;
  tab: Tab;
  t: TFunc;
}

function getScopeItems(tab: Tab, t: TFunc): { id: Scope; icon: ReactNode; label: string }[] {
  // The "all" label depends on the active tab — "All lorebooks" / "All scripts".
  // Other scope names (Global/Entity/...) are invariant across tabs.
  const allLabel = tab === "lorebooks" ? t("scope_all") : t("scope_all_scripts");
  return [
    { id: "all", icon: <Ic.stack />, label: allLabel },
    ...(tab === "lorebooks"
      ? [{ id: "current" as const, icon: <Ic.target />, label: t("scope_current") }]
      : []),
    { id: "global", icon: <Ic.globe />, label: t("scope_global") },
    { id: "entity", icon: <Ic.book />, label: t("scope_entity") },
    { id: "chat", icon: <Ic.chat />, label: t("scope_chat") },
  ];
}

export function LorebookScopePanel({
  isMobile,
  scope,
  onScopeChange,
  tab,
  mobileOwnerFilter,
  t,
}: LorebookScopePanelProps) {
  const scopeItems = getScopeItems(tab, t);

  // ── Scope column (desktop: vertical with icons) ──
  if (!isMobile) {
    return (
      <div
        className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-surface"
        style={{ width: 48, padding: "12px 0" }}
      >
        {scopeItems.map((s) => (
          <CustomTooltip content={s.label} key={s.id}>
            <div
              className={cn(
                "relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-all hover:bg-s2",
                scope === s.id && "bg-accent-dim text-accent-t"
              )}
              onClick={() => onScopeChange(s.id)}
            >
              {s.icon}
            </div>
          </CustomTooltip>
        ))}
      </div>
    );
  }

  // ── Scope bar (mobile: horizontal chips) ──
  return (
    <div
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border scrollbar-hide"
      style={{ padding: "8px 12px" }}
    >
      {scopeItems.map((s) => (
        <div
          key={s.id}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 font-ui text-[11px] font-medium transition-all select-none",
            scope === s.id
              ? "bg-accent text-on-accent"
              : "text-t3 bg-transparent hover:bg-s2 active:bg-s3"
          )}
          onClick={() => onScopeChange(s.id)}
        >
          <span className="flex h-4 w-4 items-center justify-center">
            {s.icon}
          </span>
          <span className="whitespace-nowrap">{s.label}</span>
        </div>
      ))}
      {scope === "entity" && mobileOwnerFilter}
    </div>
  );
}

export function LorebookScopeBreadcrumb({
  scope,
  tab,
  t,
}: LorebookScopeBreadcrumbProps) {
  const scopeItems = getScopeItems(tab, t);
  const activeScope = scopeItems.find((s) => s.id === scope);
  if (!activeScope) return null;

  return (
    <>
      <span className="text-t4">/</span>
      <span className="flex min-w-0 items-center gap-1 font-ui text-[13px] font-medium text-t3">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{activeScope.icon}</span>
        <span className="truncate">{activeScope.label}</span>
      </span>
    </>
  );
}
