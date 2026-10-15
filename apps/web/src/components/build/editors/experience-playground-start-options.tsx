import { EXPERIENCE_CONTROLLER } from "@vibe-tavern/domain";
import type { ExperienceParticipant } from "../../../api/types.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { Ic } from "../../shared/icons.js";
import { TextInput } from "../../shared/text-input.js";
import { Toggle } from "../../shared/Toggle.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

/** Short parens role for the "Who are you playing as" seat dropdown (LB-1 polish):
 *  "Name (short role)". Only this short DropdownSelect uses it; the roster
 *  editor and the setup-summary line keep the full CONTROLLER_LABEL_KEY. */
const SHORT_ROLE_KEY = {
  [EXPERIENCE_CONTROLLER.human]: "experience_playground_role_short_human",
  [EXPERIENCE_CONTROLLER.script]: "experience_playground_role_short_script",
  [EXPERIENCE_CONTROLLER.model]: "experience_playground_role_short_model",
} as const;

interface PlaygroundStartOptionsProps {
  seed: string;
  onSeedChange: (seed: string) => void;
  randomStart: boolean;
  /** Shown (read-only) in the seed field while random start is on. */
  lastUsedSeed: string;
  onRandomStartChange: (checked: boolean) => void;
  humanSeatId: string;
  onHumanSeatChange: (seatId: string) => void;
  participants: readonly ExperienceParticipant[];
}

/**
 * The Playground's start options — seed + random start, and the «Who are you
 * playing as» seat. Moved out of `ExperiencePlayground.tsx` (file-size
 * ratchet) when the pair was aligned (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT
 * step 10, owner ruling 5: the two fields stood at different heights).
 *
 * Both controls start at the same top edge: the label token carries the 6px
 * gap. The seed label sits in a row with its help icon, so it follows the
 * label canon for rows (`!mb-0`, the row carries the gap) and the icon box
 * (flex, 13px) stays shorter than the label line; neither control adds its
 * own top margin (inside the row a stacked margin no longer collapsed, so the
 * seed field sat 6px lower than the dropdown). Both are 34px tall — the
 * TextInput base height is overridden, the DropdownSelect trigger has none.
 */
export function PlaygroundStartOptions({
  seed,
  onSeedChange,
  randomStart,
  lastUsedSeed,
  onRandomStartChange,
  humanSeatId,
  onHumanSeatChange,
  participants,
}: PlaygroundStartOptionsProps) {
  const { t } = useT();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div>
        <div className="mb-1.5 flex items-center gap-1.5">
          <label className={cn(lblCls, "!mb-0")}>{t("experience_playground_seed_label")}</label>
          <CustomTooltip content={t("experience_playground_seed_hint")}>
            <span className="mt-px flex shrink-0 text-t3"><Ic.help /></span>
          </CustomTooltip>
        </div>
        <TextInput
          className={cn("w-full !h-[34px]", randomStart && "opacity-60")}
          value={randomStart ? lastUsedSeed : seed}
          placeholder={t(randomStart ? "experience_playground_seed_random_on" : "experience_tester_seed_placeholder")}
          disabled={randomStart}
          onChange={(e) => onSeedChange(e.target.value)}
        />
        <span className="mt-1.5 flex items-center gap-2">
          <Toggle
            checked={randomStart}
            onChange={onRandomStartChange}
            aria-label={t("experience_playground_random_start")}
          />
          <span className="font-ui text-[12px] text-t2">{t("experience_playground_random_start")}</span>
        </span>
      </div>
      <div>
        <label className={lblCls}>{t("experience_playground_human_seat_label")}</label>
        <DropdownSelect
          value={humanSeatId}
          options={participants.map((p) => ({ id: p.id, label: `${p.label} (${t(SHORT_ROLE_KEY[p.controller])})` }))}
          searchable={false}
          placeholder={t("experience_playground_human_seat_auto")}
          defaultOption={t("experience_playground_human_seat_auto")}
          onChange={onHumanSeatChange}
          className="h-[34px]"
        />
      </div>
    </div>
  );
}
