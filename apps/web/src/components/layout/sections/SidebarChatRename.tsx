import { useState } from "react";

/**
 * Inline chat-title rename input used inside `RichChatRow`.
 *
 * The chat rename is ENTERED via the row's context menu (not a pencil button),
 * so unlike `SidebarBranchRename` this control is mounted/unmounted by the
 * parent (RichChatRow's `renaming` flag) and is always an `<input>` while
 * present. It owns only the draft + the commit/abort state machine:
 *  - seeded with `initialValue` on mount;
 *  - Enter or blur with a changed, non-empty value fires `onCommit(trimmed)`;
 *  - Enter or blur UNCHANGED or empty/whitespace fires `onCancel` (abort);
 *  - Escape fires `onCancel`.
 *
 * Extracted verbatim from the RichChatRow inline input
 * (SIDEBAR_GOD_OBJECT_AUDIT step 3c) so the commit/abort logic is unit-testable
 * in isolation — the context menu that triggers rename is a Radix
 * `DropdownMenu` whose `Content` does not mount under happy-dom (see
 * `DropdownSelect.test.tsx`'s skip note, re-verified to still hold under vitest),
 * so the only way to pin the rename contract in a unit test is to lift the input
 * into its own component.
 */
export function SidebarChatRename({
  initialValue,
  onCommit,
  onCancel,
  className,
}: {
  initialValue: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
  className: string;
}) {
  const [draft, setDraft] = useState(initialValue);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === initialValue.trim()) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      className={className}
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
