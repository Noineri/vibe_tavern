/**
 * The Playground's setup check — compares the roster + grants in the launch
 * setup with what the discovered rules declare (the ONE comparison lives in
 * the domain: `compareLaunchContext`) and renders the mismatch warning plus
 * the «reset to the app's defaults» button. Presentational only: the
 * discovery result, the roster, the grants and the reset handler stay in the
 * panel, which passes them as props. The warning renders only when a
 * discovery succeeded (`declaredCapabilities` non-null) AND the comparison
 * finds something. The panel's read-only invariant holds here too: no store
 * is imported or written.
 */
import {
  EXPERIENCE_CAPABILITY,
  compareLaunchContext,
  type ExperienceCapability,
} from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { Ic } from "../../shared/icons.js";
import type { ExperienceParticipant } from "../../../api/types.js";

/** Friendly (non-technical) capability labels for the grant checkboxes (XU-3).
 *  The technical capability id (the wire string) stays reachable via the ⓘ
 *  tooltip next to each label — non-technical authors never see raw ids inline.
 *  The existing `experience_cap_*` keys remain in place for the other surfaces
 *  (InteractiveTester, ExperienceAssignment); these are playground-only. */
export const CAPABILITY_LABEL_KEY = {
  [EXPERIENCE_CAPABILITY.participants]: "experience_cap_friendly_participants",
  [EXPERIENCE_CAPABILITY.deterministicRandom]: "experience_cap_friendly_deterministic_random",
  [EXPERIENCE_CAPABILITY.model]: "experience_cap_friendly_model",
  [EXPERIENCE_CAPABILITY.rpContext]: "experience_cap_friendly_rp_context",
  [EXPERIENCE_CAPABILITY.rpAttachment]: "experience_cap_friendly_rp_attachment",
} as const;

interface PlaygroundSetupResetButtonProps {
  onReset: () => void;
  testId: string;
}

/** The compact action button (canon: AI-generate shape) — shared by the
 *  warning block and the end of the open setup accordion. */
export function PlaygroundSetupResetButton({ onReset, testId }: PlaygroundSetupResetButtonProps) {
  const { t } = useT();

  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
      onClick={onReset}
    >
      <Ic.undo />
      {t("experience_playground_setup_reset")}
    </button>
  );
}

interface PlaygroundSetupCheckProps {
  /** The last SUCCESSFUL discovery's declared capabilities; null = no
   *  successful discovery (failed or skipped) → no comparison, no warning. */
  declaredCapabilities: readonly string[] | null;
  participants: readonly ExperienceParticipant[];
  grants: readonly ExperienceCapability[];
  onReset: () => void;
}

export function PlaygroundSetupCheck({ declaredCapabilities, participants, grants, onReset }: PlaygroundSetupCheckProps) {
  const { t } = useT();

  if (declaredCapabilities === null) return null;
  const comparison = compareLaunchContext(declaredCapabilities, participants, grants);
  const friendlyList = (capabilities: readonly ExperienceCapability[]) =>
    capabilities.map((capability) => t(CAPABILITY_LABEL_KEY[capability])).join(", ");

  const lines: Array<{ key: string; text: string }> = [];
  if (comparison.missingGrants.length > 0) {
    lines.push({
      key: "missing-grants",
      text: t("experience_playground_setup_missing_grants", { list: friendlyList(comparison.missingGrants) }),
    });
  }
  if (comparison.undeclaredGrants.length > 0) {
    lines.push({
      key: "undeclared-grants",
      text: t("experience_playground_setup_undeclared_grants", { list: friendlyList(comparison.undeclaredGrants) }),
    });
  }
  if (comparison.missingModelSeat) {
    lines.push({ key: "missing-model-seat", text: t("experience_playground_setup_missing_model_seat") });
  }
  for (const seat of comparison.modelSeatsWithoutModel) {
    lines.push({
      key: `seat-no-model-${seat.id}`,
      text: t("experience_playground_setup_seat_no_model", { name: seat.label }),
    });
  }
  if (lines.length === 0) return null;

  return (
    <div
      data-testid="playground-setup-mismatch"
      className="mt-3 rounded-md border border-warning bg-warning-dim px-2.5 py-2"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 shrink-0 text-warning-text"><Ic.alert /></span>
        <div className="min-w-0 flex-1 font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-warning-text">
          <p className="m-0 font-medium">{t("experience_playground_setup_mismatch_title")}</p>
          {lines.map((line) => (
            <p key={line.key} data-testid={`playground-setup-mismatch-${line.key}`} className="m-0 mt-1">{line.text}</p>
          ))}
        </div>
      </div>
      <div className="mt-2">
        <PlaygroundSetupResetButton onReset={onReset} testId="playground-setup-mismatch-reset" />
      </div>
    </div>
  );
}
