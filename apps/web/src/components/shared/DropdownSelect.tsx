import { useState } from "react";
import * as Select from "@radix-ui/react-select";
import { cn } from "../../lib/cn.js";
import { Ic } from "./icons.js";

interface DropdownOption {
  id: string;
  label: string;
  detail?: string;
}

interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  defaultOption?: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export function DropdownSelect({
  value,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  defaultOption,
  onChange,
  className,
  disabled,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selected = options.find((o) => o.id === value);
  const display = selected?.label || value || placeholder;

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()),
  );

  // Radix Select doesn't accept empty string as value.
  // Use a sentinel for the "default" (empty) option.
  const radixValue = value || (defaultOption ? "__default__" : undefined);

  function handleValueChange(val: string) {
    onChange(val === "__default__" ? "" : val);
  }

  function handleOpenChange(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen) setSearch("");
  }

  return (
    <Select.Root
      open={open}
      onOpenChange={handleOpenChange}
      value={radixValue}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <Select.Trigger asChild>
        <button
          className={cn(
            "flex w-full items-center justify-between rounded-[6px] border border-border bg-s2 px-[13px] py-[7px] font-ui text-[13px] text-t1 transition-[border-color] duration-150 hover:border-accent",
            disabled && "pointer-events-none opacity-40",
            open && "border-accent",
            className,
          )}
        >
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
            {display}
            {selected?.detail && (
              <span className="ml-2 text-[11px] font-medium text-t2">
                {selected.detail}
              </span>
            )}
          </span>
          <span className="ml-2 shrink-0 text-t3">{Ic.caret("d")}</span>
        </button>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[200] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
          style={{ width: "var(--radix-select-trigger-width)", maxHeight: 260 }}
        >
          {/* Search input */}
          <div className="border-b border-border2 bg-s2 p-2">
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // Prevent Radix from intercepting typing in search box
                if (e.key.length === 1) e.stopPropagation();
              }}
              className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
            />
          </div>
          <Select.Viewport className="max-h-[190px] overflow-y-auto p-1">
            {defaultOption && (
              <Select.Item
                value="__default__"
                className={cn(
                  "flex cursor-pointer items-center rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
                  !value
                    ? "bg-accent-dim font-medium text-accent-t"
                    : "text-t2 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1",
                )}
              >
                <Select.ItemText>{defaultOption}</Select.ItemText>
              </Select.Item>
            )}
            {filtered.map((o) => (
              <Select.Item
                key={o.id}
                value={o.id}
                textValue={o.label}
                className={cn(
                  "flex cursor-pointer items-center rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
                  o.id === value
                    ? "bg-accent-dim font-medium text-accent-t"
                    : "text-t2 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1",
                )}
              >
                <Select.ItemText>
                  {o.label}
                  {o.detail && (
                    <span className="ml-auto text-[11px] text-t4">
                      {o.detail}
                    </span>
                  )}
                </Select.ItemText>
              </Select.Item>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">
                —
              </div>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
