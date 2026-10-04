import { useState } from "react";
import type { TFunc } from "../../../i18n/locale-helpers.js";
import { cn } from "../../../lib/cn.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { ToolbarSelect, type ToolbarSelectItem } from "../../shared/ToolbarSelect.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Ic } from "../../shared/icons.js";
import type { Tab } from "./use-lorebook-editor-state.js";
import type { Scope } from "./LorebookAccordion.js";
import { LorebookScopeBreadcrumb } from "./LorebookScopePanel.js";

export interface WorldLoreOwnerOption {
  id: string;
  name: string;
  kind: "character" | "persona";
}

interface WorldLoreOwnerFilterProps {
  isMobile: boolean;
  ownerId: string | null;
  owners: WorldLoreOwnerOption[];
  onOwnerChange: (ownerId: string | null) => void;
  testId: string;
  t: TFunc;
}

function ownerGroups(owners: WorldLoreOwnerOption[], t: TFunc) {
  return [
    {
      id: "characters",
      label: t("characters"),
      options: owners.filter((owner) => owner.kind === "character").map((owner) => ({ id: owner.id, label: owner.name })),
    },
    {
      id: "personas",
      label: t("scope_persona"),
      options: owners.filter((owner) => owner.kind === "persona").map((owner) => ({ id: owner.id, label: owner.name })),
    },
  ];
}

/** Responsive owner picker shared by the lorebook and script list headers. */
export function WorldLoreOwnerFilter({
  isMobile,
  ownerId,
  owners,
  onOwnerChange,
  testId,
  t,
}: WorldLoreOwnerFilterProps) {
  const selectedOwner = owners.find((owner) => owner.id === ownerId) ?? null;
  const label = selectedOwner?.name ?? t("lore_owner_all");
  const groups = ownerGroups(owners, t);

  if (isMobile) {
    const items: ToolbarSelectItem[] = [
      { value: "all", label: t("lore_owner_all"), searchText: t("lore_owner_all") },
      ...groups.flatMap((group) =>
        group.options.map((owner, index) => ({
          value: owner.id,
          label: owner.label,
          searchText: owner.label,
          sectionLabel: index === 0 ? group.label : undefined,
        })),
      ),
    ];
    return (
      <ToolbarSelect
        mobile
        title={t("lore_owner")}
        items={items}
        value={ownerId ?? "all"}
        onSelect={(value) => onOwnerChange(value === "all" ? null : value)}
        searchable
        searchPlaceholder={t("lore_owner_search_placeholder")}
        trigger={
          <button
            type="button"
            data-testid={testId}
            className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t3 transition-all hover:bg-s2 active:bg-s3"
          >
            <span className="max-w-36 truncate" title={selectedOwner?.name}>{label}</span>
            {Ic.caret("d")}
          </button>
        }
      />
    );
  }

  return (
    <DropdownSelect
      value={ownerId ?? ""}
      options={groups.flatMap((group) => group.options)}
      groups={groups}
      defaultOption={t("lore_owner_all")}
      searchPlaceholder={t("lore_owner_search_placeholder")}
      onChange={(value) => onOwnerChange(value || null)}
      triggerDetail={false}
      triggerTestId={testId}
      triggerClassName="flex h-8 max-w-48 shrink-0 items-center justify-between gap-1.5 rounded px-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:bg-s2 hover:text-t1"
      triggerLeading={<span>{t("lore_owner")}:</span>}
      contentWidth={260}
    />
  );
}

interface WorldLoreListHeaderProps {
  isMobile: boolean;
  scope: Scope;
  tab: Tab;
  ownerId: string | null;
  owners: WorldLoreOwnerOption[];
  nameSearch: string;
  onNameSearchChange: (value: string) => void;
  onOwnerChange: (ownerId: string | null) => void;
  onBack: () => void;
  onSwitchTab: () => void;
  onAddLorebook: () => void;
  onImportLorebook: () => void;
  onAddScript: () => void;
  onAddDiceScript: () => void;
  onImportScript: () => void;
  t: TFunc;
}

