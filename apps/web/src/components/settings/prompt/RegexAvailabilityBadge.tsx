import type { RegexProfileAvailability, RegexRuleAvailability } from "../../../lib/regex-availability.js";
import { useT } from "../../../i18n/context.js";

export interface RegexAvailabilityBadgeProps {
  availability: RegexProfileAvailability | RegexRuleAvailability;
}

/** Textual availability summary for a Regex Rule or Profile row. */
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

  return (
    <span
      aria-label={label}
      className="shrink-0 whitespace-nowrap rounded bg-s2 px-1.5 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
    >
      {label}
    </span>
  );
}
