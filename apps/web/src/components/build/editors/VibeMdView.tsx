/**
 * Vibe MD — two-surface editor (VTF-13, reworked per owner review).
 *
 * The Markdown authoring surface for Build Mode. Composes the VTF-10 amber
 * theme, the VTF-11 locked-headings guardrail, and the VTF-12 sync core into a
 * single editor bound to a react-hook-form `BuildCharacterDraft`:
 *
 *   (1) **Prose MD editor** (CodeMirror, auto-growing — no inner scroll) — the
 *       document BODY ONLY (no frontmatter). Owns FIVE draft fields surfaced as
 *       FOUR locked H1 sections: `description` (# PERSONALITY), `scenario`
 *       (# SCENARIO), `mesExample` (# EXAMPLES), and `firstMessage` +
 *       `alternateGreetings` (# GREETINGS — a synthesized VIEW of the
 *       `greetings/` folder via the inline marker codec; the primary greeting
 *       is the body under the heading, alternates follow `=== ALT N ===`
 *       markers). Edits flow editor → form via `applyBodyToDraft` on every doc
 *       change; external resets (character switch / Reset button) flow form →
 *       editor via `draftToBody`. A ref flag breaks the feedback loop
 *       (editor-originated changes don't bounce back through the subscription).
 *       An "add alternate greeting" button below the editor appends a new marker.
 *
 *   (2) **ONE "Advanced fields" accordion** — the non-prose draft fields that
 *       are NOT in the shared top block (avatar/name/tags/gallery, owned by
 *       `CharacterForm` and identical in both modes): creator notes,
 *       `personalitySummary` (a distinct `charPersonality` canvas slot — NOT
 *       metadata, NOT part of `# PERSONALITY`), the example-injection mode
 *       (controls how `# EXAMPLES` injects), post-history, depth prompt, and
 *       system prompt. These reuse the VTF-9 shared field components so both
 *       views stay in lockstep.
 *
 * The frontmatter is NEVER visible in the MD area — name/tags are edited in the
 * shared top block and re-kropped server-side on save. The action bar (Save /
 * Export / Form↔MD toggle) stays in the parent `CharacterForm` (VTF-14).
 *
 * Structural integrity: H1 headings are locked against user typing (VTF-11) AND
 * structurally pinned through parse→serialize on every editor→form sync
 * (VTF-12). A deleted/renamed/malformed heading self-heals the next time the
 * body round-trips. See `vibe-md-sync.ts` for the Threat-2 guarantee.
 */

import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft, ChatListItem } from "@vibe-tavern/api-contracts";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Popover from "@radix-ui/react-popover";

import { vibeMdBundle } from "./vibe-md-theme.js";
import { lockedHeadings } from "./vibe-md-locked-headings.js";
import { greetingsUi } from "./vibe-md-greetings.js";
import { vibeMdFolding } from "./vibe-md-folding.js";
import { macroAutocomplete } from "./vibe-md-macros.js";
import { applyBodyToDraft, draftToBody } from "./vibe-md-sync.js";

import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { usePersistedBoolean } from "../../../hooks/use-persisted-boolean.js";
import { Icons } from "../../shared/icons.js";
import { popoverMaxHeight } from "../../shared/popover-constants.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { lblCls } from "../fields/field-styles.js";
import { TextAreaField } from "../fields/TextAreaField.js";
import { DepthPromptField } from "../fields/DepthPromptField.js";
import { createChatAction, switchChatAction, renameChatAction, deleteChatAction } from "../../../stores/api-actions/chat-actions.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { listCoauthorChats } from "../../../app-client.js";
import { useChatStore } from "../../../stores/chat-store.js";

export interface VibeMdViewProps {
  /** The react-hook-form instance (shared with the parent CharacterForm). */
  form: UseFormReturn<BuildCharacterDraft>;
  /** The active character id — switching it re-initializes the editor body. */
  characterId: string;
  /** Disable inputs while a save is in flight. */
  isSaving: boolean;
}

