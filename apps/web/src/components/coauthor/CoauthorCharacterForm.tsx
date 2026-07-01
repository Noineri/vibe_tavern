/**
 * CA-10 — Co-Author live character form (Wave 4).
 *
 * The right panel of the Co-Author surface: a LIVE, EDITABLE MD editor bound to
 * the snapshot character. The user authors the card here directly; the AI is a
 * co-editor whose turn-time proposals are overlaid for Apply/Reject in CA-11.
 *
 * This is NOT a read-only diff panel (the original CA-10 framing, superseded).
 * Co-authoring means writing the card TOGETHER: the canonical document always
 * belongs to the user, and the editor is LOCKED during the AI's turn so the two
 * never touch the same place at the same time — eliminating concurrent-edit
 * merge conflicts in V1 (turn-taking, not 3-way merge).
 *
 * Three editor states (V1 lifecycle):
 *   1. idle       — editable. The user edits freely and saves.
 *   2. generating — locked. Entered while a co-author turn is in flight
 *                   (`isSending` for this chat). The editor is read-only via a
 *                   CodeMirror `EditorView.editable` facet toggled through a
 *                   `Compartment`; a "AI is editing…" affordance is shown.
 *   3. reviewing  — locked + diff overlay (CA-11, NOT this unit). CA-10 derives
 *                   `editorState` but only `idle`/`generating` are exercised
 *                   here; entering `reviewing` without CA-11's Apply/Reject
 *                   would trap the user, so it is left unentered in CA-10 and
 *                   the editor returns to `idle` when generation ends.
 *
 * Reuse (verified against source — see plan Wave 4 reuse surface): the editor
 * mount lifecycle + editor↔form sync are reimplemented here (the ~30-line
 * CodeMirror `EditorView` setup), but ALL extension factories + the sync codec
 * are reused as-is from `build/editors/`. `VibeMdView` itself is NOT embedded:
 * it expects a parent `CharacterForm` form instance and carries the co-author
 * ENTRY buttons (CA-8.4) — embedding it would recurse and duplicate the
 * controller/form/save machinery. This component is self-contained: it owns its
 * own `useForm<BuildCharacterDraft>` (seeded via the shared `characterDefaults`,
 * the same mapping BuildMode uses) and saves through the SAME write path
 * (`useCharacterController().handleSaveCharacter` → `saveCharacterAction`).
 *
 * Scope: MD-editor-shaped (like VibeMdView's prose surface), NOT the full
 * `CharacterForm` — no avatar/name/tags top block and no "Advanced fields"
 * accordion (those stay in build). Co-author is about the prose document.
 */
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { buildCharacterDraftSchema, type BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { vibeMdBundle } from "../build/editors/vibe-md-theme.js";
import { lockedHeadings } from "../build/editors/vibe-md-locked-headings.js";
import { greetingsUi } from "../build/editors/vibe-md-greetings.js";
import { vibeMdFolding } from "../build/editors/vibe-md-folding.js";
import { applyBodyToDraft, draftToBody } from "../build/editors/vibe-md-sync.js";

import { lblCls } from "../build/fields/field-styles.js";
import { characterDefaults } from "../../lib/character-draft.js";
import type { AppCharacter } from "../../app-client.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useIsSending } from "../../stores/chat-store.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useT } from "../../i18n/context.js";

export function CoauthorCharacterForm() {
  const character = useSnapshotStore((s) => s.character);
  const { t } = useT();

  // No active character → nothing to co-author. (The surface is only reached
  // with an active co-author chat, which implies a character; this guards the
  // reload/edge window and avoids calling useForm without a seed.)
  if (!character) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-[280px] font-ui text-[0.9rem] leading-relaxed text-t2">
          {t("coauthor.diff.placeholder")}
        </p>
      </div>
    );
  }

  return <CoauthorCharacterFormInner key={character.id} character={character} />;
}

interface CoauthorCharacterFormInnerProps {
  character: AppCharacter;
}

