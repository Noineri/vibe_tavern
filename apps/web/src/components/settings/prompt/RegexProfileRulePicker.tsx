import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { RegexPresetRecord } from "../../../api/types.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { AddButton } from "../../shared/add-button.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { EmptyState } from "../../shared/empty-state.js";
import { Icons, Ic } from "../../shared/icons.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { SearchInput } from "../../shared/SearchInput.js";

export interface RegexProfileRulePickerProps {
  /** Complete Rule collection; only records without a Profile are selectable. */
  rules: RegexPresetRecord[];
  /** Receives selected standalone Rule ids in user selection order. */
  onAttach: (ruleIds: string[]) => void;
  /** Runs whenever the picker is dismissed without attaching. */
  onCancel: () => void;
}

export function RegexProfileRulePicker({ rules, onAttach, onCancel }: RegexProfileRulePickerProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const standaloneRules = useMemo(
    () => rules.filter((rule) => rule.profileId === null),
    [rules],
  );
  const filteredRules = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return standaloneRules;
    return standaloneRules.filter((rule) => rule.name.toLocaleLowerCase().includes(query));
  }, [search, standaloneRules]);

  const openPicker = () => {
    setSearch("");
    setSelectedIds([]);
    setOpen(true);
  };
  const cancelPicker = () => {
    setOpen(false);
    setSearch("");
    setSelectedIds([]);
    onCancel();
  };
  const toggleRule = (id: string) => {
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id]
    ));
  };
  const attachSelected = () => {
    if (selectedIds.length === 0) return;
    onAttach(selectedIds);
    setOpen(false);
    setSearch("");
    setSelectedIds([]);
  };

  const body = (
    <div className="flex min-h-0 flex-col" data-testid="regex-profile-rule-picker-body">
      {standaloneRules.length === 0 ? (
        <div className="flex min-h-[180px] items-center justify-center p-4">
          <EmptyState
            icon={<Icons.Terminal />}
            title={t("promptManager.regex.pickerEmptyTitle")}
            sub={t("promptManager.regex.pickerEmptySub")}
            cta={t("promptManager.regex.pickerCancel")}
            onCta={cancelPicker}
            ctaProminent={isMobile}
          />
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border p-3">
            <SearchInput
              placeholder={t("promptManager.regex.pickerSearchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={t("promptManager.regex.pickerSearchPlaceholder")}
            />
          </div>
          <div className="min-h-0 overflow-y-auto p-2" role="group" aria-label={t("promptManager.regex.pickerTitle")}>
            {filteredRules.length === 0 ? (
              <div className="flex min-h-[180px] items-center justify-center p-2">
                <EmptyState
                  icon={<Icons.Terminal />}
                  title={t("promptManager.regex.pickerNoMatchesTitle")}
                  sub={t("promptManager.regex.pickerNoMatchesSub")}
                  cta={t("promptManager.regex.pickerClearSearch")}
                  onCta={() => setSearch("")}
                  ctaProminent={isMobile}
                />
              </div>
            ) : (
              filteredRules.map((rule) => (
                <Checkbox
                  key={rule.id}
                  checked={selectedIds.includes(rule.id)}
                  onChange={() => toggleRule(rule.id)}
                  aria-label={rule.name}
                  className={cn(
                    "min-h-11 w-full justify-between rounded-md px-3 py-2 text-[calc(var(--ui-fs)-2px)]",
                    selectedIds.includes(rule.id) ? "bg-accent-dim text-accent-t" : "hover:bg-s2",
                  )}
                  label={<span className="min-w-0 break-words text-left" title={rule.name}>{rule.name}</span>}
                />
              ))
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border p-3">
            <button
              type="button"
              className={cn(
                "cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1",
                isMobile ? "h-11" : "h-[37px]",
              )}
              onClick={cancelPicker}
            >
              {t("promptManager.regex.pickerCancel")}
            </button>
            <button
              type="button"
              disabled={selectedIds.length === 0}
              className={cn(
                "cursor-pointer rounded-md bg-accent px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50",
                isMobile ? "h-11" : "h-[37px]",
              )}
              onClick={attachSelected}
            >
              {t("promptManager.regex.pickerAttach")}
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) openPicker();
          else cancelPicker();
        }}
      >
        {/* The picker owns its controlled open state. Anchor the shared button
            on a native element instead of making AddButton a Radix trigger:
            AddButton intentionally has no forwarded ref/prop spread, so a
            Trigger-asChild can swallow the live pointer interaction. */}
        <Popover.Anchor asChild>
          <div className="inline-flex">
            <AddButton prominent onClick={openPicker}>
              <Ic.plus />
              {t("promptManager.regex.pickerTrigger")}
            </AddButton>
          </div>
        </Popover.Anchor>
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? document.body}>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={8}
              aria-label={t("promptManager.regex.pickerTitle")}
              className="glass-blur z-[220] flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              {body}
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
      {open && isMobile && (
        <BottomSheet open={true} onClose={cancelPicker} title={t("promptManager.regex.pickerTitle")}>
          <div className="flex max-h-[80dvh] min-h-0 flex-col">{body}</div>
        </BottomSheet>
      )}
    </>
  );
}