export function VibeMdView({ form, characterId, isSaving }: VibeMdViewProps) {
  const { t, tDynamic } = useT();
  const isMobile = useIsMobile();
  const { watch, setValue } = form;

  // --- Co-Author entry (CA-8.4) ---
  // Entry points to the co-author surface. Actions are called directly (not via
  // useCharacterController/useChatController) so this editor does not spin up a
  // duplicate controller instance — AppShell already owns the single one.
  const [coauthorOpen, setCoauthorOpen] = useState(false);
  const [coauthorChats, setCoauthorChats] = useState<ChatListItem[] | null>(null);
  const [coauthorBusy, setCoauthorBusy] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteConfirmChatId, setDeleteConfirmChatId] = useState<string | null>(null);

  async function handleRenameChat(chatId: string) {
    if (!renameDraft.trim()) { setRenamingChatId(null); return; }
    try {
      setCoauthorBusy(true);
      await renameChatAction(brandId<ChatId>(chatId), renameDraft.trim());
      setCoauthorChats(prev => prev?.map(c => c.id === chatId ? { ...c, title: renameDraft.trim() } : c) ?? null);
      setRenamingChatId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("error"));
    } finally {
      setCoauthorBusy(false);
    }
  }

  async function handleDeleteChat(chatId: string) {
    try {
      setCoauthorBusy(true);
      await deleteChatAction(brandId<ChatId>(chatId));
      setCoauthorChats(prev => prev?.filter(c => c.id !== chatId) ?? null);
      setDeleteConfirmChatId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("error"));
    } finally {
      setCoauthorBusy(false);
    }
  }

  async function handleCoauthorOpenChange(next: boolean) {
    // Controlled-by-Popover replacement for the former handleOpenCoauthorList
    // toggle: Radix fires onOpenChange with the intended state, so we only act
    // on the opening edge (fetch) and let the closing edge set state. Removing
    // the former hand-rolled `fixed inset-0 z-40` click-away backdrop is what
    // stops the dropdown from freezing page scroll: Popover's own outside-click
    // detection needs no fullscreen overlay (overlay-audit fix step 8).
    if (!next) { setCoauthorOpen(false); return; }
    setCoauthorBusy(true);
    try {
      const list = await listCoauthorChats(characterId);
      setCoauthorChats(list);
      setCoauthorOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("coauthor.list_failed"));
    } finally {
      setCoauthorBusy(false);
    }
  }

  async function handleNewCoauthorChat() {
    setCoauthorBusy(true);
    setCoauthorOpen(false);
    try {
      await createChatAction(characterId, "coauthor");
      // createChatAction auto-selects the new chat; the AppShell surface flips to
      // CoauthorMode because activeChat.mode === 'coauthor' (resolveShellSurface).
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("chat_create_failed"));
    } finally {
      setCoauthorBusy(false);
    }
  }

  async function handleSwitchToCoauthorChat(chatId: ChatListItem["id"]) {
    setCoauthorBusy(true);
    setCoauthorOpen(false);
    try {
      await switchChatAction(chatId);
      useChatStore.getState().setActiveChatId(chatId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("coauthor.switch_failed"));
    } finally {
      setCoauthorBusy(false);
    }
  }

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The last body string the editor showed (avoids redundant dispatches). */
  const editorBodyRef = useRef<string>("");
  /** True while a form change originated from the editor (breaks the loop). */
  const editorOriginatedRef = useRef(false);
  /** Debounce timer + pending body for the editor→form sync. Typing coalesces
   *  into one parse + 5-field write after a short pause, so the editor stays
   *  responsive (CodeMirror owns its own DOM) instead of re-rendering
   *  CharacterForm's whole tree on every keystroke — the parent watches 13
   *  fields at top level, and applyBodyToDraft parses the full body each call.
   *  flush() drains pending immediately on blur / greeting-widget action so save
   *  never reads stale values (the Save button blurs the editor before its
   *  onClick fires). The timer is only CLEARED on unmount (not flushed) to avoid
   *  writing a stale body into a freshly-reset form on character switch; blur
   *  has already flushed by then anyway. */
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBodyRef = useRef<string | null>(null);

  // ── Greetings widget handlers (draft-backed; the form→editor subscription
  // re-emits the canonical body after each change, so markers never drift). ──
  // NOTE: we ALSO force the editor to re-emit directly. react-hook-form's
  // `subscribe({ name })` does not reliably fire for array-field `setValue`
  // (only for registered-input changes), so the subscription alone would leave
  // the editor stale after a widget click. The direct dispatch is the primary
  // path for widget actions; the subscription still covers Reset/switch.
  function forceEditorFromBody(): void {
    const body = draftToBody(form.getValues());
    const view = viewRef.current;
    if (view && body !== editorBodyRef.current) {
      editorBodyRef.current = body;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
    }
  }
  function addGreeting(): void {
    flushEditorToForm();
    const current = form.getValues().alternateGreetings ?? [];
    setValue("alternateGreetings", [...current, ""], { shouldDirty: true });
    forceEditorFromBody();
    // Focus the editor at the end so the user can type the new greeting.
    const view = viewRef.current;
    if (view) {
      view.focus();
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end } });
    }
  }
  function removeGreeting(altIndex: number): void {
    flushEditorToForm();
    const current = form.getValues().alternateGreetings ?? [];
    setValue("alternateGreetings", current.filter((_, i) => i !== altIndex), { shouldDirty: true });
    forceEditorFromBody();
  }

  // ── Editor lifecycle: create on mount + re-create on character switch ──────
  useEffect(() => {
    if (!editorHostRef.current) return;
    const initialBody = draftToBody(form.getValues());
    editorBodyRef.current = initialBody;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialBody,
        extensions: [
          ...vibeMdBundle(),
          ...macroAutocomplete(),
          ...lockedHeadings(),
          ...greetingsUi({ onAdd: addGreeting, onRemove: removeGreeting }),
          ...vibeMdFolding(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              syncEditorToForm(update.state.doc.toString());
            }
            // Flush on blur so save (the Save button blurs the editor before
            // onClick) and any focus-leaving action read fresh form values
            // instead of a pending debounce window.
            if (update.focusChanged && !update.view.hasFocus) {
              flushEditorToForm();
            }
          }),
        ],
      }),
      parent: editorHostRef.current,
    });
    viewRef.current = view;
    return () => {
      // Clear (do NOT flush) the pending debounce: blur has already flushed if
      // the user focus-left, and flushing here could write a stale body into a
      // freshly-reset form on character switch.
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // Re-create on character switch so the body reflects the new draft. The
    // form reference is stable for the component's lifetime (owned by CharacterForm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  // ── Editor → form: parse the body and write the prose + greetings fields ───
  // Debounced via syncEditorToForm; flushEditorToForm is the immediate drain.
  function flushEditorToForm(): void {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const body = pendingBodyRef.current;
    if (body == null) return;
    pendingBodyRef.current = null;
    editorOriginatedRef.current = true;
    editorBodyRef.current = body;
    const updated = applyBodyToDraft(body, form.getValues());
    setValue("description", updated.description, { shouldDirty: true });
    setValue("scenario", updated.scenario, { shouldDirty: true });
    setValue("mesExample", updated.mesExample, { shouldDirty: true });
    setValue("firstMessage", updated.firstMessage, { shouldDirty: true });
    setValue("alternateGreetings", updated.alternateGreetings, { shouldDirty: true });
  }

  function syncEditorToForm(body: string): void {
    pendingBodyRef.current = body;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(flushEditorToForm, 150);
  }

  // ── Form → editor: external changes (Reset / switch) update the body ───────
  useEffect(() => {
    const unsubscribe = form.subscribe({
      name: ["description", "scenario", "mesExample", "firstMessage", "alternateGreetings"],
      callback: ({ values }) => {
        // Skip editor-originated changes — they already match the editor.
        if (editorOriginatedRef.current) {
          editorOriginatedRef.current = false;
          return;
        }
        const body = draftToBody(values as BuildCharacterDraft);
        const view = viewRef.current;
        if (view && body !== editorBodyRef.current) {
          editorBodyRef.current = body;
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
        }
      },
    });
    return unsubscribe;
  }, [form]);

  // ── Example-injection mode (controls how # EXAMPLES in the body injects) ───
  const mesExampleMode = watch("mesExampleMode");
  const mesExampleDepth = watch("mesExampleDepth");

  return (
    <div>
      {/* Co-Author entry (CA-8.4) — open an iterative editing chat on this card.
          "Co-Author mode" lists existing co-author chats for this character;
          "New co-author chat" creates one. Both flip AppShell to CoauthorMode
          because the active chat's mode becomes 'coauthor' (resolveShellSurface).
          Placed ABOVE the editor so the user doesn't have to scroll the whole
          card to start a co-author session. The list dropdown is a Radix
          Popover (flyout-panel pattern, overlay-audit step 8): native
          outside-click without a fullscreen backdrop, so opening it no longer
          freezes page scroll. */}
      <div className="relative mb-5 flex flex-wrap items-center gap-2">
        <Popover.Root open={coauthorOpen} onOpenChange={(o) => { void handleCoauthorOpenChange(o); }}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-s2 px-3 py-2 font-ui text-[0.85rem] font-medium text-t2 transition-colors hover:border-accent/50 hover:text-t1 disabled:opacity-50"
              disabled={coauthorBusy}
            >
              <span className="text-[0.85rem]"><Icons.Sparkles /></span>
              {t("coauthor.entry.list")}
            </button>
          </Popover.Trigger>
          {coauthorChats && (
            <Popover.Portal container={getModalPortal() ?? undefined}>
              <Popover.Content
                side="bottom"
                align="start"
                sideOffset={4}
                className="glass-blur z-50 min-w-[260px] max-w-[340px] rounded-lg border border-border bg-glass-bg shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
              >
                <div className="border-b border-border/50 px-3 py-2 font-ui text-[11px] uppercase tracking-wide text-t4">{t("coauthor.list_title")}</div>
                {coauthorChats.length === 0 ? (
                  <div className="px-3 py-3 font-ui text-[0.85rem] text-t3">{t("coauthor.list_empty")}</div>
                ) : (
                  <ul className="overflow-y-auto py-1" style={{ maxHeight: popoverMaxHeight("twoLine") }}>
                    {coauthorChats.map((chat) => (
                      <li key={chat.id} className="group relative">
                        {renamingChatId === chat.id ? (
                          <div className="flex w-full flex-col items-start gap-1 px-3 py-2">
                            <input
                              // eslint-disable-next-line jsx-a11y/no-autofocus
                              autoFocus
                              className="w-full rounded border border-border bg-s2 px-2 py-1 font-ui text-[0.85rem] font-medium text-t1 outline-none focus:border-border2"
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void handleRenameChat(chat.id); }
                                else if (e.key === "Escape") {
                                  // Stop Radix Popover from also closing on Escape —
                                  // the inline rename cancels but the list stays open.
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setRenamingChatId(null);
                                }
                              }}
                              onBlur={() => void handleRenameChat(chat.id)}
                              disabled={coauthorBusy}
                            />
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-s2 pr-16"
                              onClick={() => { void handleSwitchToCoauthorChat(chat.id); }}
                              disabled={coauthorBusy}
                            >
                              <span className="font-ui text-[0.85rem] font-medium text-t1">{chat.title || t("coauthor.untitled_chat")}</span>
                              <span className="font-ui text-[11px] text-t4">{chat.messageCount} {t("coauthor.messages_unit")}</span>
                            </button>
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                type="button"
                                className="rounded p-1.5 text-t3 transition-colors hover:bg-s3 hover:text-t1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRenamingChatId(chat.id);
                                  setRenameDraft(chat.title);
                                }}
                              >
                                <Icons.Edit className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="rounded p-1.5 text-danger-text transition-colors hover:bg-danger-dim hover:text-danger-text"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteConfirmChatId(chat.id);
                                }}
                              >
                                <Icons.Trash className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Popover.Content>
            </Popover.Portal>
          )}
        </Popover.Root>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 font-ui text-[0.85rem] font-bold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
          onClick={() => { void handleNewCoauthorChat(); }}
          disabled={coauthorBusy}
        >
          <span className="text-[0.85rem]"><Icons.Plus /></span>
          {t("coauthor.entry.new")}
        </button>
      </div>

      {deleteConfirmChatId && (
        <DestructiveConfirmModal
          title={t("sidebar_delete_chat")}
          body={<>{t("sidebar_are_you_sure")} <b>{coauthorChats?.find(c => c.id === deleteConfirmChatId)?.title || t("coauthor.untitled_chat")}</b></>}
          confirmLabel={t("delete")}
          onConfirm={() => void handleDeleteChat(deleteConfirmChatId)}
          onCancel={() => setDeleteConfirmChatId(null)}
        />
      )}

      {/* Prose MD editor — body only (no frontmatter), auto-grows to content.
          The `+` (add alt greeting) and `✕` (remove) widgets live ON the
          `# GREETINGS` heading and each `=== ALT N ===` marker inside the
          editor (vibe-md-greetings.ts) — no separate button here. */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("vmd_editor_label")}</label>
        <div
          ref={editorHostRef}
          // Auto-grow: NO maxHeight, NO overflow-auto (VTF-13 rework). The CM6
          // theme sets `& { height: auto }` + `.cm-scroller { overflow: hidden }`
          // so content drives the height and the page scroll is the only scroll.
          className="vibe-md-editor rounded-lg border border-border"
          style={{ minHeight: 420 }}
        />
        <p className="mt-1.5 font-ui text-[11px] text-t4">{t("vmd_editor_hint")}</p>
      </div>

      {/* ONE "Advanced fields" accordion — creator notes, personality summary,
          example-injection mode, and the instruction fields. NO Metadata
          accordion (name/tags are shared in the top block); NO separate
          Greetings accordion (greetings live in the editor's # GREETINGS). */}
      <Accordion title={t("vmd_advanced_title")} storageKey={`vmd:adv:${characterId}`}>
        <TextAreaField
          form={form}
          field="creatorNotes"
          label={t("creator_notes")}
          mobileExpandLabel={t("creator_notes_label")}
          minRows={3}
          placeholder={t("creator_notes_placeholder")}
          isSaving={isSaving}
        />
        <TextAreaField
          form={form}
          field="personalitySummary"
          label={t("char_personality_label")}
          mobileExpandLabel={t("char_personality_summary_label")}
          minRows={3}
          isSaving={isSaving}
        />
        {/* Example-injection mode (how # EXAMPLES in the editor injects). */}
        <div className="mb-1">
          <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <label className={lblCls}>{t("dialog_examples")}</label>
            <div className="flex items-center gap-2">
              <CustomTooltip content={tDynamic(`mes_example_mode_tooltip_${mesExampleMode || "always"}`)}>
                <SegmentedControl
                  value={mesExampleMode || "always"}
                  options={[
                    { value: "always", label: t("activation_always") },
                    { value: "once", label: t("activation_once") },
                    { value: "depth", label: t("activation_depth") },
                    { value: "disabled", label: t("activation_disabled") },
                  ]}
                  onChange={(v) => setValue("mesExampleMode", v as "always" | "once" | "depth" | "disabled", { shouldDirty: true })}
                  disabled={isSaving}
                  compact
                />
              </CustomTooltip>
              <div className={cn("flex min-h-8 items-center gap-2", (mesExampleMode || "always") !== "depth" && "pointer-events-none opacity-30")}>
                <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("depth")}</span>
                <NumberInput
                  className="h-8 w-[100px] sm:h-6 sm:w-[90px]"
                  min={0}
                  max={999}
                  disabled={isSaving || (mesExampleMode || "always") !== "depth"}
                  value={mesExampleDepth ?? 4}
                  onChange={(v) => setValue("mesExampleDepth", v, { shouldDirty: true })}
                />
              </div>
            </div>
          </div>
          <p className="font-ui text-[11px] text-t4">{t("vmd_examples_in_body_hint")}</p>
        </div>
        <TextAreaField
          form={form}
          field="postHistoryInstructions"
          label={t("post_history_instructions")}
          mobileExpandLabel={t("post_history_label")}
          minRows={3}
          mono
          placeholder={t("post_history_placeholder")}
          isSaving={isSaving}
        />
        <DepthPromptField form={form} isSaving={isSaving} />
        <TextAreaField
          form={form}
          field="systemPrompt"
          label={t("system_prompt_override")}
          mobileExpandLabel={t("system_prompt_label")}
          minRows={4}
          mono
          placeholder={t("system_prompt_override_placeholder")}
          isSaving={isSaving}
        />
      </Accordion>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Accordion primitive (localStorage-persisted open state, mirrors GalleryAccordion)
// ─────────────────────────────────────────────────────────────────────────────

interface AccordionProps {
  title: string;
  storageKey: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Accordion({ title, storageKey, defaultOpen, children }: AccordionProps) {
  const [isOpen, setIsOpen] = usePersistedBoolean(storageKey, !!defaultOpen);

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-s2">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between bg-surface px-4 py-3 font-body text-[15px] font-medium text-t1 transition-colors hover:bg-s2"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
      >
        <span>{title}</span>
        <Icons.Caret direction={isOpen ? "d" : "l"} className="h-5 w-5 text-t3" />
      </button>
      <div className={cn("px-4", !isOpen && "hidden")}>
        <div className="py-4">{children}</div>
      </div>
    </div>
  );
}
