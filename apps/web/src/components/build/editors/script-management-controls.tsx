// fork #1 of ExperienceManagementControls (ExperienceManagementControls.tsx)
// — the script editor's management bar. On desktop, row 1 clones the model's
// action cluster (name input, status pill, enable toggle, desktop-only
// save-state text, save button, delete) with three named deviations: (1) no
// duplicate button — scripts have no duplicate action today; (2) a read-only
// script-kind badge (prompt/dice) between the name input and the status
// pill — the kind is immutable after creation, so it is shown here, never
// edited; (3) the status pill has no tooltip — the model's
// experience_editor_trust_hint text is about interactive rules and is wrong
// for scripts (the pill text keys are reused as is). Row 1 is the whole bar:
// the description field plus the entity-only links block moved into the
// Code tab's toolbar strip (ScriptAgentEditorTabs) by owner decision
// 2026-10-17 (AS-8c4e) — layout B places them above the templates row. On
// mobile the bar renders the shared ManagementMobileRow instead: one row
// (name, kind badge, toggle, save, ...) with the delete alone moved into
// the more-actions sheet (owner decision 2026-10-17, AS-8c4f1 — the same
// shared row mini-apps adopt in f2; AS-8c4h moved the badge to the row).
//
// Every value and callback arrives via explicit props — no store reads,
// no new context.
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { Toggle } from "../../shared/Toggle.js";
import { TextInput } from "../../shared/text-input.js";
import { ManagementMobileRow } from "./management-mobile-row.js";
import type {
  ScriptDraftSaveState,
  ScriptDraftValues,
} from "../../../stores/script-draft-store.js";

interface ScriptManagementControlsProps {
  name: string;
  enabled: boolean;
  scriptKind: string;
  draftDirty: boolean;
  draftSaveState: ScriptDraftSaveState;
  draftError: string | null | undefined;
  resetKey: string | null;
  isMobile: boolean;
  onUpdateDraft: (patch: Partial<ScriptDraftValues>) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  onSave: () => void;
}

export function ScriptManagementControls({
  name,
  enabled,
  scriptKind,
  draftDirty,
  draftSaveState,
  draftError,
  resetKey,
  isMobile,
  onUpdateDraft,
  onToggleEnabled,
  onDelete,
  onSave,
}: ScriptManagementControlsProps) {
  const { t } = useT();
  // AS-8c4h: on mobile the whole bar is the shared ManagementMobileRow —
  // one row (name, kind badge, toggle, save, ...) with the delete alone in
  // the more-actions sheet. The sheet delete calls the same onDelete (the
  // existing confirm modal), so the delete flow is unchanged.
  if (isMobile) {
    return (
      <ManagementMobileRow
        name={name}
        namePlaceholder={t("script_name")}
        onNameChange={(value) => onUpdateDraft({ name: value })}
        enabled={enabled}
        onToggleEnabled={onToggleEnabled}
        dirty={draftDirty}
        saveState={draftSaveState}
        saveLabel={draftSaveState === "error" ? t("retry") : t("save")}
        resetKey={resetKey}
        onSave={onSave}
        sheetTitle={name}
        badge={
          <div className="rounded px-2 py-1 font-ui text-[11px] uppercase tracking-wide bg-s3 text-t2">
            {scriptKind === "dice" ? t("script_kind_dice") : t("script_kind_prompt")}
          </div>
        }
        sheetItems={[
          {
            icon: <Ic.del />,
            label: t("delete_script_confirm"),
            danger: true,
            action: onDelete,
          },
        ]}
      />
    );
  }
  return (
    <>
      <TextInput
        className="min-w-0 max-md:w-auto flex-1 !text-[15px] font-semibold"
        type="text"
        value={name}
        onChange={(e) => onUpdateDraft({ name: e.target.value })}
        placeholder={t("script_name")}
      />

      {/* The action cluster (badge → delete) is a flat `display:contents`
          group on desktop — a single flex-wrap row with the name — and becomes
          a nested flex row on mobile, so the header composes into rows:
          [name] / [badge, status, toggle, save, delete] (the bar is row-1
          only since AS-8c4e moved description + links to the Code tab).
          (A plain `flex-1` on the name cannot force this: basis-0 lets the
          shrink-0 pill/toggle squeeze onto row 1 at 40px of leftover width.) */}
      <div className="contents max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-1.5">
        {/* Script kind is immutable after creation — set via the New Script /
            New Dice Script buttons. Shown as a read-only badge so the user
            always sees which runtime a script targets. The previous kind
            toggle was removed: it could never persist (updateScriptSchema
            excludes scriptKind), so it silently reverted on save. */}
        <div className="rounded px-2 py-1 font-ui text-[11px] uppercase tracking-wide bg-s3 text-t2">
          {scriptKind === "dice" ? t("script_kind_dice") : t("script_kind_prompt")}
        </div>
        {/* No tooltip here (named deviation): the model's
            experience_editor_trust_hint text is about interactive rules and
            is wrong for scripts. */}
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase",
            enabled ? "bg-success-dim text-success-text" : "bg-warning-dim text-warning-text",
          )}
        >
          {/* Mobile: the status pill uses the short form ('on/off')
              below 768px so the whole action cluster fits one row; desktop
              keeps the full word. */}
          {t(
            enabled
              ? isMobile ? "experience_editor_enabled_short" : "experience_editor_enabled"
              : isMobile ? "experience_editor_disabled_short" : "experience_editor_disabled",
          )}
        </span>
        <Toggle
          checked={enabled}
          onChange={onToggleEnabled}
        />

        {/* Save-state text is desktop-only: on mobile the state is conveyed by
            the SaveButton's visual state. */}
        <span
          className={cn("shrink-0 max-md:hidden font-ui text-[12px]", draftSaveState === "error" ? "text-danger" : "text-t3")}
          title={draftError ?? undefined}
        >
          {draftSaveState === "error" ? t("retry") : draftDirty ? t("unsaved_changes") : t("saved_state")}
        </span>
        <SaveButton
          icon={isMobile ? <Ic.floppy /> : undefined}
          dirty={draftDirty}
          saveState={draftSaveState}
          resetKey={resetKey}
          onClick={onSave}
          label={draftSaveState === "error" ? t("retry") : t("save")}
        />

        <CustomTooltip content={t("delete_script_confirm")}>
          <button
            type="button"
            aria-label={t("delete_script_confirm")}
            className="flex h-8 w-8 max-md:h-9 max-md:w-9 shrink-0 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2"
            onClick={onDelete}
          >
            <Ic.del />
          </button>
        </CustomTooltip>
      </div>
    </>
  );
}