function CoauthorCharacterFormInner({ character }: CoauthorCharacterFormInnerProps) {
  const { t } = useT();
  const isSending = useIsSending();
  const { handleSaveCharacter, isSavingCharacter } = useCharacterController();

  const form = useForm<BuildCharacterDraft>({
    resolver: zodResolver(buildCharacterDraftSchema),
    defaultValues: characterDefaults(character),
  });
  const { setValue, formState } = form;

  // `key={character.id}` on the inner component remounts it on character switch,
  // so the editor is created fresh with the new body — no manual reset/prevId
  // tracking needed (the form's defaultValues re-seed on remount). This mirrors
  // VibeMdView's `[characterId]` editor re-creation, just at the component level.

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The last body string the editor showed (avoids redundant dispatches). */
  const editorBodyRef = useRef<string>("");
  /** True while a form change originated from the editor (breaks the loop). */
  const editorOriginatedRef = useRef(false);
  /**
   * Editable facet compartment — toggled to lock the editor while the AI's turn
   * is in flight. `EditorView.editable` (not `EditorState.readOnly`) is used
   * deliberately: it flips the `contenteditable` attribute on the editor DOM,
   * blocking USER input while still allowing programmatic dispatches (the
   * form→editor sync path). Reconfigured in a dedicated effect on `isSending`.
   */
  const editableCompartmentRef = useRef<Compartment | null>(null);
  if (editableCompartmentRef.current === null) {
    editableCompartmentRef.current = new Compartment();
  }
  const editableCompartment = editableCompartmentRef.current;

  // The discriminated editor state. CA-10 exercises idle/generating; reviewing
  // is CA-11 (overlay + Apply/Reject). Kept here as the single derivation so
  // CA-11 can add the reviewing branch without touching the lock wiring.
  const editorState: "idle" | "generating" | "reviewing" = isSending ? "generating" : "idle";
  const locked = editorState !== "idle";

  // ── Greetings widget handlers (draft-backed; same rationale as VibeMdView). ──
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

  // ── Editor lifecycle: create on mount (component is keyed by character.id). ─
  useEffect(() => {
    if (!editorHostRef.current) return;
    const initialBody = draftToBody(form.getValues());
    editorBodyRef.current = initialBody;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialBody,
        extensions: [
          editableCompartment.of(EditorView.editable.of(!isSending)),
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
    // Mount-only: the component is remounted on character switch (key=id), and
    // isSending is handled by the lock effect below. `isSending` IS read at
    // mount for the initial facet value; it is intentionally excluded from deps
    // so a generation start/end does not tear down and rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ── Form → editor: external changes (greetings widget, future resets) ──────
  useEffect(() => {
    const unsubscribe = form.subscribe({
      name: ["description", "scenario", "mesExample", "firstMessage", "alternateGreetings"],
      callback: ({ values }) => {
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

  // ── Lock: toggle editor editability on send-in-flight transitions ──────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!isSending)),
    });
  }, [isSending, editableCompartment]);

  async function handleSave(): Promise<void> {
    await form.handleSubmit(async (data) => {
      await handleSaveCharacter(data);
      form.reset(data);
    })();
  }

  const isDirty = formState.isDirty;
  const canSave = !isSavingCharacter && (form.watch("name") || "").trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar — title + lock affordance + save. Sticky so it stays usable
          while scrolling a long document. */}
      <div className="glass-bar sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-surface px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-body text-[15px] font-medium text-t1">
            {character.name || t("unnamed")}
          </div>
          <div className="font-ui text-[11px] text-t3">
            {locked
              ? t("coauthor.editor.locked")
              : isDirty
                ? t("unsaved_changes")
                : t("saved_state")}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border-0 bg-accent px-3.5 py-1.5 font-ui text-[0.8rem] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          disabled={!canSave || !isDirty || locked || isSavingCharacter}
          onClick={() => { void handleSave(); }}
        >
          {isSavingCharacter ? t("saving") : t("save")}
        </button>
      </div>

      {/* The editor surface — auto-grows to content (no inner scroll); the panel
          itself scrolls. Same auto-grow mechanism as VibeMdView (minHeight only,
          no maxHeight, CM theme sets height:auto + overflow:hidden on scroller). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <label className={lblCls + " mb-1.5 block"}>{t("coauthor.editor.label")}</label>
        <div
          ref={editorHostRef}
          className="vibe-md-editor rounded-lg border border-border bg-s1"
          style={{ minHeight: 360 }}
        />
        <p className="mt-1.5 font-ui text-[11px] text-t4">{t("coauthor.editor.hint")}</p>
      </div>
    </div>
  );
}
