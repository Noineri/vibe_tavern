import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { Ic } from "./icons.js";

interface DropdownOption {
  id: string;
  label: string;
  /** Extra detail rendered after label, e.g. context size */
  detail?: string;
}

interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** Show "Default" option with this label as first item */
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click (portal level)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current?.contains(e.target as Node) ||
        btnRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      setSearch("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const selected = options.find((o) => o.id === value);
  const display = selected?.label || value || placeholder;
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()),
  );

  // Compute position from button
  const rect = btnRef.current?.getBoundingClientRect();
  const dropStyle = rect
    ? { left: rect.left, top: rect.bottom + 4, width: rect.width }
    : undefined;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
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

      {open &&
        dropStyle &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[200] overflow-hidden rounded-md border border-border shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
            style={{ ...dropStyle, maxHeight: 260 }}
          >
            <div className="border-b border-border2 bg-s2 p-2">
              <input
                ref={inputRef}
                type="text"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
              />
            </div>
            <div className="max-h-[190px] overflow-y-auto bg-surface p-1">
              {defaultOption && (
                <div
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center rounded px-2.5 py-1.5 font-ui text-[12px] transition-colors",
                    !value
                      ? "bg-accent-dim font-medium text-accent-t"
                      : "text-t2 hover:bg-s2 hover:text-t1",
                  )}
                >
                  {defaultOption}
                </div>
              )}
              {filtered.map((o) => (
                <div
                  key={o.id}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center rounded px-2.5 py-1.5 font-ui text-[12px] transition-colors",
                    o.id === value
                      ? "bg-accent-dim font-medium text-accent-t"
                      : "text-t2 hover:bg-s2 hover:text-t1",
                  )}
                >
                  {o.label}
                  {o.detail && (
                    <span className="ml-auto text-[11px] text-t4">
                      {o.detail}
                    </span>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">
                  —
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
