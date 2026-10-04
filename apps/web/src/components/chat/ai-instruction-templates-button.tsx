/**
 * «Шаблоны» — the instruction-template menu for the message AI editor
 * (AI_EDITOR_INSTRUCTION_TEMPLATES step 3; chrome polished to the house
 * popover canon in the follow-up review).
 *
 * Dual-mode by viewport, both on shared primitives (the ImageGenFineTuningChip
 * canon): desktop = Radix Popover anchored under the button (portal into the
 * host modal via getModalPortal; content chrome = the QuickSwitchPopover /
 * ToolbarSelect canon string verbatim — border-border2, py-2 rhythm, the
 * fade/zoom in-out animations — plus this menu's own width); mobile =
 * BottomSheet with the SAME body (row icon buttons grow to the 44px touch
 * floor there; 32px squares on desktop).
 *
 * Body top-to-bottom: the template list (click a name → insert → close),
 * per-row inline rename (`InlineRenameInput`) and delete
 * (`DestructiveConfirmModal`, «Удалить шаблон?»), the empty state, and the
 * footer «Сохранить текущую как шаблон» (name = first line of the
 * instruction, trimmed; disabled while the field is empty — a name clash
 * auto-numbers «name (2)», «name (3)», … inside the hook). Data comes from
 * the ONE shared source (use-ai-instruction-templates.ts); this component
 * only renders it. Names ellipsize in the row only (OverflowTooltip shows
 * the full name; the rename field edits it). The list scrolls past
 * MAX_VISIBLE_ITEMS rows (popover-constants rule). The trigger chevron is
 * the shared caret icon (the dropdown-trigger canon), not a text glyph.
 */
import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Icons } from "../shared/icons.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { InlineRenameInput } from "../shared/InlineRenameInput.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { OverflowTooltip } from "../shared/OverflowTooltip.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { popoverMaxHeight } from "../shared/popover-constants.js";
import { useAiInstructionTemplates } from "./use-ai-instruction-templates.js";
import type { AiInstructionTemplate } from "@vibe-tavern/api-contracts";

/** The compact label-row action canon (the AI-generate button family). */
const triggerBtnCls =
  "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1";

/** The trigger's dropdown caret — same icon and size the other dropdown-style
 *  triggers use (ExperienceCopilotInputArea, ExperienceSessionSwitcher). */
function TriggerCaret() {
  return <Icons.Caret direction="d" className="h-3 w-3 shrink-0 text-t3" />;
}

interface AiInstructionTemplatesButtonProps {
  /** The live instruction field text (save-current + its disabled gate). */
  instruction: string;
  /** Insert a template's text into the field — the field owner decides
   *  replace-vs-append; this component just closes the menu after. */
  onInsert: (text: string) => void;
}

export function AiInstructionTemplatesButton({ instruction, onInsert }: AiInstructionTemplatesButtonProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const source = useAiInstructionTemplates(open);
  /** Rename session: the row's template id + the draft name. */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  /** Delete confirmation target (null = dialog closed). */
  const [deleting, setDeleting] = useState<AiInstructionTemplate | null>(null);

  const insertAndClose = (text: string) => {
    onInsert(text);
    setOpen(false);
  };

  /** «Save current as template»: name = the first line, trimmed; the new
   *  template lands at the end of the list (sortOrder append-last). */
  const saveCurrent = async () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    const firstLine = trimmed.split("\n")[0] ?? trimmed;
    // Name clashes auto-number inside the hook («name (2)», …) — save-current
    // never fails on a duplicate first line.
    await source.createTemplate(firstLine, trimmed);
  };

  /** Commit the rename (Enter/blur); an emptied name just aborts — there is
   *  nothing meaningful to save and the schema refuses empty. */
  const commitRename = async () => {
    if (!renaming) return;
    const next = renaming.draft.trim();
    const target = source.templates.find((tpl) => tpl.id === renaming.id) ?? null;
    setRenaming(null);
    if (!target || !next || next === target.name) return;
    await source.renameTemplate(target.id, next);
  };

  const confirmDelete = async () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    await source.deleteTemplate(target.id);
  };

  const body = (
    <TemplateMenuBody
      templates={source.templates}
      loading={source.loading}
      renaming={renaming}
      touch={isMobile}
      canSaveCurrent={instruction.trim().length > 0}
      onPick={(tpl) => insertAndClose(tpl.text)}
      onStartRename={(tpl) => setRenaming({ id: tpl.id, draft: tpl.name })}
      onDraftRename={(draft) => setRenaming((prev) => (prev ? { ...prev, draft } : prev))}
      onCommitRename={() => void commitRename()}
      onCancelRename={() => setRenaming(null)}
      onRequestDelete={setDeleting}
      onSaveCurrent={() => void saveCurrent()}
    />
  );

  const confirmDialog = deleting !== null && (
    <DestructiveConfirmModal
      title={t("message_ai_editor_templates_delete_title")}
      body={t("message_ai_editor_templates_delete_body", { name: deleting.name })}
      confirmLabel={t("message_ai_editor_templates_delete_confirm")}
      onConfirm={() => void confirmDelete()}
      onCancel={() => setDeleting(null)}
    />
  );

  if (isMobile) {
    return (
      <>
        <button type="button" className={triggerBtnCls} onClick={() => setOpen(true)}>
          {t("message_ai_editor_templates_button")}
          <TriggerCaret />
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t("message_ai_editor_templates_title")}>
          {body}
        </BottomSheet>
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setRenaming(null); }}>
        <Popover.Trigger asChild>
          <button type="button" className={triggerBtnCls}>
            {t("message_ai_editor_templates_button")}
            <TriggerCaret />
          </button>
        </Popover.Trigger>
        <Popover.Portal container={getModalPortal() ?? document.body}>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={4}
            className="glass-blur z-[220] min-w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg py-2 px-1.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {body}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {confirmDialog}
    </>
  );
}

