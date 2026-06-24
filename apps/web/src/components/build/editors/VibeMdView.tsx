/**
 * Vibe MD — two-surface editor (VTF-13).
 *
 * The Markdown authoring surface for Build Mode. Composes the VTF-10 amber
 * theme, the VTF-11 locked-headings guardrail, and the VTF-12 sync core into a
 * single editor bound to a react-hook-form `BuildCharacterDraft`:
 *
 *   (1) **Prose MD editor** (CodeMirror) — the document BODY ONLY (no
 *       frontmatter). Owns the three prose fields: `description` (# PERSONALITY),
 *       `scenario` (# SCENARIO), `mesExample` (# EXAMPLES). Edits flow editor →
 *       form via `applyBodyToDraft` on every doc change; external resets
 *       (character switch / Reset button) flow form → editor via `draftToBody`.
 *       A ref flag breaks the feedback loop (editor-originated changes don't
 *       bounce back through the subscription).
 *
 *   (2) **Accordions** — the non-prose draft fields, grouped:
 *        - Metadata: name, tags, creator notes, personality summary.
 *        - Greetings: first message, alternate greetings, example-injection mode.
 *        - Instructions: post-history, depth prompt, system prompt.
 *       These reuse the VTF-9 shared field components (TextAreaField,
 *       DepthPromptField, TagsField) so both views stay in lockstep.
 *
 * The frontmatter is NEVER visible in the MD area — it is re-kropped from the
 * Metadata fields server-side on save. The header (avatar / save / actions)
 * stays in the parent (`BuildMode`, VTF-14 wires the Form/MD toggle); this
 * component owns only the editor + accordion surface.
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
import { applyBodyToDraft, draftToBody } from "./vibe-md-sync.js";

import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { Icons } from "../../shared/icons.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { inputPad, inputCls, lblCls } from "../fields/field-styles.js";
import { TextAreaField, TokenBadge } from "../fields/TextAreaField.js";
import { DepthPromptField } from "../fields/DepthPromptField.js";
import { TagsField } from "../fields/TagsField.js";

export interface VibeMdViewProps {
  /** The react-hook-form instance (shared with the parent BuildMode). */
  form: UseFormReturn<BuildCharacterDraft>;
  /** The active character id — switching it re-initializes the editor body. */
  characterId: string;
  /** Disable inputs while a save is in flight. */
  isSaving: boolean;
}

export function VibeMdView({ form, characterId, isSaving }: VibeMdViewProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const mInput = isMobile ? " text-base" : "";
  const { register, watch, setValue } = form;

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The last body string the editor showed (avoids redundant dispatches). */
  const editorBodyRef = useRef<string>("");
  /** True while a form change originated from the editor (breaks the loop). */
  const editorOriginatedRef = useRef(false);

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
    // form reference is stable for the component's lifetime (owned by BuildMode).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  // ── Editor → form: parse the body and write the prose fields ───────────────
  function syncEditorToForm(body: string): void {
    editorOriginatedRef.current = true;
    editorBodyRef.current = body;
    const updated = applyBodyToDraft(body, form.getValues());
    setValue("description", updated.description, { shouldDirty: true });
    setValue("scenario", updated.scenario, { shouldDirty: true });
    setValue("mesExample", updated.mesExample, { shouldDirty: true });
  }

  // ── Form → editor: external changes (Reset / switch) update the body ───────
  useEffect(() => {
    const unsubscribe = form.subscribe({
      name: ["description", "scenario", "mesExample"],
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

  // ── Greetings fields (watched for the alternate-greetings chip list) ───────
  const firstMessage = watch("firstMessage");
  const alternateGreetings = watch("alternateGreetings") || [];
  const mesExampleMode = watch("mesExampleMode");
  const mesExampleDepth = watch("mesExampleDepth");
  const [altGreetIdx, setAltGreetIdx] = useState(0);

  return (
    <div>
      {/* Prose MD editor — body only (no frontmatter) */}
      <div className="mb-5">
        <label className={lblCls + " mb-1.5 block"}>{t("vmd_editor_label")}</label>
        <div
          ref={editorHostRef}
          className="vibe-md-editor overflow-auto rounded-lg border border-border bg-s1"
          style={{ minHeight: 420, maxHeight: 560 }}
        />
        <p className="mt-1.5 font-ui text-[11px] text-t4">{t("vmd_editor_hint")}</p>
      </div>

      {/* Metadata accordion */}
      <Accordion title={t("vmd_metadata_title")} storageKey={`vmd:meta:${characterId}`} defaultOpen>
        <div className="mb-4">
          <label className={lblCls + " mb-1.5 block"}>{t("char_name_label")}</label>
          <input
            type="text"
            className={inputCls + mInput}
            style={inputPad}
            disabled={isSaving}
            {...register("name")}
          />
        </div>
        <div className="mb-4">
          <TagsField form={form} isSaving={isSaving} />
        </div>
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
      </Accordion>

      {/* Greetings accordion */}
      <Accordion title={t("vmd_greetings_title")} storageKey={`vmd:greet:${characterId}`}>
        <TextAreaField
          form={form}
          field="firstMessage"
          label={t("first_message_greeting")}
          mobileExpandLabel={t("first_message_label")}
          minHeight={100}
          placeholder={t("first_message_placeholder")}
          isSaving={isSaving}
        />
        {/* Alternate greetings (chip list + editor, mirrors CharacterForm) */}
        <div className="mb-5">
          <label className={lblCls + " mb-1.5 block"}>{t("alternate_greetings")}</label>
          <div className="mb-2 flex flex-wrap gap-1">
            {alternateGreetings.map((_: string, idx: number) => (
              <span
                key={idx}
                className={cn(
                  "inline-flex items-center gap-1 rounded border border-border bg-s2 px-2.5 py-[2px] font-ui text-xs text-t2 cursor-pointer transition-all",
                  idx === altGreetIdx && "border-accent bg-accent-dim text-accent-t",
                )}
                onClick={() => setAltGreetIdx(idx)}
              >
                Alt {idx + 1}
                <span
                  className="ml-0.5 cursor-pointer text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = [...alternateGreetings];
                    next.splice(idx, 1);
                    setValue("alternateGreetings", next, { shouldDirty: true });
                    if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
                  }}
                >✕</span>
              </span>
            ))}
            <span
              className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent px-2.5 py-[2px] font-ui text-xs text-t3 cursor-pointer"
              onClick={() => {
                const next = [...alternateGreetings, ""];
                setValue("alternateGreetings", next, { shouldDirty: true });
                setAltGreetIdx(next.length - 1);
              }}
            >+</span>
          </div>
          {alternateGreetings.length > 0 && (
            <div>
              <AutoTextarea
                className={inputCls + mInput}
                style={{ ...inputPad, minHeight: 100 }}
                disabled={isSaving}
                value={alternateGreetings[altGreetIdx] || ""}
                onChange={(e) => {
                  const next = [...alternateGreetings];
                  next[altGreetIdx] = e.target.value;
                  setValue("alternateGreetings", next, { shouldDirty: true });
                }}
                placeholder={t("alternate_greeting_placeholder")}
              />
              <TokenBadge text={alternateGreetings[altGreetIdx] || ""} />
            </div>
          )}
        </div>
        {/* Example-injection mode (controls how # EXAMPLES in the body injects) */}
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
      </Accordion>

      {/* Instructions accordion */}
      <Accordion title={t("vmd_instructions_title")} storageKey={`vmd:instr:${characterId}`}>
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
