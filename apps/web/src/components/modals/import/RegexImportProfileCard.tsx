import { useState } from "react";
import type { RegexScriptImportDraft } from "@vibe-tavern/import-export";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Toggle } from "../../shared/Toggle.js";
import { summarizeRegexImportRules } from "../preset-import-flow.js";

/**
 * Shared character-import Regex Profile preview.
 *
 * Desktop and mobile mount this exact card so the source-state summary and the
 * default-off Profile activation choice cannot diverge between import surfaces.
 */
export function RegexImportProfileCard({
  rules,
  enableProfile,
  onEnableProfileChange,
  toggleId,
}: {
  rules: RegexScriptImportDraft[];
  enableProfile: boolean;
  onEnableProfileChange: (enabled: boolean) => void;
  toggleId: string;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const counts = summarizeRegexImportRules(rules);

  return (
    <div data-testid="regex-import-profile-card" className="mt-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{t("regexImport.cardTitle")}</span>
        <span className="rounded bg-accent-dim px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t">
          {t("regexImport.scopeCharacter")}
        </span>
      </div>
      <div className="mt-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
        {t("regexImport.profileSummary", { n: counts.total, enabled: counts.enabled, disabled: counts.disabled })}
      </div>
      <label className="mt-2 flex min-h-11 cursor-pointer items-center justify-between gap-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t2">
        <span>{t("regexImport.enableAfterImport")}</span>
        <Toggle id={toggleId} checked={enableProfile} onChange={onEnableProfileChange} />
      </label>
      <button
        type="button"
        className="mt-1 flex min-h-11 cursor-pointer items-center font-ui text-[calc(var(--ui-fs)-3px)] text-accent hover:underline"
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? t("regexImport.hideRules") : t("regexImport.showRules")}
      </button>
      {expanded && (
        <ul className="mt-1 flex flex-col gap-1">
          {rules.map((rule, index) => (
            <li key={`${rule.name}-${index}`} className="flex items-center gap-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", rule.disabled ? "bg-t4" : "bg-accent")} />
              <span className="truncate">{rule.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
