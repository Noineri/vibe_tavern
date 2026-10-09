import type { RegexProfileAvailability, RegexRuleAvailability } from "../../../lib/regex-availability.js";
import { useT } from "../../../i18n/context.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

export interface RegexAvailabilityBadgeProps {
  availability: RegexProfileAvailability | RegexRuleAvailability;
}

/** Compact availability indicator for a Regex Rule or Profile list row.
 * The full localized status is exposed through its accessible name and tooltip;
 * list-row width is reserved for names, Profile counts, and actions. */
export function RegexAvailabilityBadge({ availability }: RegexAvailabilityBadgeProps) {
  const { t } = useT();
  if (availability.kind === "loading") return null;

  const label = availability.kind === "disabled"
    ? t("promptManager.regex.availabilityDisabled")
    : availability.kind === "unbound"
      ? t("promptManager.regex.availabilityUnbound")
      : availability.kind === "noEnabledRules"
        ? t("promptManager.regex.availabilityNoEnabledRules")
        : "enabledRuleCount" in availability
          ? t("promptManager.regex.availabilityActiveRules", { count: availability.enabledRuleCount })
          : t("promptManager.regex.availabilityActive");
  const dotClass = availability.kind === "disabled"
    ? "bg-t4"
    : availability.kind === "unbound"
      ? "bg-danger"
      : availability.kind === "noEnabledRules"
        ? "bg-warning"
        : "bg-success";

  return (
    <CustomTooltip content={label}>
      <span role="img" aria-label={label} className="flex shrink-0 p-1">
        <span className={`h-[6px] w-[6px] rounded-full ${dotClass}`} />
      </span>
    </CustomTooltip>
  );
}
