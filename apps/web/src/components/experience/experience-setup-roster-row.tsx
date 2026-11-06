import { CustomTooltip } from "../shared/Tooltip.js";
/**
 * One participant-roster row of ExperienceSetupModal (IR-70F roster capability).
 *
 * Extracted from ExperienceSetupModal.tsx when CNR-8g moved the modal body onto
 * the shared thin ScrollArea lane — the file-size ratchet requires growth to
 * leave the file as an extraction, never as trimming. Fully props-injected
 * (labels via the passed `t`, all mutations via callbacks); behavior is
 * identical to the former inline component.
 */
import { INTERACTIVE_SCHEMA_MAX_LABEL } from "@vibe-tavern/api-contracts";
import { TextInput } from "../shared/text-input.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { Ic } from "../shared/icons.js";
import type { RosterSeat, SeatController, TKey } from "./experience-setup-helpers.js";

export interface RosterRowProps {
  seat: RosterSeat;
  modelGranted: boolean;
  /** Resolved display name for a character-backed seat, or null (report item
   *  6b). Falls back to the raw id when the source was deleted. */
  characterName: string | null;
  controllerOptions: Array<{ value: SeatController; label: string }>;
  providerOptions: Array<{ id: string; label: string }>;
  modelOptions: Array<{ id: string; label: string }>;
  modelsLoading: boolean;
  t: (key: TKey, opts?: Record<string, unknown>) => string;
  onController: (c: SeatController) => void;
  onLabel: (v: string) => void;
  onProvider: (p: string) => void;
  onModel: (m: string) => void;
  onRemove: () => void;
}

export function RosterRow({
  seat, modelGranted, characterName, controllerOptions, providerOptions, modelOptions, modelsLoading, t,
  onController, onLabel, onProvider, onModel, onRemove,
}: RosterRowProps) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-s2 px-2.5 py-2" data-seat-id={seat.id}>
      <div className="flex items-center gap-2">
        <TextInput
          className="min-w-0 flex-1"
          value={seat.label}
          maxLength={INTERACTIVE_SCHEMA_MAX_LABEL}
          placeholder={t("experience_setup_participant_name_placeholder")}
          onChange={(e) => onLabel(e.target.value)}
          aria-label={t("experience_setup_participant_name_placeholder")}
        />
        {seat.characterId !== undefined && (
          <CustomTooltip content={t("experience_setup_seat_character_badge")}><span
            className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-s3 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
            data-testid="experience-setup-seat-character"
          >
            <Ic.user />
            {characterName ?? seat.characterId}
          </span></CustomTooltip>
        )}
        <SegmentedControl
          value={seat.controller}
          options={controllerOptions.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onController(v as SeatController)}
          compact
        />
        <button
          type="button"
          className="shrink-0 rounded p-1 text-t4 hover:bg-s3 hover:text-danger"
          onClick={onRemove}
          aria-label={t("experience_setup_remove_participant")}
          data-testid="experience-setup-remove-seat"
        >
          <Ic.del />
        </button>
      </div>
      {seat.controller === "model" && modelGranted && (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <div className="flex-1">
            <DropdownSelect
              value={seat.providerProfileId ?? ""}
              options={providerOptions}
              placeholder={t("experience_setup_provider_placeholder")}
              onChange={onProvider}
            />
          </div>
          <div className="flex-1">
            <DropdownSelect
              value={seat.modelId ?? ""}
              options={modelOptions}
              placeholder={modelsLoading ? t("experience_setup_loading_models") : t("experience_setup_model_placeholder")}
              onChange={onModel}
              disabled={seat.providerProfileId === undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
