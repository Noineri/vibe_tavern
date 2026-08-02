/**
 * CA-10/CA-11 — Co-Author live character form (Wave 4).
 *
 * The right panel of the Co-Author surface: a LIVE, EDITABLE MD editor bound to
 * the snapshot character. The user authors the card here directly; the AI is a
 * co-editor whose turn-time proposals are reviewed via Apply/Reject.
 *
 * Co-authoring means writing the card TOGETHER: the canonical document always
 * belongs to the user, and the editor is LOCKED during the AI's turn so the two
 * never touch the same place at the same time — eliminating concurrent-edit
 * merge conflicts in V1 (turn-taking, not 3-way merge).
 *
 * Three editor states (V1 lifecycle):
 *   1. idle       — editable. The user edits freely and saves.
 *   2. generating — locked. Entered while a co-author turn is in flight
 *                   (`isSending`). The editor is read-only via a CodeMirror
 *                   `EditorView.editable` facet toggled through a `Compartment`.
 *   3. reviewing  — locked + diff overlay (CA-11). Entered when a turn ends and
 *                   the ephemeral turn store (CA-9.2) holds finalized tool
 *                   proposals. The aggregated proposed body is overlaid as a
 *                   green/red diff (canonical body → proposed body via
 *                   `buildLineDiff`); Apply commits via the CA-7 RPC, Reject
 *                   discards. Either returns the editor to idle.
 *
 * Reuse: the editor mount lifecycle + editor↔form sync are reimplemented here,
 * but ALL extension factories + the sync codec are reused as-is from
 * `build/editors/`. `VibeMdView` itself is NOT embedded (it expects a parent
 * `CharacterForm` + carries co-author ENTRY buttons → recursion). This component
 * is self-contained: own `useForm<BuildCharacterDraft>` (seeded via the shared
 * `characterDefaults`) and saves through the SAME write path BuildMode uses.
 *
 * Diff is in BODY space, not profile.md: see `coauthor-apply-aggregate.ts` for
 * why (canonical profile.md can't be rebuilt faithfully on the frontend —
 * `creator`/`character_version` are in `extensions`, absent from the snapshot).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { buildCharacterDraftSchema, type BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { brandId } from "@vibe-tavern/domain";
import type { ChatId } from "@vibe-tavern/domain";
import { toast } from "sonner";

import { vibeMdBundle } from "../build/editors/vibe-md-theme.js";
import { lockedHeadings } from "../build/editors/vibe-md-locked-headings.js";
import { greetingsUi } from "../build/editors/vibe-md-greetings.js";
import { vibeMdFolding } from "../build/editors/vibe-md-folding.js";
import { applyBodyToDraft, draftToBody } from "../build/editors/vibe-md-sync.js";
import { buildLineDiff } from "../shared/TextDiffPreview.js";
import { HunkSelectionDiff } from "./HunkSelectionDiff.js";
import { groupHunks, mergeSelectedBody, allHunkIds } from "../../lib/coauthor-hunk-merge.js";

import { lblCls } from "../build/fields/field-styles.js";
import { characterDefaults } from "../../lib/character-draft.js";
import { aggregateCoauthorProposal, buildPartialApplyRequest } from "../../lib/coauthor-apply-aggregate.js";
import { selectLoreBundle, allLorebookIds, allEntryIds } from "../../lib/lore-selection.js";
import { applyCoauthorDraft } from "../../api/chat-api.js";
import type { AppCharacter } from "../../app-client.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useIsSending } from "../../stores/chat-store.js";
import { useCoauthorTurnStore } from "../../stores/coauthor-turn-store.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useT } from "../../i18n/context.js";
import { LinkBindingPopover, type LinkTarget } from "../shared/LinkBindingPopover.js";
import { GeneratingScrim } from "../shared/generation-feedback.js";
import { SaveButton } from "../shared/SaveBar.js";
import { BoundResourcesField } from "../shared/BoundResourcesField.js";
import { listAllLorebooks } from "../../api/lorebook-api.js";
import { listAllScripts } from "../../api/script-api.js";
import { listPersonas } from "../../api/persona-api.js";
import type { LorebookRecord, ScriptRecord, AppCharacterEntry } from "../../api/types.js";
import type { PersonaRecord } from "@vibe-tavern/api-contracts";
import { setCoauthorContextLinksAction } from "../../stores/api-actions/chat-actions.js";
import { CoauthorLoreReview, type CoauthorLoreReviewLabels } from "./CoauthorLoreReview.js";

/**
 * Stable empty array for the turn-store selector fallback. Returning a fresh
 * `[]` here would create a new reference every render → Zustand's `Object.is`
 * check sees a change → infinite re-render loop ("Maximum update depth").
 */
