import { useState } from "react";
import { AutoTextarea } from "../auto-textarea.js";
import { MobileExpandTextarea } from "../MobileExpandTextarea.js";
import type { AgentI18nKey } from "../../../lib/agent-host-registry.js";
import { useT } from "../../../i18n/context.js";

// fork #1 of the RP message edit (chat/MessageBlock.tsx).
// Correspondence map (reference → clone, slots + control types):
// - `MobileExpandTextarea` wrapping `AutoTextarea` (the mobile expand arm +
//   the inline textarea, slot: the box replacing the user bubble) → the same
//   pair, the same nesting, the same `label={t("edit")}`.
// - `AutoTextarea` (`minRows={7}`, accent border, Esc cancels, autoFocus) →
//   the same props; the message-typography overrides ADAPT to the edited
//   object (NAMED adaptation: the shell user bubble is
//   font-ui / ui-fs-1px / leading-1.5, not the RP font-body / mfs / 1.65 —
//   the editor text matches the message it replaces, which is the point of
//   the overrides on both sides).
// - the button pair (primary + secondary, `rounded-[5px] px-3 py-[5px]`,
//   hover arms, disabled while busy, `mt-1.5 flex gap-1.5` layout) → the same
//   shape; the row aligns `justify-end` (NAMED slot adaptation: the shell
//   user column is right-aligned, the RP message is full-width). NAMED
//   deviations: (1) the primary label is `send` («Отправить») — this resends
//   (delete + send), it does not save; (2) the primary also disables on a
//   blank draft (the RP keeps save enabled — a resend has no empty-message
//   path, the send seam trims and drops blanks, so a live button that
//   silently no-ops would lie); the `disabled:opacity-50` affordance the
//   blank-disable needs is carried on both buttons (the RP pair omits it);
//   (3) the button text follows the shell ui-fs ladder
//   (`text-[calc(var(--ui-fs)-3px)]`) instead of the RP pair's fixed size
//   (was a fixed Tailwind size before the font audit, step 8; the frontend skill bans
//   raw Tailwind size classes in new chrome).
// - the RP draft lives in `useChatStore` (`setEditingDraft`) → NAMED
//   deviation: LOCAL `useState` draft here (the agent shell has no chat store
//   seam; at most one editor exists at a time — the last user row only).
// i18n: reuses the existing `edit` (the fullscreen-expander label), `send`
// (the primary) and `cancel_edit` keys — no new keys. RU renders the shared
// «Редактировать», not a literal «Изменить» (named wording note — the `edit`
// key is the concept's one spelling; a second key for the same verb would be
// a duplicate source).
// AP-32: the assistant's in-place save reuses this SAME editor with
// `submitLabelKey="save"` (the existing `save` key — «Сохранить») and
// `layout="assistant"` (flat full width, left-aligned pair); the user's
// `send` default and bubble shape are untouched.
export interface AgentEditMessageProps {
  /** The message text the editor opens with. */
  initialText: string;
  /** Follows the controller's `isSending` — both buttons disable, and the
   *  block closes an open editor when it flips true (editing is impossible
   *  while streaming). */
  isBusy: boolean;
  /** Submit the draft (delete the last exchange, then send). Never fires for
   *  blank drafts (the empty-text guard — the send seam would drop them). */
  onSubmit: (content: string) => void;
  /** Close the editor without sending (Esc key, cancel button). */
  onCancel: () => void;
  /** AP-32: the primary button's label — default `send` («Отправить", the
   *  user's resend). The assistant's in-place save passes `save`
   *  («Сохранить" — the existing key, no new copy); the cancel button
   *  always reuses `cancel_edit`. */
  submitLabelKey?: AgentI18nKey;
  /** AP-32: the edited row's shape — default `user` (the bubble cap +
   *  right-aligned pair). `assistant` takes the assistant's flat full-width
   *  shape (no cap, left-aligned pair), not the user bubble. The textarea
   *  chrome is identical in both (the assistant body shares the bubble's
   *  font-ui / ui-fs-1px / 1.5 type). */
  layout?: "user" | "assistant";
}

export function AgentEditMessage({ initialText, isBusy, onSubmit, onCancel, submitLabelKey = "send", layout = "user" }: AgentEditMessageProps) {
  const { t } = useT();
  const [draft, setDraft] = useState(initialText);
  const blank = draft.trim().length === 0;

  const submit = () => {
    if (blank) return;
    onSubmit(draft);
  };

  return (
    <div
      className={layout === "assistant" ? "w-full" : "w-full max-w-[85%]"}
      data-testid="copilot-edit-message"
    >
      <MobileExpandTextarea
        value={draft}
        onChange={setDraft}
        label={t("edit")}
      >
        <AutoTextarea
          className="!border-accent !px-3.5 !py-3 !font-ui !text-[calc(var(--ui-fs)-1px)] !text-msg-t1 leading-[1.5]"
          minRows={7}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") onCancel(); }}
          autoFocus
        />
      </MobileExpandTextarea>
      <div className={layout === "assistant" ? "mt-1.5 flex justify-start gap-1.5" : "mt-1.5 flex justify-end gap-1.5"}>
        <button
          type="button"
          data-testid="copilot-edit-send"
          className="cursor-pointer rounded-[5px] bg-accent px-3 py-[5px] font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-on-accent transition-all duration-100 hover:brightness-110 disabled:opacity-50"
          disabled={isBusy || blank}
          onClick={submit}
        >{t(submitLabelKey)}</button>
        <button
          type="button"
          data-testid="copilot-edit-cancel"
          className="cursor-pointer rounded-[5px] bg-s2 px-3 py-[5px] font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 transition-all duration-100 hover:bg-s3 disabled:opacity-50"
          disabled={isBusy}
          onClick={onCancel}
        >{t("cancel_edit")}</button>
      </div>
    </div>
  );
}
