/**
 * ExperienceManagementControls — the mini-app editor's management cluster
 * (name input, trust pill + enable toggle, save-state, save, duplicate,
 * delete), extracted from ExperienceEditor.tsx (SS-7, per the arch-gate's
 * split prescription — this cluster is the part SS-7 modifies: the enable
 * toggle's onToggle now routes through the script-safety warning flow).
 *
 * E6 (MOBILE_DEFECTS_ROUND_2): rendered BOTH in the desktop top bar and as
 * the mobile Edit-tab header — the two surfaces cannot drift. Module-level
 * (not an inner function) so the name input keeps focus across parent
 * re-renders.
 */
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { Toggle } from "../../shared/Toggle.js";
import { TextInput } from "../../shared/text-input.js";
import type { ScriptDraftSaveState } from "../../../stores/script-draft-store.js";

interface ExperienceManagementControlsProps {
  name: string;
  onNameChange: (name: string) => void;
  scriptEnabled: boolean;
  enableLocked: boolean;
  onToggle: (enabled: boolean) => void;
  scriptSaveState: ScriptDraftSaveState;
  scriptDirty: boolean;
  saveError: string | null;
  isMobile: boolean;
  resetKey: string | null;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  canDelete: boolean;
}

export function ExperienceManagementControls({
  name,
  onNameChange,
  scriptEnabled,
  enableLocked,
  onToggle,
  scriptSaveState,
  scriptDirty,
  saveError,
  isMobile,
  resetKey,
  onSave,
  onDuplicate,
  onDelete,
  canDelete,
}: ExperienceManagementControlsProps) {
  const { t } = useT();
  return (
    <>
      <TextInput
        className="min-w-0 max-md:w-auto flex-1 !text-[15px] font-semibold"
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder={t("script_name")}
      />

      {/* The action cluster (pill → delete) is a flat `display:contents`
          group on desktop — a single flex-wrap row with the name — and becomes
          a nested flex row on mobile, so the header composes into exactly two
          rows: [name] / [status, toggle, save(flex-1), duplicate, delete].
          (A plain `flex-1` on the name cannot force this: basis-0 lets the
          shrink-0 pill/toggle squeeze onto row 1 at 40px of leftover width.) */}
      <div className="contents max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-1.5">
        <CustomTooltip content={t("experience_editor_trust_hint")}>
          <span
            className={cn(
              "shrink-0 cursor-help rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase",
              scriptEnabled ? "bg-success-dim text-success-text" : "bg-warning-dim text-warning-text",
            )}
          >
            {/* Mobile: the status pill uses the short form ('on/off')
                below 768px so the whole action cluster fits one row; desktop
                keeps the full word. */}
            {t(
              scriptEnabled
                ? isMobile ? "experience_editor_enabled_short" : "experience_editor_enabled"
                : isMobile ? "experience_editor_disabled_short" : "experience_editor_disabled",
            )}
          </span>
        </CustomTooltip>
        <Toggle
          checked={scriptEnabled}
          disabled={enableLocked}
          onChange={onToggle}
        />

        {/* Save-state text is desktop-only: on mobile the state is conveyed by
            the SaveButton's visual state + the Edit-tab dirty badge (E6). */}
        <span
          className={cn("shrink-0 max-md:hidden font-ui text-[12px]", scriptSaveState === "error" ? "text-danger" : "text-t3")}
          title={saveError ?? undefined}
        >
          {scriptSaveState === "error" ? t("retry") : scriptDirty ? t("unsaved_changes") : t("saved_state")}
        </span>
        <SaveButton
          icon={isMobile ? <Ic.floppy /> : undefined}
          dirty={scriptDirty}
          saveState={scriptSaveState}
          resetKey={resetKey}
          onClick={onSave}
          label={scriptSaveState === "error" ? t("retry") : t("save")}
        />

        {/* The icon pair moves as ONE unit (display:contents on desktop) so
            mobile wrapping never strands a lone icon on its own row. */}
        <div className="contents max-md:flex max-md:gap-1.5">
          <CustomTooltip content={t("experience_editor_duplicate")}>
            <button
              type="button"
              aria-label={t("experience_editor_duplicate")}
              className="flex h-8 w-8 max-md:h-9 max-md:w-9 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={onDuplicate}
            >
              <Ic.copy />
            </button>
          </CustomTooltip>
          {/* IR-90A: delete the experience (its rules script). Reachable only for
              a saved script — an unsaved/local draft is discarded by navigating
              back. */}
          {canDelete && (
            <CustomTooltip content={t("experience_editor_delete")}>
              <button
                type="button"
                aria-label={t("experience_editor_delete")}
                className="flex h-8 w-8 max-md:h-9 max-md:w-9 shrink-0 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2"
                onClick={onDelete}
              >
                <Ic.del />
              </button>
            </CustomTooltip>
          )}
        </div>
      </div>
    </>
  );
}
