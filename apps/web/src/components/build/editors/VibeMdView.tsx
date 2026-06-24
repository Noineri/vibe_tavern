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
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { vibeMdBundle } from "./vibe-md-theme.js";
import { lockedHeadings } from "./vibe-md-locked-headings.js";
import { greetingsUi } from "./vibe-md-greetings.js";
import { vibeMdFolding } from "./vibe-md-folding.js";
import { applyBodyToDraft, draftToBody } from "./vibe-md-sync.js";

import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { Icons } from "../../shared/icons.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { lblCls } from "../fields/field-styles.js";
import { TextAreaField } from "../fields/TextAreaField.js";
import { DepthPromptField } from "../fields/DepthPromptField.js";

export interface VibeMdViewProps {
  /** The react-hook-form instance (shared with the parent CharacterForm). */
  form: UseFormReturn<BuildCharacterDraft>;
  /** The active character id — switching it re-initializes the editor body. */
  characterId: string;
  /** Disable inputs while a save is in flight. */
  isSaving: boolean;
}

export function VibeMdView({ form, characterId, isSaving }: VibeMdViewProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { watch, setValue } = form;

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The last body string the editor showed (avoids redundant dispatches). */
  const editorBodyRef = useRef<string>("");
  /** True while a form change originated from the editor (breaks the loop). */
  const editorOriginatedRef = useRef(false);

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
          ...lockedHeadings(),
          ...greetingsUi({ onAdd: addGreeting, onRemove: removeGreeting }),
          ...vibeMdFolding(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              syncEditorToForm(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: editorHostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-create on character switch so the body reflects the new draft. The
    // form reference is stable for the component's lifetime (owned by CharacterForm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  // ── Editor → form: parse the body and write the prose + greetings fields ───
  function syncEditorToForm(body: string): void {
    editorOriginatedRef.current = true;
    editorBodyRef.current = body;
    const updated = applyBodyToDraft(body, form.getValues());
    setValue("description", updated.description, { shouldDirty: true });
    setValue("scenario", updated.scenario, { shouldDirty: true });
    setValue("mesExample", updated.mesExample, { shouldDirty: true });
    setValue("firstMessage", updated.firstMessage, { shouldDirty: true });
    setValue("alternateGreetings", updated.alternateGreetings, { shouldDirty: true });
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
          className="vibe-md-editor rounded-lg border border-border bg-s1"
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
          minHeight={60}
          placeholder={t("creator_notes_placeholder")}
          isSaving={isSaving}
        />
        <TextAreaField
          form={form}
          field="personalitySummary"
          label={t("char_personality_label")}
          mobileExpandLabel={t("char_personality_summary_label")}
          minHeight={60}
          isSaving={isSaving}
        />
        {/* Example-injection mode (how # EXAMPLES in the editor injects). */}
        <div className="mb-1">
          <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <label className={lblCls}>{t("dialog_examples")}</label>
            <div className="flex items-center gap-2">
              <CustomTooltip content={t(`mes_example_mode_tooltip_${mesExampleMode || "always"}`)}>
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
          minHeight={60}
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
          minHeight={80}
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
  const [isOpen, setIsOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? !!defaultOpen : stored === "true";
    } catch {
      return !!defaultOpen;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, isOpen ? "true" : "false");
    } catch {
      /* ignore quota / private mode */
    }
  }, [storageKey, isOpen]);

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
