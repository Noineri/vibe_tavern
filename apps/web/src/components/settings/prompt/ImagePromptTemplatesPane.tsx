import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ImagePromptFamiliesValue,
  ImagePromptFamilyInfoValue,
  ImagePromptFamilyValue,
  ImagePromptTemplateCellValue,
  ImagePromptTemplateRowKeyValue,
  ImagePromptTemplatesValue,
} from "@vibe-tavern/api-contracts";
import { IMAGE_GENERATION_MODES, IMAGE_PROMPT_DEFAULT_FAMILY } from "@vibe-tavern/domain";
import { toast } from "sonner";
import {
  listImagePromptFamilies,
  listImagePromptTemplates,
  resetImagePromptTemplate,
  upsertImagePromptTemplate,
} from "../../../api/image-gen-api.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { codeQuoteCls, lblCls } from "../../../lib/field-tokens.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { MasterDetailFooter } from "../../shared/MasterDetailModal.js";
import { SaveButton } from "../../shared/SaveBar.js";

export interface ImagePromptTemplatesPaneSlots {
  master: ReactNode;
  detail: ReactNode;
  footer: ReactNode;
  dirty: boolean;
}

export interface ImagePromptTemplatesPaneApi {
  listTemplates: () => Promise<ImagePromptTemplatesValue>;
  listFamilies: () => Promise<ImagePromptFamiliesValue>;
  upsert: (
    rowKey: ImagePromptTemplateRowKeyValue,
    family: ImagePromptFamilyValue,
    body: { body: string },
  ) => Promise<ImagePromptTemplateCellValue>;
  reset: (
    rowKey: ImagePromptTemplateRowKeyValue,
    family: ImagePromptFamilyValue,
  ) => Promise<ImagePromptTemplateCellValue>;
}

const defaultApi: ImagePromptTemplatesPaneApi = {
  listTemplates: listImagePromptTemplates,
  listFamilies: listImagePromptFamilies,
  upsert: upsertImagePromptTemplate,
  reset: resetImagePromptTemplate,
};

type SelectedRow = { kind: "template"; rowKey: ImagePromptTemplateRowKeyValue } | { kind: "assist" };
export type ImagePromptTemplatesPaneRowId = ImagePromptTemplateRowKeyValue | "assist";
type EditorSelection = { row: SelectedRow; family: ImagePromptFamilyValue };
type Draft = { cellKey: string; text: string };

function rowLabelKey(rowKey: ImagePromptTemplateRowKeyValue): string {
  return rowKey === "negative" ? "imagePromptTemplates.negative" : `image_gen_mode_${rowKey}`;
}

function familyLabelKey(family: ImagePromptFamilyValue): string {
  return `imagePromptTemplates.family.${family}`;
}

function familyDetailKey(family: ImagePromptFamilyValue): string {
  return `imagePromptTemplates.familyDetail.${family}`;
}

function rowIdFor(row: SelectedRow): ImagePromptTemplatesPaneRowId {
  return row.kind === "assist" ? "assist" : row.rowKey;
}

function cellKey(cell: ImagePromptTemplateCellValue): string {
  return `${cell.rowKey}:${cell.family}`;
}

function cellText(cell: ImagePromptTemplateCellValue): string {
  return cell.customText ?? cell.canonText;
}

