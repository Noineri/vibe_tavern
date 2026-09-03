import { useState, useRef, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { cn } from "../../lib/cn.js";
import { Ic } from "./icons.js";
import { getModalPortal } from "./modal-helpers.js";

// cmdk (and Radix Select before it) cannot represent an empty-string value as a
// real selectable item: an empty value is treated as "no value". The sentinel
// stands in for the empty choice; handleSelect() maps it back to "".
const EMPTY_VALUE = "__dropdown_select_empty__";

interface DropdownOption {
  id: string;
  /** Plain string for searchable use; may be any ReactNode when the label
   *  carries an icon (ReactNode labels simply never match a search query —
   *  they stay visible instead of silently disappearing). Passed through
   *  unchanged by SegmentedControl's mobileSelect mode. */
  label: ReactNode;
  detail?: string;
  /** Optional trailing action node rendered at the item's right edge inside
   *  the dropdown (e.g. per-version rename/delete icons). Pointer events on it
   *  are stopped so tapping the action does NOT also select the option. */
  trailing?: ReactNode;
}

interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  /** Optional grouped rendering (e.g. "Favorites" above "All models"). When
 *  provided, the list renders one section per group with an optional label
 *  header; `options` continues to drive the trigger's display value. Search
 *  filters within every group and hides empty groups. */
  groups?: Array<{ id: string; label?: string; options: DropdownOption[] }>;
  placeholder?: string;
  searchPlaceholder?: string;
  defaultOption?: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  /** When provided, REPLACES the default trigger chrome entirely (the caller
 *  owns the full class string — cn is a plain join, so conflicting utilities
 *  cannot be "overridden"; a full replacement avoids that fight). */
  triggerClassName?: string;
  /** Optional data-testid for the trigger button (matching ToolbarSelect's
 *  caller-owned trigger testid convention). */
  triggerTestId?: string;
  /** Optional node rendered before the display label (e.g. a leading icon). */
  triggerLeading?: ReactNode;
  /** Popover side relative to the trigger. Defaults to "bottom"; sites whose
 *  trigger sits at the bottom of a panel (chat input bars) pass "top". */
  side?: "top" | "bottom";
  /** Fixed popup width in px. Decouples the dropdown from the trigger's width
 *  (mirrors ToolbarSelect's `contentWidth`): a trigger clamped narrow for
 *  layout stability (e.g. w-[240px] in a chat input bar) can still open a
 *  wide popup when the options need more room (long model ids + trailing
 *  star + context length). Default: follow the trigger width. */
  contentWidth?: number;
}