export function WorldLoreListHeader({
  isMobile,
  scope,
  tab,
  ownerId,
  owners,
  nameSearch,
  onNameSearchChange,
  onOwnerChange,
  onBack,
  onSwitchTab,
  onAddLorebook,
  onImportLorebook,
  onAddScript,
  onAddDiceScript,
  onImportScript,
  t,
}: WorldLoreListHeaderProps) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const title = tab === "lorebooks" ? t("lorebooks_card_title") : t("scripts_card_title");
  const searchPlaceholder = tab === "lorebooks" ? t("lorebook_name_search_placeholder") : t("script_name_search_placeholder");
  const testPrefix = tab === "lorebooks" ? "lorebook" : "script";
  const searchTestId = `${testPrefix}-name-search`;
  const ownerTestId = `${testPrefix}-owner-${isMobile ? "mobile" : "desktop"}`;

  return (
    <div
      className="w-full flex shrink-0 items-center gap-2 border-b border-border bg-surface"
      style={{ padding: isMobile ? "10px 12px" : "10px 20px" }}
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
        aria-label={t("back")}
        onClick={onBack}
      >
        {Ic.caret("l")}
      </button>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-dim text-accent-t">
        {tab === "lorebooks" ? <Ic.book /> : <Ic.terminal />}
      </div>
      {isMobile && mobileSearchOpen ? (
        <SearchInput
          autoFocus
          data-testid={searchTestId}
          className="min-w-0 flex-1"
          placeholder={searchPlaceholder}
          value={nameSearch}
          onChange={(event) => onNameSearchChange(event.target.value)}
          trailing={
            <button
              type="button"
              aria-label={t("close")}
              className="text-t3 hover:text-t1"
              onClick={() => setMobileSearchOpen(false)}
            >
              {Ic.close()}
            </button>
          }
        />
      ) : (
        <>
          <span className="min-w-0 truncate font-ui text-[calc(var(--ui-fs))] font-semibold text-t1">{title}</span>
          {!isMobile && <LorebookScopeBreadcrumb scope={scope} tab={tab} t={t} />}
          {!isMobile && (
            <div className="ml-auto flex min-w-0 items-center gap-1">
              {scope === "entity" && (
                <WorldLoreOwnerFilter
                  isMobile={false}
                  ownerId={ownerId}
                  owners={owners}
                  onOwnerChange={onOwnerChange}
                  testId={ownerTestId}
                  t={t}
                />
              )}
              <SearchInput
                data-testid={searchTestId}
                className="w-48"
                placeholder={searchPlaceholder}
                value={nameSearch}
                onChange={(event) => onNameSearchChange(event.target.value)}
              />
            </div>
          )}
          {isMobile && (
            <CustomTooltip content={searchPlaceholder}>
              <button
                type="button"
                data-testid={`${testPrefix}-name-search-toggle`}
                aria-label={searchPlaceholder}
                className="ml-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                onClick={() => setMobileSearchOpen(true)}
              >
                {Ic.search()}
              </button>
            </CustomTooltip>
          )}
        </>
      )}
      {!mobileSearchOpen && (
        <div className={cn("flex shrink-0 gap-1", !isMobile && "ml-1")}>
          <CustomTooltip content={tab === "lorebooks" ? t("scripts_card_title") : t("lorebooks_card_title")}>
            <button
              type="button"
              className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:bg-s2 hover:text-t1"
              aria-label={tab === "lorebooks" ? t("scripts_card_title") : t("lorebooks_card_title")}
              onClick={onSwitchTab}
            >
              {tab === "lorebooks" ? <Ic.terminal /> : <Ic.book />}
              {!isMobile && <span>{tab === "lorebooks" ? t("scripts_card_title") : t("lorebooks_card_title")}</span>}
            </button>
          </CustomTooltip>
          <div className="mx-1 h-8 w-px bg-border" />
          {tab === "lorebooks" ? (
            <>
              <CustomTooltip content={t("new_lorebook")}>
                <button type="button" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" aria-label={t("new_lorebook")} onClick={onAddLorebook}>{Ic.plus()}</button>
              </CustomTooltip>
              <CustomTooltip content={t("import_lorebook_title")}>
                <button type="button" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" aria-label={t("import_lorebook_title")} onClick={onImportLorebook}>{Ic.import()}</button>
              </CustomTooltip>
            </>
          ) : (
            <>
              <CustomTooltip content={t("new_script")}>
                <button type="button" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" aria-label={t("new_script")} onClick={onAddScript}>{Ic.plus()}</button>
              </CustomTooltip>
              <CustomTooltip content={t("new_dice_script")}>
                <button type="button" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" aria-label={t("new_dice_script")} onClick={onAddDiceScript}>{Ic.dice()}</button>
              </CustomTooltip>
              <CustomTooltip content={t("script_import")}>
                <button type="button" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" aria-label={t("script_import")} onClick={onImportScript}>{Ic.import()}</button>
              </CustomTooltip>
            </>
          )}
        </div>
      )}
    </div>
  );
}