export function ImagePromptTemplatesPane({
  active,
  children,
  renderRowDrillDown,
  onDirtyChange,
  onClose,
  api = defaultApi,
}: {
  active: boolean;
  children: (slots: ImagePromptTemplatesPaneSlots) => ReactNode;
  /** Mobile master-detail seam, matching ServicePromptsPane. */
  renderRowDrillDown?: (rowId: ImagePromptTemplatesPaneRowId, selectRow: () => void) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
  onClose?: () => void;
  /** Test seam: production uses the typed image-gen API client above. */
  api?: ImagePromptTemplatesPaneApi;
}): ReactNode {
  const { t, tDynamic } = useT();
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [templates, setTemplates] = useState<ImagePromptTemplatesValue | null>(null);
  const [families, setFamilies] = useState<ImagePromptFamilyInfoValue[]>([]);
  const [selectedRow, setSelectedRow] = useState<SelectedRow | null>(null);
  const [selectedFamilies, setSelectedFamilies] = useState<Partial<Record<ImagePromptTemplatesPaneRowId, ImagePromptFamilyValue>>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingSelection, setPendingSelection] = useState<EditorSelection | null>(null);
  const [saving, setSaving] = useState(false);

  const rowKeys = useMemo(() => {
    if (!templates) return [];
    return Array.from(new Set(templates.cells.map((cell) => cell.rowKey)));
  }, [templates]);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [nextTemplates, familyResponse] = await Promise.all([api.listTemplates(), api.listFamilies()]);
      const firstFamily = familyResponse.families[0]?.id;
      setTemplates(nextTemplates);
      setFamilies(familyResponse.families);
      if (firstFamily) {
        setSelectedFamilies((current) => {
          const next = { ...current };
          for (const rowId of [...new Set(nextTemplates.cells.map((cell) => cell.rowKey)), "assist"] as ImagePromptTemplatesPaneRowId[]) {
            next[rowId] ??= firstFamily;
          }
          next[IMAGE_GENERATION_MODES.Free] = IMAGE_PROMPT_DEFAULT_FAMILY;
          return next;
        });
      }
      setSelectedRow((current) => current ?? { kind: "template", rowKey: nextTemplates.cells[0]?.rowKey ?? "negative" });
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [api]);

  useEffect(() => {
    if (active && loadState === "idle") void load();
  }, [active, load, loadState]);

  const selectedFamily = selectedRow
    ? selectedRow.kind === "template" && selectedRow.rowKey === IMAGE_GENERATION_MODES.Free
      ? IMAGE_PROMPT_DEFAULT_FAMILY
      : selectedFamilies[rowIdFor(selectedRow)]
    : undefined;
  const selectedCell = useMemo(() => {
    if (!templates || !selectedRow || selectedRow.kind !== "template" || !selectedFamily) return null;
    return templates.cells.find((cell) => cell.rowKey === selectedRow.rowKey && cell.family === selectedFamily) ?? null;
  }, [selectedFamily, selectedRow, templates]);

  const selectedCellKey = selectedCell ? cellKey(selectedCell) : null;
  const savedText = selectedCell ? cellText(selectedCell) : "";
  const draftText = draft?.cellKey === selectedCellKey ? draft.text : savedText;
  const dirty = selectedCell !== null && draft?.cellKey === selectedCellKey && draft.text !== savedText;

  useEffect(() => {
    onDirtyChange?.(active && dirty);
  }, [active, dirty, onDirtyChange]);

  const replaceCell = useCallback((updated: ImagePromptTemplateCellValue) => {
    setTemplates((current) => current
      ? { ...current, cells: current.cells.map((cell) => cell.rowKey === updated.rowKey && cell.family === updated.family ? updated : cell) }
      : current);
    setDraft({ cellKey: cellKey(updated), text: cellText(updated) });
  }, []);

  const applySelection = useCallback((next: EditorSelection) => {
    setSelectedFamilies((current) => ({ ...current, [rowIdFor(next.row)]: next.family }));
    setSelectedRow(next.row);
  }, []);

  const requestSelection = useCallback((next: EditorSelection) => {
    if (saving) return;
    const currentRowId = selectedRow ? rowIdFor(selectedRow) : null;
    if (currentRowId === rowIdFor(next.row) && selectedFamily === next.family) return;
    if (dirty) {
      setPendingSelection(next);
      return;
    }
    applySelection(next);
  }, [applySelection, dirty, saving, selectedFamily, selectedRow]);

  const confirmDiscard = useCallback(() => {
    if (!pendingSelection) return;
    setDraft(null);
    applySelection(pendingSelection);
    setPendingSelection(null);
  }, [applySelection, pendingSelection]);

  const handleSave = useCallback(async () => {
    if (saving || !selectedCell || !selectedFamily || !dirty) return;
    setSaving(true);
    try {
      const updated = draftText.trim()
        ? await api.upsert(selectedCell.rowKey, selectedFamily, { body: draftText })
        : await api.reset(selectedCell.rowKey, selectedFamily);
      replaceCell(updated);
    } catch {
      toast.error(t("imagePromptTemplates.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [api, dirty, draftText, replaceCell, saving, selectedCell, selectedFamily, t]);

  const handleReset = useCallback(async () => {
    if (saving || !selectedCell || !selectedFamily) return;
    setSaving(true);
    try {
      replaceCell(await api.reset(selectedCell.rowKey, selectedFamily));
    } catch {
      toast.error(t("imagePromptTemplates.resetFailed"));
    } finally {
      setSaving(false);
    }
  }, [api, replaceCell, saving, selectedCell, selectedFamily, t]);

  if (!active) return children({ master: null, detail: null, footer: null, dirty: false });

  const familyOptions = families.map((family) => ({
    id: family.id,
    label: tDynamic(familyLabelKey(family.id)),
    detail: tDynamic(familyDetailKey(family.id)),
  }));

  const renderRow = (rowId: ImagePromptTemplatesPaneRowId, label: string, isTemplate: boolean) => {
    const isFreeRow = rowId === IMAGE_GENERATION_MODES.Free;
    const family = isFreeRow ? IMAGE_PROMPT_DEFAULT_FAMILY : selectedFamilies[rowId] ?? families[0]?.id;
    const row = isTemplate ? { kind: "template" as const, rowKey: rowId as ImagePromptTemplateRowKeyValue } : { kind: "assist" as const };
    const cell = isTemplate && family
      ? templates?.cells.find((candidate) => candidate.rowKey === rowId && candidate.family === family)
      : null;
    const selected = selectedRow !== null && rowIdFor(selectedRow) === rowId;
    const statusKey = cell?.isCustomized ? "imagePromptTemplates.status.custom" : "imagePromptTemplates.status.canon";
    const selectRow = () => {
      if (family) requestSelection({ row, family });
    };
    return (
      <div
        key={rowId}
        data-testid={`image-prompt-template-row-${rowId}`}
        className={cn("flex min-w-0 items-center gap-1.5 border-l-2 px-3 py-2.5", selected ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2")}
      >
        <button
          type="button"
          onClick={selectRow}
          disabled={saving}
          className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default", selected ? "text-accent-t" : "text-t2")}
        >
          <span className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] font-medium">{label}</span>
          {isTemplate && (
            <span
              data-testid={`image-prompt-template-status-${rowId}`}
              role="img"
              aria-label={t(statusKey)}
              className={cn("ml-auto h-[6px] w-[6px] shrink-0 rounded-full", cell?.isCustomized ? "bg-accent" : "bg-t4")}
            />
          )}
        </button>
        {family && (
          <DropdownSelect
            value={family}
            options={familyOptions}
            onChange={(next) => {
              if (isFreeRow) return;
              const nextFamily = next as ImagePromptFamilyValue;
              if (selected) requestSelection({ row, family: nextFamily });
              else setSelectedFamilies((current) => ({ ...current, [rowId]: nextFamily }));
            }}
            disabled={saving || isFreeRow}
            searchable={false}
            triggerDetail={false}
            contentWidth={300}
            triggerTestId={`image-prompt-template-family-${rowId}`}
            triggerClassName="h-7 w-auto max-w-[136px] rounded border border-border bg-s2 px-2 py-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t1 hover:border-accent"
          />
        )}
        {renderRowDrillDown?.(rowId, selectRow)}
      </div>
    );
  };

  const master = (
    <div className="flex min-h-0 flex-1 flex-col py-2.5">
      <div className="shrink-0 px-[13px] pb-[5px] pt-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
        {t("imagePromptTemplates.masterTitle")}
      </div>
      {loadState === "loading" && <div className="px-4 py-6 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("loading")}</div>}
      {loadState === "error" && (
        <div className="px-4 py-4">
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-danger">{t("imagePromptTemplates.loadError")}</div>
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s3">{t("retry")}</button>
        </div>
      )}
      {loadState === "ready" && (
        <div className="flex-1 overflow-y-auto">
          {rowKeys.map((rowKey) => renderRow(rowKey, tDynamic(rowLabelKey(rowKey)), true))}
          {renderRow("assist", t("imagePromptTemplates.assist"), false)}
        </div>
      )}
    </div>
  );

  const selectedAssistAddendum = selectedFamily ? templates?.assist.addenda[selectedFamily] : undefined;
  const detail = (
    <div className="flex min-h-0 flex-col gap-5">
      {loadState === "loading" && <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("loading")}</div>}
      {loadState === "ready" && selectedRow?.kind === "template" && selectedCell && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className={cn(lblCls, "!mb-0")}>{tDynamic(rowLabelKey(selectedCell.rowKey))}</div>
              <div className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                {selectedCell.isCustomized ? t("imagePromptTemplates.status.custom") : t("imagePromptTemplates.status.canon")}
              </div>
            </div>
            {selectedCell.isCustomized && (
              <button type="button" onClick={() => void handleReset()} disabled={saving} className="h-7 cursor-pointer rounded-md border border-border bg-transparent px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-50">
                {t("reset")}
              </button>
            )}
          </div>
          <AutoTextarea
            mono
            value={draftText}
            onChange={(event) => selectedCellKey && setDraft({ cellKey: selectedCellKey, text: event.target.value })}
            disabled={saving}
            minRows={10}
            maxRows={24}
            aria-label={t("imagePromptTemplates.editorLabel")}
          />
        </>
      )}
      {loadState === "ready" && selectedRow?.kind === "assist" && templates && (
        <>
          <div>
            <div className={lblCls}>{t("imagePromptTemplates.assistCore")}</div>
            <div data-testid="image-prompt-template-assist-core" className={cn(codeQuoteCls, "max-h-56 overflow-auto")}>{templates.assist.core}</div>
          </div>
          <div>
            <div className={lblCls}>{t("imagePromptTemplates.assistAddendum")}</div>
            <div data-testid="image-prompt-template-assist-addendum" className={cn(codeQuoteCls, "max-h-56 overflow-auto")}>{selectedAssistAddendum ?? t("imagePromptTemplates.noAssistAddendum")}</div>
          </div>
        </>
      )}
    </div>
  );

  const footer = (
    <MasterDetailFooter
      onClose={onClose}
      right={selectedCell ? <SaveButton dirty={dirty} saveState={saving ? "saving" : "idle"} onClick={() => void handleSave()} resetKey={`${selectedCell.rowKey}:${selectedCell.family}`} /> : undefined}
    />
  );

  return (
    <>
      {children({ master, detail, footer, dirty: active && dirty })}
      {pendingSelection && (
        <DestructiveConfirmModal
          title={t("promptManager.servicePrompts.discardTitle")}
          body={t("promptManager.servicePrompts.discardBody")}
          onConfirm={confirmDiscard}
          onCancel={() => setPendingSelection(null)}
        />
      )}
    </>
  );
}
