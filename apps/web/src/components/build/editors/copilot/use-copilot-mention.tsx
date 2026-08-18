import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MentionAutocomplete } from "../../../shared/MentionAutocomplete.js";
import {
  filterMentionItems,
  mentionQueryStart,
  readMentionQuery,
  type MentionAutocompleteItem,
} from "../../../shared/mention-autocomplete-query.js";
import { readMacroQuery } from "../../../shared/macro-autocomplete-store.js";

/**
 * `@`-mention session machinery for the experience-copilot chat inputs
 * (CX-6, COPILOT_CONTEXT_PICKER_PLAN). Both input areas (desktop + mobile)
 * share this hook; only the chrome differs between them.
 *
 * This mirrors the `AutoTextarea` macro-session machinery (`{{` picker) but
 * lives OUTSIDE the shared component because the pick semantics are
 * surface-specific: a macro pick INSERTS `{{name}}` into the text, while a
 * mention pick STRIPS the `@query` gesture and pins the target as a
 * per-thread link (PATCH full-replace of contextLinks — the pin persists
 * across turns and renders as a removable pill above the input). The
 * popover is the shared presentational `MentionAutocomplete`; the owner
 * (this hook's caller) keeps DOM focus and drives arrows/Enter/Escape.
 *
 * The textarea element is captured from every event (`e.currentTarget`) —
 * `AutoTextarea` does not forward refs, and the hook never needs one for
 * the text ops. The popover anchors to the input CARD via `anchorEl`
 * (owned by the caller), not to the textarea.
 *
 * Precedence: when a `{{` macro session is active at the caret the mention
 * session stays CLOSED (macro wins — both pickers can't sensibly be open
 * at once). Otherwise a word-start `@` opens the mention session.
 */
export interface UseCopilotMentionConfig {
  /** Current draft text (controlled by the caller). */
  draft: string;
  /** Draft setter — the hook's onChange routes through it, and the pick
   *  (native setter + input dispatch) triggers React's onChange, so the
   *  caller's state always syncs. */
  setDraft: (value: string) => void;
  /** The merged mention catalog (characters/personas/lorebooks/scripts/
   *  skills) provided by the shell. */
  catalog: readonly MentionAutocompleteItem[];
  /** Fired when an item is picked. The `@query` is ALREADY stripped from
   *  the draft by the time this fires; the caller pins the target. */
  onPick: (item: MentionAutocompleteItem) => void;
  /** Popover anchor — the input CARD container (the caller owns its ref). */
  anchorEl: HTMLElement | null;
}

export function useCopilotMention(config: UseCopilotMentionConfig): {
  /** The rendered popover (a portal) when a session is open, else null. */
  popover: ReactNode;
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  handleClick: (e: React.MouseEvent<HTMLTextAreaElement>) => void;
  handleBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Wraps the caller's own keydown: while the popover is open picker keys
   *  win (arrows/Enter/Tab/Escape); otherwise `fallback` runs unchanged. */
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    fallback: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void,
  ) => void;
} {
  const { setDraft, catalog, onPick, anchorEl } = config;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // The textarea element, captured from events (AutoTextarea forwards no ref).
  const elRef = useRef<HTMLTextAreaElement | null>(null);

  // Recompute the session from the live textarea (value + caret). Bails out
  // when nothing changed to avoid redundant renders from the frequent
  // `select` event. Macro session wins over the mention session.
  const recompute = useCallback((el: HTMLTextAreaElement) => {
    elRef.current = el;
    const caret = el.selectionStart ?? el.value.length;
    const macroQuery = readMacroQuery(el.value, caret);
    const q = macroQuery !== null ? null : readMentionQuery(el.value, caret);
    setOpen((prev) => {
      const next = q !== null;
      return prev === next ? prev : next;
    });
    if (q === null) {
      setQuery("");
    } else {
      setQuery(q);
      setActiveIndex(0);
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const filtered = useMemo(() => filterMentionItems(catalog, query), [catalog, query]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      recompute(e.currentTarget);
    },
    [setDraft, recompute],
  );

  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      recompute(e.currentTarget);
    },
    [recompute],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      recompute(e.currentTarget);
    },
    [recompute],
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      // The owning textarea loses focus → the session is over. (The popup's
      // own mousedown is default-prevented, so clicks inside it never blur
      // the field first.)
      void e;
      close();
    },
    [close],
  );

  // Strip the active `@query` at the caret and pin the picked item. Uses the
  // native-value-setter + dispatched `input` event (the AutoTextarea macro
  // trick) so React's onChange fires → `handleChange` → `setDraft` syncs the
  // controlled state; the caret is set to where the `@` was.
  const pick = useCallback(
    (item: MentionAutocompleteItem) => {
      const el = elRef.current;
      if (!el || !textareaValueSetter) {
        close();
        return;
      }
      const caret = el.selectionStart ?? el.value.length;
      const start = mentionQueryStart(el.value, caret);
      if (start === null) {
        close();
        return;
      }
      const newValue = el.value.slice(0, start) + el.value.slice(caret);
      textareaValueSetter.call(el, newValue);
      el.setSelectionRange(start, start);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      onPick(item);
      close();
      el.focus();
    },
    [close, onPick],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, fallback: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void) => {
      if (!open) {
        fallback(e);
        return;
      }
      const count = filtered.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (count ? (i + 1) % count : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (count ? (i - 1 + count) % count : 0));
          break;
        case "Enter":
        case "Tab": {
          const item = filtered[activeIndex];
          if (item) {
            e.preventDefault();
            pick(item);
          } else {
            close();
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          close();
          break;
        default:
          fallback(e);
      }
    },
    [open, filtered, activeIndex, pick, close],
  );

  const popover: ReactNode = open
    ? createPortal(
        <MentionAutocomplete
          items={filtered}
          activeIndex={activeIndex}
          onSelect={pick}
          onHover={setActiveIndex}
          anchorEl={anchorEl}
          query={query}
        />,
        document.body,
      )
    : null;

  return { popover, handleChange, handleSelect, handleClick, handleBlur, handleKeyDown };
}

// Guarded for DOM-less module graphs (bun:test loads DOM-averse suites
// without a window; pick no-ops on undefined). Same pattern as AutoTextarea.
const textareaValueSetter =
  typeof window === "undefined"
    ? undefined
    : (Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set as ((this: HTMLTextAreaElement, value: string) => void) | undefined);
