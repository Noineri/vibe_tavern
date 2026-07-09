import { useEffect, useRef, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { useT } from "../../../i18n/context.js";

/**
 * Inline branch-rename control used inside the chat-row branch timeline.
 *
 * A tiny edit/commit/cancel state machine:
 *  - default renders an edit-trigger button (no input);
 *  - click reveals a focused `<input>` seeded with the initial label;
 *  - blur with a changed, non-empty value fires `onRename(trimmed)`;
 *  - blur unchanged OR empty/whitespace aborts (no `onRename`, value reset);
 *  - Escape cancels; Enter delegates to blur (which commits).
 *
 * Extracted verbatim from Sidebar.tsx (SIDEBAR_GOD_OBJECT_AUDIT step 3c) so it
 * can be characterized in isolation and reused by the extracted RichChatRow.
 */
export function SidebarBranchRename({ branchId, initialLabel, onRename }: { branchId: string; initialLabel: string; onRename: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialLabel);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useT();

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="w-full min-w-0 rounded border border-accent bg-s2 px-1 py-0.5 text-[calc(var(--ui-fs)-3px)] text-t1 outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const trimmed = value.trim();
          if (trimmed && trimmed !== initialLabel) onRename(trimmed);
          else setValue(initialLabel);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") { setValue(initialLabel); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <button
      type="button"
      className="shrink-0 cursor-pointer rounded p-0.5 text-t3 opacity-0 transition-all hover:bg-s3 hover:text-t1 group-hover/branch:opacity-100"
      onClick={(e) => { e.stopPropagation(); setValue(initialLabel); setEditing(true); }}
    >
      <Icons.Edit />
    </button>
  );
}