const EMPTY_ACTIVITIES: CoauthorToolActivity[] = [];
const EMPTY_CONTEXT_LINKS: ReadonlyArray<{ targetType: "character" | "persona" | "lorebook" | "script"; targetId: string }> = Object.freeze([]);

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

  // The active chat id drives the ephemeral turn store (CA-9.2) which holds the
  // just-finished turn's tool proposals until Apply/Reject clears them.
  const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const activities = useCoauthorTurnStore(
    (s) => (chatId ? (s.turnsByChat[chatId] ?? EMPTY_ACTIVITIES) : EMPTY_ACTIVITIES),
  );

  // ── CE-C1: pinned Level-1 context picker. The entities the user explicitly
  // pinned to THIS co-author chat (right-panel picker), expanded read-only into
  // the editor prompt on the backend — any of character/persona/lorebook/script.
  // Generalizes CA-13 (lorebook-only). Persisted on chats.coauthorContextLinks.
  const contextLinks = useSnapshotStore((s) => s.activeChat?.coauthorContextLinks ?? EMPTY_CONTEXT_LINKS);
  // Characters come from the snapshot (no dedicated list endpoint); personas /
  // lorebooks / scripts are fetched once on mount (same pattern as the build
  // panel's bound-resources field). Only enabled lorebooks/scripts hold context.
  const allCharacters = useSnapshotStore((s) => s.allCharacters);
  const [allLorebooks, setAllLorebooks] = useState<LorebookRecord[]>([]);
  const [allPersonas, setAllPersonas] = useState<PersonaRecord[]>([]);
  const [allScripts, setAllScripts] = useState<ScriptRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([listAllLorebooks(), listPersonas(), listAllScripts()]).then(([lb, pe, sc]) => {
      if (cancelled) return;
      setAllLorebooks(lb);
      setAllPersonas(pe);
      setAllScripts(sc);
    });
    return () => { cancelled = true; };
  }, []);
  const characterTargets: LinkTarget[] = useMemo(
    () => allCharacters.map((c) => ({
      id: c.id,
      name: c.name,
      avatarAssetId: c.avatarAssetId,
      kind: "characters" as const,
      avatarExt: c.avatarExt,
      avatarFullExt: c.avatarFullExt,
      avatarFullAssetId: c.avatarFullAssetId,
      updatedAt: c.updatedAt,
    })),
    [allCharacters],
  );
  const personaTargets: LinkTarget[] = useMemo(
    () => allPersonas.map((p) => ({
      id: p.id,
      name: p.name,
      avatarAssetId: p.avatarAssetId,
      kind: "personas" as const,
      avatarExt: p.avatarExt,
      avatarFullExt: p.avatarFullExt,
      avatarFullAssetId: p.avatarFullAssetId,
      updatedAt: p.updatedAt,
    })),
    [allPersonas],
  );
  const lorebookTargets: LinkTarget[] = useMemo(
    () => allLorebooks.filter((lb) => lb.enabled).map((lb) => ({ id: lb.id, name: lb.name, avatarAssetId: null })),
    [allLorebooks],
  );
  const scriptTargets: LinkTarget[] = useMemo(
    () => allScripts.filter((sc) => sc.enabled).map((sc) => ({ id: sc.id, name: sc.name, avatarAssetId: null })),
    [allScripts],
  );
  const handleSetContextLinks = (next: { targetType: "character" | "persona" | "lorebook" | "script"; targetId: string }[]) => {
    if (!chatId || locked) return;
    // Wholesale replace — the typed links in the picker are the new pinned set.
    void setCoauthorContextLinksAction(brandId<ChatId>(chatId), next);
  };

  const form = useForm<BuildCharacterDraft>({
    resolver: zodResolver(buildCharacterDraftSchema),
    defaultValues: characterDefaults(character),
  });
  const { setValue, formState } = form;

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorBodyRef = useRef<string>("");
  const editorOriginatedRef = useRef(false);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  if (editableCompartmentRef.current === null) {
    editableCompartmentRef.current = new Compartment();
  }
  const editableCompartment = editableCompartmentRef.current;

  // ── Editor state (idle / generating / reviewing) ───────────────────────────
  // reviewing is entered when a turn ends and the turn store holds finalized
  // proposals. The editor is locked in BOTH non-idle states; reviewing adds the
  // diff overlay + Apply/Reject (rendered below). hasProposal is a cheap guard
  // so we don't aggregate on every render; the full aggregation is memoized.
  const hasProposal =
    !isSending && activities.some((a) => a.status === "done" && ((!!a.proposed && !!a.target) || !!a.loreBundle));
  const editorState: "idle" | "generating" | "reviewing" = isSending
    ? "generating"
    : hasProposal
      ? "reviewing"
      : "idle";
  const locked = editorState !== "idle";
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // Aggregate the turn into a proposal (proposed body for the diff + Apply
  // request). Recomputed only while reviewing; the form draft is stable during
  // reviewing (the editor is locked), so reading it here is correct.
  const proposal = useMemo(() => {
    if (editorState !== "reviewing") return null;
    return aggregateCoauthorProposal(activities, form.getValues());
    // editorState + activities are the reactive inputs; `form` is a stable
    // instance and its values are frozen while reviewing (locked editor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState, activities]);

  const [applying, setApplying] = useState(false);

  // ── CA-12: hunk-level (granular) selection over the reviewing diff. ────────
  // The diff is body-space (canonical → proposed). It is memoized so the hunk
  // set is stable while reviewing (the editor is locked → the draft, and thus
  // both bodies, are frozen). `selectedHunkIds` defaults to ALL hunks
  // (CA-11 wholesale behavior); a useEffect resets it to all whenever a NEW
  // proposal's hunks appear. Toggling a hunk mutates only the selection, so the
  // reset effect (keyed on `hunks`) doesn't fire mid-review.
  const reviewing = editorState === "reviewing" && proposal?.hasProposal;
  const diff = useMemo(() => {
    if (!reviewing || !proposal?.hasProposal) return null;
    return buildLineDiff(draftToBody(form.getValues()), draftToBody(proposal.proposedDraft));
    // `reviewing` + `proposal` are the reactive inputs; `form` is stable and its
    // values are frozen while reviewing (locked editor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewing, proposal]);
  // Single source of truth for the reviewing UI: hide the editor surface AND
  // mount the overlay only when we actually have something to show — a body
  // diff (profile/greeting) AND/OR a proposed lore bundle (CTX-L3). The editor
  // container stays in the DOM (display:none) so its CM6 lifecycle is never
  // torn down between states — it just leaves flow so it can't be scrolled to.
  const showReview = reviewing && (!!diff || !!proposal?.loreBundle);
  const hunks = useMemo(() => (diff ? groupHunks(diff) : []), [diff]);
  const [selectedHunkIds, setSelectedHunkIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    // New proposal → start from "apply everything" (wholesale default).
    setSelectedHunkIds(allHunkIds(hunks));
  }, [hunks]);

  // ── CTX-L3: lore per-item selection (parent-dependency enforced at render +
  //    Apply). Defaults to ALL (wholesale), reset on each new lore bundle. ─
  const loreBundle = proposal?.loreBundle;
  const [selectedLorebookIds, setSelectedLorebookIds] = useState<Set<string>>(new Set());
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    // New lore proposal → start from "accept everything".
    if (loreBundle) {
      setSelectedLorebookIds(allLorebookIds(loreBundle));
      setSelectedEntryIds(allEntryIds(loreBundle));
    }
  }, [loreBundle]);

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
    if (lockedRef.current) return;
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
    if (lockedRef.current) return;
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
    // isSending is handled by the lock effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      effects: editableCompartment.reconfigure(EditorView.editable.of(!locked)),
    });
  }, [locked, editableCompartment]);

  async function handleSave(): Promise<void> {
    await form.handleSubmit(async (data) => {
      await handleSaveCharacter(data);
      form.reset(data);
    })();
  }

  // ── CA-11: Apply / Reject the turn's aggregated proposal ───────────────────
  async function handleApply(): Promise<void> {
    if (!chatId || !proposal?.hasProposal) return;
    setApplying(true);
    try {
      // CA-12: rebuild the Apply request from the user's hunk selection. When all
      // hunks are selected this is semantically identical to the wholesale
      // proposal (CA-11); a subset yields a partial apply (merged body → rebuilt
      // profileMd with proposed frontmatter + merged prose, + merged greetings).
      const request = diff
        ? buildPartialApplyRequest(mergeSelectedBody(diff, selectedHunkIds), proposal)
        : { ...proposal.applyRequest };
      // CTX-L3: narrow the lore bundle by the user's per-item selection
      // (parent-dependency enforced — an entry whose book was rejected is
      // dropped). A fully-deselected bundle yields an empty graph; omit it so
      // Apply leaves lore untouched (consistent with omitted profile/greeting).
      if (proposal.loreBundle) {
        const selected = selectLoreBundle(proposal.loreBundle, selectedLorebookIds, selectedEntryIds);
        if (selected.lorebooks.length > 0) {
          request.loreBundle = selected;
        } else {
          delete request.loreBundle;
        }
      }
      const { snapshot, corrections } = await applyCoauthorDraft(
        brandId<ChatId>(chatId),
        request,
      );
      useSnapshotStore.getState().ingestSnapshot(snapshot);
      useCoauthorTurnStore.getState().clearTurn(chatId); // → reviewing falls to idle
      // Re-seed the form/editor to the freshly-written canonical so the user
      // immediately sees the applied document (the snapshot carries the new card).
      const fresh = useSnapshotStore.getState().character;
      if (fresh) {
        form.reset(characterDefaults(fresh));
        forceEditorFromBody();
      }
      // R3: surface backend corrections (e.g. an empty name restored) — never silent.
      for (const c of corrections) {
        toast.warning(`${c.field} — ${c.reason}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("coauthor.review.apply_failed"));
    } finally {
      setApplying(false);
    }
  }

  function handleReject(): void {
    if (!chatId) return;
    // Discard the proposal; the editor is unchanged (it was locked for the whole
    // turn, so it still shows the pre-turn canonical). Clearing the turn store
    // drops hasProposal → editorState returns to idle (editable).
    useCoauthorTurnStore.getState().clearTurn(chatId);
  }

  const isDirty = formState.isDirty;
  const canSave = (form.watch("name") || "").trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar — title + state subtitle + save. */}
      <div className="glass-bar sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-surface px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-body text-[15px] font-medium text-t1">
            {character.name || t("unnamed")}
          </div>
          <div className="font-ui text-[11px] text-t3">
            {editorState === "reviewing"
              ? t("coauthor.review.state")
              : locked
                ? t("coauthor.editor.locked")
                : isDirty
                  ? t("unsaved_changes")
                  : t("saved_state")}
          </div>
        </div>
        <SaveButton
          dirty={isDirty}
          saveState={isSavingCharacter ? "saving" : "idle"}
          resetKey={character.id}
          disabled={!canSave || locked || isSavingCharacter}
          label={t("save")}
          onClick={() => { void handleSave(); }}
          size="compact"
          className="shrink-0"
        />
      </div>

      {/* CE-C1/C2/C3: the three context LEVELS, grouped so their distinction
          is obvious. Each level has a caption stating what the model actually
          sees — L1 full content vs L2/L3 awareness-only (names/titles). L1
          persists on the chat (coauthorContextLinks); L2/L3 bind to the
          character (lorebook_links / script_links via BoundResourcesField, the
          same shared primitive the card editor uses). */}
      <div className="shrink-0 border-b border-border/50 bg-surface px-4 py-2">
        {/* Level 1 — pinned, full content. */}
        <div className="flex items-center gap-2">
          <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">{t("coauthor.context.label")}</span>
          <LinkBindingPopover
            links={[...contextLinks]}
            characters={characterTargets}
            personas={personaTargets}
            lorebooks={lorebookTargets}
            scripts={scriptTargets}
            onSetLinks={(next) => handleSetContextLinks(next as { targetType: "character" | "persona" | "lorebook" | "script"; targetId: string }[])}
            t={t}
            isMobile={false}
            tooltipLabel={t("coauthor.context.add")}
            emptyLabel={t("coauthor.context.empty")}
            disabled={locked}
          />
        </div>
        <p className="mt-1 font-ui text-[11px] leading-snug text-t4">{t("coauthor.context.caption_full")}</p>
        {/* Level 2/3 — bound lorebooks & scripts, awareness only. Skipped when
            the character has no persisted id (unsaved draft has no bindings). */}
        {character.id && (
          <div className="mt-1">
            <BoundResourcesField
              entityKind="character"
              entityId={character.id}
              isMobile={false}
              lorebookCaption={t("coauthor.context.bound_lorebooks_caption")}
              scriptCaption={t("coauthor.context.bound_scripts_caption")}
            />
          </div>
        )}
      </div>

      {/* Body: editor surface OR the reviewing overlay (CA-11/CA-12). The editor
          container stays mounted (display:none while reviewing — CM6 lifecycle
          preserved) but is removed from flow so it cannot be scrolled to and
          doesn't show through; the reviewing overlay takes its place and fills
          the panel height (diff stretches, footer sits at the bottom). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={"min-h-0 flex-1 overflow-y-auto px-4 py-4" + (showReview ? " hidden" : "")}>
          <label className={lblCls + " mb-1.5 block"}>{t("coauthor.editor.label")}</label>
          <div
            ref={editorHostRef}
            className="vibe-md-editor rounded-lg border border-border"
            style={{ minHeight: 360 }}
          />
          <p className="mt-1.5 font-ui text-[11px] text-t4">{t("coauthor.editor.hint")}</p>
        </div>

        {/* Generating dim scrim — overlaps the editor body with
            pointer-events-auto to intercept clicks to CodeMirror widget
            decorations (greeting add/remove buttons) that bypass the
            EditorView.editable facet. No AnimatePresence: the enter fade-in
            still plays (motion initial→animate), but exit is instant so the
            scrim stops intercepting clicks the moment the lock lifts (no
            ~0.2s gap where the editor is editable but clicks are absorbed). */}
        {editorState === "generating" && (
          <GeneratingScrim
            variant="dim"
            label={t("coauthor.editor.locked")}
            pointerEvents="auto"
          />
        )}

        {showReview && (
          <ReviewingOverlay
            summary={proposal.summaries.join(" · ") || t("coauthor.review.no_summary")}
            diff={diff}
            hunks={hunks}
            selectedHunkIds={selectedHunkIds}
            onToggleHunk={(id) =>
              setSelectedHunkIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })
            }
            onSelectAll={() => setSelectedHunkIds(allHunkIds(hunks))}
            onSelectNone={() => setSelectedHunkIds(new Set())}
            applying={applying}
            onApply={() => { void handleApply(); }}
            onReject={handleReject}
            loreBundle={proposal.loreBundle}
            selectedLorebookIds={selectedLorebookIds}
            selectedEntryIds={selectedEntryIds}
            onToggleLorebook={(id) =>
              setSelectedLorebookIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })
            }
            onToggleEntry={(id) =>
              setSelectedEntryIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })
            }
            loreLabels={{
              title: t("coauthor.lore.review.title"),
              lorebook: t("coauthor.lore.review.lorebook"),
              keys: t("coauthor.lore.review.keys"),
              secondaryKeys: t("coauthor.lore.review.secondary_keys"),
              constant: t("coauthor.lore.review.constant"),
              editing: t("coauthor.lore.review.editing"),
              existingLorebook: t("coauthor.lore.review.existing_lorebook"),
              entriesOne: t("coauthor.lore.review.entries_one"),
              entriesFew: t("coauthor.lore.review.entries_few"),
              entriesMany: t("coauthor.lore.review.entries_many"),
              scopeCharacter: t("coauthor.lore.review.scope_character"),
              scopePersona: t("coauthor.lore.review.scope_persona"),
              scopeGlobal: t("coauthor.lore.review.scope_global"),
              scopeChat: t("coauthor.lore.review.scope_chat"),
              noContent: t("coauthor.lore.review.no_content"),
            }}
            labels={{
              title: t("coauthor.review.title"),
              tooLarge: t("coauthor.review.too_large"),
              noChanges: t("coauthor.review.no_changes"),
              apply: t("coauthor.review.apply"),
              reject: t("coauthor.review.reject"),
              applying: t("coauthor.review.applying"),
              selectAll: t("coauthor.review.select_all"),
              selectNone: t("coauthor.review.select_none"),
              applyingCount: t("coauthor.review.applying_count"),
              hunkN: t("coauthor.review.hunk_n"),
              skipped: t("coauthor.review.skipped"),
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The reviewing overlay (CA-11): the turn's proposed edits shown as an inline
 * diff over the editor, with Apply / Reject. Absolutely positioned over the
 * editor surface so the editor instance stays mounted (no teardown between
 * states). Apply commits via the CA-7 RPC; Reject discards.
 */
function ReviewingOverlay({
  summary,
  diff,
  hunks,
  selectedHunkIds,
  onToggleHunk,
  onSelectAll,
  onSelectNone,
  applying,
  onApply,
  onReject,
  loreBundle,
  selectedLorebookIds,
  selectedEntryIds,
  onToggleLorebook,
  onToggleEntry,
  loreLabels,
  labels,
}: {
  summary: string;
  diff: ReturnType<typeof buildLineDiff> | null;
  hunks: ReturnType<typeof groupHunks>;
  selectedHunkIds: Set<number>;
  onToggleHunk: (id: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  applying: boolean;
  onApply: () => void;
  onReject: () => void;
  /** CTX-L3: the proposed lore bundle (absent on profile/greeting-only turns). */
  loreBundle?: import("@vibe-tavern/api-contracts").CoauthorLoreBundle;
  selectedLorebookIds: ReadonlySet<string>;
  selectedEntryIds: ReadonlySet<string>;
  onToggleLorebook: (id: string) => void;
  onToggleEntry: (id: string) => void;
  loreLabels: CoauthorLoreReviewLabels;
  labels: {
    title: string;
    tooLarge: string;
    noChanges: string;
    apply: string;
    reject: string;
    applying: string;
    selectAll: string;
    selectNone: string;
    applyingCount: string;
    hunkN: string;
    skipped: string;
  };
}) {
  // The diff section only fills the column when it actually has selectable
  // hunks. When the diff is empty / too-large it renders a one-line message
  // (no flex-1 inside HunkSelectionDiff) — if THIS wrapper still took flex-1,
  // that message would sit at the top with a dead gap below it, and a mixed
  // turn (empty diff + lore) would split the column 50/50 against empty space.
  // shrink-0 lets the message take natural height and gives the rest to lore.
  const hasDiffContent = !!diff && !diff.tooLarge && hunks.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {/* Summary — pinned top, frosted (.glass-blur) so it doesn't see-through
          on glass themes; the editor underneath is display:none, so the blur
          reads against the page background, not the editor. */}
      <div className="shrink-0 px-3 pt-3">
        <div className="glass-blur rounded-md border border-border/70 bg-glass-bg px-3 py-2">
          <div className="font-ui text-[12px] font-medium text-t2">{summary}</div>
        </div>
      </div>
      {/* Body diff (profile/greeting) — shown iff proposed. Each section takes
          flex-1 so a mixed turn (diff + lore) splits the space 50/50 and each
          scrolls internally; a single-section turn fills the whole area. */}
      {diff && (
        <div className={"flex flex-col px-1 py-2 " + (hasDiffContent ? "min-h-0 flex-1 " : "shrink-0 ")}>
          <HunkSelectionDiff
            diff={diff}
            hunks={hunks}
            selectedIds={selectedHunkIds}
            onToggleHunk={onToggleHunk}
            onSelectAll={onSelectAll}
            onSelectNone={onSelectNone}
            labels={{
              title: labels.title,
              tooLarge: labels.tooLarge,
              noChanges: labels.noChanges,
              selectAll: labels.selectAll,
              selectNone: labels.selectNone,
              applyingCount: labels.applyingCount,
              hunkN: labels.hunkN,
              skipped: labels.skipped,
            }}
          />
        </div>
      )}
      {/* CTX-L3: structured lore review (lorebooks + entries). Shown iff proposed. */}
      {loreBundle && (
        <div className="flex min-h-0 flex-1 flex-col">
          <CoauthorLoreReview
            bundle={loreBundle}
            selectedLorebookIds={selectedLorebookIds}
            selectedEntryIds={selectedEntryIds}
            onToggleLorebook={onToggleLorebook}
            onToggleEntry={onToggleEntry}
            applying={applying}
            labels={loreLabels}
          />
        </div>
      )}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 bg-surface px-4 py-2.5">
        <button
          type="button"
          className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[0.8rem] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          disabled={applying}
          onClick={onReject}
        >
          {labels.reject}
        </button>
        <button
          type="button"
          className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[0.8rem] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          disabled={applying}
          onClick={onApply}
        >
          {applying ? labels.applying : labels.apply}
        </button>
      </div>
    </div>
  );
}
