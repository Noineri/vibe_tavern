// ManagementMobileRow — the shared mobile management row for the script and
// mini-app editors (owner decision 2026-10-17, AS-8c4f1: one row with the
// name, the enable toggle, the save button and a more-actions sheet — used
// for scripts now, adopted by mini-apps in f2). ONE row
// `flex w-full items-center gap-1.5`: the name TextInput (the bars' name
// classes, min-w-0 flex-1), an optional badge slot in a shrink-0 wrapper
// right after the name (authored copy, never truncated — the script kind
// lives here since owner 2026-10-17 AS-8c4h moved it out of the sheet into
// the name row; mini-apps pass no badge), the enable Toggle (disabled locks
// it), the SaveButton (floppy icon, same dirty/state/resetKey/label props
// as the bars) and a `...` icon button opening an ActionSheet with the
// caller's title and items. No status pill, no save-state text — the toggle
// and the save button carry the state. Plain props, no store reads.
import { useState, type ReactNode } from "react";
import { useT } from "../../../i18n/context.js";
import { Ic } from "../../shared/icons.js";
import { ActionSheet, type ActionSheetItem } from "../../shared/ActionSheet.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { Toggle } from "../../shared/Toggle.js";
import { TextInput } from "../../shared/text-input.js";
import type { ScriptDraftSaveState } from "../../../stores/script-draft-store.js";

interface ManagementMobileRowProps {
  name: string;
  namePlaceholder: string;
  onNameChange: (name: string) => void;
  enabled: boolean;
  enableLocked?: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  dirty: boolean;
  saveState: ScriptDraftSaveState;
  saveLabel: string;
  resetKey: string | null;
  onSave: () => void;
  sheetTitle: string;
  sheetItems: ActionSheetItem[];
  badge?: ReactNode;
}

export function ManagementMobileRow({
  name,
  namePlaceholder,
  onNameChange,
  enabled,
  enableLocked,
  onToggleEnabled,
  dirty,
  saveState,
  saveLabel,
  resetKey,
  onSave,
  sheetTitle,
  sheetItems,
  badge,
}: ManagementMobileRowProps) {
  const { t } = useT();
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <>
      <div className="flex w-full items-center gap-1.5">
        <TextInput
          className="min-w-0 flex-1 !text-[15px] font-semibold"
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={namePlaceholder}
        />
        {badge ? <div className="shrink-0">{badge}</div> : null}
        <Toggle
          checked={enabled}
          disabled={enableLocked}
          onChange={onToggleEnabled}
        />
        <SaveButton
          icon={<Ic.floppy />}
          dirty={dirty}
          saveState={saveState}
          resetKey={resetKey}
          onClick={onSave}
          label={saveLabel}
        />
        <button
          type="button"
          aria-label={t("management_more_actions")}
          title={t("management_more_actions")}
          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => setSheetOpen(true)}
        >
          <Ic.ellipsis />
        </button>
      </div>
      <ActionSheet
        open={sheetOpen}
        title={sheetTitle}
        items={sheetItems}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}
