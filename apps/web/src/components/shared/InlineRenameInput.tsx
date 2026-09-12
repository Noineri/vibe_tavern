import { cn } from "../../lib/cn.js";

export type InlineRenameInputProps = Omit<React.ComponentProps<"input">, "className"> & {
  /** Optional extension appended AFTER the canon base (same composition
   *  contract as TextInput: base first, extension last, `!`-overrides where
   *  the base must lose). */
  className?: string;
};

/**
 * The canonical inline rename field (FIELD_SYSTEM_UNIFICATION_REPORT FS-8c).
 *
 * The app had ~17 hand-rolled "click a name in a list row → a compact input
 * appears" shapes (sidebar chat/branch renames, preset + regex list renames,
 * service prompts pane, lorebook accordion, coauthor rail, character chats
 * sheet) — same gesture, but each site carried its own padding, font-size and
 * border dialect. FS-8c (owner 2026-09-10, «не открытые, запиши как
 * предложил») made this a DESIGNED family with one shape: the canon single-line
 * field minus the height, with the ACCENT border as the edit-state marker —
 * you are always inside "rename mode" while this input is visible, so the
 * accent border is not a focus state, it is the mode signal.
 *
 * This component owns ONLY the chrome. The commit/abort state machine stays
 * with the caller (see SidebarChatRename / SidebarBranchRename): seeding the
 * draft, Enter/blur commit, Escape cancel, stopPropagation on row clicks.
 */
export function InlineRenameInput({ className, type = "text", ...rest }: InlineRenameInputProps) {
  return (
    <input
      {...rest}
      type={type}
      className={cn(
        "w-full min-w-0 rounded border border-accent bg-s2 px-2 py-[5px] font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t3/60",
        className,
      )}
    />
  );
}