interface TemplateMenuBodyProps {
  templates: AiInstructionTemplate[];
  loading: boolean;
  renaming: { id: string; draft: string } | null;
  /** Mobile sheet rendering: row icon buttons grow to the 44px touch floor
   *  (h-11 w-11); desktop popover keeps the 32px squares (h-8 w-8). */
  touch: boolean;
  canSaveCurrent: boolean;
  onPick: (tpl: AiInstructionTemplate) => void;
  onStartRename: (tpl: AiInstructionTemplate) => void;
  onDraftRename: (draft: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (tpl: AiInstructionTemplate) => void;
  onSaveCurrent: () => void;
}

/** The menu content shared verbatim by the desktop popover and the mobile
 *  sheet — one body, two shells (the dual-mode canon). */
function TemplateMenuBody(props: TemplateMenuBodyProps) {
  const { t } = useT();
  const { templates, loading, renaming, touch } = props;
  const iconBtnCls = `flex ${touch ? "h-11 w-11" : "h-8 w-8"} shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-colors`;

  return (
    <div className="flex flex-col gap-1.5">
      {templates.length === 0 ? (
        <div className="px-2 py-3 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">
          {loading ? t("message_ai_editor_templates_loading") : t("message_ai_editor_templates_empty")}
        </div>
      ) : (
        <ul className="flex flex-col overflow-y-auto" style={{ maxHeight: popoverMaxHeight("touchRow") }}>
          {templates.map((tpl) => (
            <li key={tpl.id} className="flex min-h-11 items-center gap-1">
              {renaming?.id === tpl.id ? (
                <InlineRenameInput
                  autoFocus
                  className="min-w-0 flex-1"
                  value={renaming.draft}
                  onChange={(e) => props.onDraftRename(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      props.onCommitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      props.onCancelRename();
                    }
                  }}
                  onBlur={props.onCommitRename}
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer rounded px-2 py-2 text-left font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:bg-s2 hover:text-t1"
                  onClick={() => props.onPick(tpl)}
                >
                  <OverflowTooltip text={tpl.name} side="top" />
                </button>
              )}
              <button
                type="button"
                className={`${iconBtnCls} hover:bg-s2 hover:text-t1`}
                onClick={() => props.onStartRename(tpl)}
                aria-label={t("message_ai_editor_templates_rename")}
                disabled={renaming !== null}
              >
                <Icons.edit />
              </button>
              <button
                type="button"
                className={`${iconBtnCls} hover:bg-s2 hover:text-danger-text`}
                onClick={() => props.onRequestDelete(tpl)}
                aria-label={t("message_ai_editor_templates_delete")}
                disabled={renaming !== null}
              >
                <Icons.del />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={props.onSaveCurrent}
        disabled={!props.canSaveCurrent}
      >
        <Icons.plus />
        {t("message_ai_editor_templates_save_current")}
      </button>
    </div>
  );
}