// Built on cmdk (Command) + Radix Popover: a real searchable combobox.
// cmdk keeps the search input focused while arrow keys move the active item
// (roving via aria-activedescendant), so typing ↔ arrow ↔ typing just works.
// The previous implementation nested a free-text <input> inside Radix Select;
// Radix Select's keyboard model is focus-roving over its own items, so blurring
// the input to "hand off" to item nav landed focus on <body> and ArrowUp/Down
// were no-ops. cmdk's single focus scope fixes that.
export function DropdownSelect({
  value,
  options,
  groups,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  defaultOption,
  onChange,
  className,
  disabled,
  searchable = true,
  triggerClassName,
  triggerTestId,
  triggerLeading,
  side = "bottom",
  contentWidth,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const commandRef = useRef<HTMLDivElement>(null);

  const selected = (groups ? groups.flatMap((g) => g.options) : options).find((o) => o.id === value);
  const display = selected?.label || value || placeholder;

  const matches = (o: DropdownOption) =>
    // ReactNode labels have no searchable text — keep them visible rather
    // than filtering them out of existence on every query.
    !searchable || (typeof o.label === "string" ? o.label.toLowerCase().includes(search.toLowerCase()) : true);

  const filtered = options
    .filter((o) => o.id !== "") // empty-id options rendered as defaultOption below
    .filter(matches);

  const filteredGroups = groups?.map((g) => ({
    ...g,
    options: g.options.filter((o) => o.id !== "").filter(matches),
  }));
  const flatGroupedCount = filteredGroups?.reduce((n, g) => n + g.options.length, 0) ?? 0;

  function handleSelect(id: string) {
    onChange(id);
    setOpen(false);
  }

  function handleOpenChange(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen && searchable) setSearch("");
  }

  // cmdk auto-focuses its Command.Input when present (searchable mode). In
  // non-searchable mode there is no input, so move focus onto the Command root
  // — its keydown handler drives arrow/enter navigation over the items.
  function handleOpenAutoFocus(e: Event) {
    if (!searchable) {
      e.preventDefault();
      commandRef.current?.focus();
    }
  }

  // When inside a Modal, portal into the Modal's anchor element so the content
  // stays within Dialog's focus trap. When outside a Modal, portal to body.
  const portalContainer = getModalPortal() ?? undefined;

  function renderOption(o: DropdownOption) {
    return (
      <Command.Item
        key={o.id}
        value={o.id}
        onSelect={() => handleSelect(o.id)}
        className={cn(
          "flex cursor-pointer items-center rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
          // cmdk sets data-selected="true"|"false" on every item, so the
          // selector must pin the value (=true) — bare data-[selected]
          // (presence) matches both and hides the active highlight.
          o.id === value
            ? "bg-accent-dim font-medium text-accent-t"
            : "text-t1 hover:bg-s2 data-[selected=true]:bg-s2",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{o.label}</span>
          {o.detail && (
            <span className="shrink-0 text-[11px] text-t2">
              {o.detail}
            </span>
          )}
        </span>
        {o.trailing && (
          // Stop pointer events so clicking a trailing action (rename /
          // delete) does NOT fire the cmdk item's onSelect.
          <span
            className="ml-auto flex shrink-0 items-center gap-0.5"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {o.trailing}
          </span>
        )}
      </Command.Item>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid={triggerTestId}
          disabled={disabled}
          className={cn(
            "flex items-center justify-between gap-2 font-ui transition-colors duration-150",
            triggerClassName ??
              "w-full rounded-[6px] border border-border bg-s2 px-[13px] py-[7px] text-[13px] text-t1 hover:border-accent" +
                (open ? " border-accent" : ""),
            disabled && "pointer-events-none opacity-40",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {triggerLeading}
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
              {display}
              {selected?.detail && (
                <span className="ml-2 text-[11px] font-medium text-t2">
                  {selected.detail}
                </span>
              )}
            </span>
          </span>
          <span className="ml-2 shrink-0 text-t3">{Ic.caret("d")}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal container={portalContainer}>
        <Popover.Content
          side={side}
          sideOffset={4}
          align="start"
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="glass-blur z-[400] overflow-hidden rounded-md border border-border bg-glass-bg shadow-[0_8px_30px_rgba(0,0,0,0.6)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          style={{
            width: contentWidth ?? "var(--radix-popover-trigger-width)",
            maxHeight: 260,
          }}
        >
          <Command
            ref={commandRef}
            shouldFilter={false}
            loop
            className="flex flex-col outline-none"
          >
            {searchable && (
              <div className="border-b border-border2 bg-s2 p-2">
                <Command.Input
                  placeholder={searchPlaceholder}
                  value={search}
                  onValueChange={setSearch}
                  className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
                />
              </div>
            )}
            <Command.List
              className={cn(
                searchable ? "max-h-[190px]" : "max-h-[240px]",
                "overflow-y-auto p-1",
              )}
            >
              {defaultOption && (
                <Command.Item
                  value={EMPTY_VALUE}
                  onSelect={() => handleSelect("")}
                  className={cn(
                    "flex cursor-pointer items-center rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
                    !value
                      ? "bg-accent-dim font-medium text-accent-t"
                      : "text-t1 hover:bg-s2 data-[selected=true]:bg-s2",
                  )}
                >
                  {defaultOption}
                </Command.Item>
              )}
              {filteredGroups
                ? filteredGroups.map((g) =>
                    g.options.length > 0 ? (
                      <div key={g.id}>
                        {g.label && (
                          <div className="px-2.5 pb-0.5 pt-1.5 font-ui text-[10.5px] font-medium uppercase tracking-wide text-t3">
                            {g.label}
                          </div>
                        )}
                        {g.options.map(renderOption)}
                      </div>
                    ) : null,
                  )
                : filtered.map(renderOption)}
              {(filteredGroups ? flatGroupedCount === 0 : filtered.length === 0) && (
                <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">
                  —
                </div>
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
