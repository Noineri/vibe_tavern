import { useState } from "react";
import type { LoreActivationReason } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";
import { OverflowTooltip } from "../shared/OverflowTooltip.js";

export interface MergedSource {
  name: string;
  reason?: LoreActivationReason;
}

export function LoreReasonBadge({ reason, wrap = false }: { reason: LoreActivationReason; wrap?: boolean }) {
  const { t } = useT();
  let label: string;
  let cls: string;
  switch (reason.kind) {
    case "constant":
      label = t("lore_reason_constant");
      cls = "bg-s3 text-t3";
      break;
    case "sticky":
      label = t("lore_reason_sticky", { since: reason.turnsSinceActivation, window: reason.window });
      cls = "bg-warning-dim text-warning-text";
      break;
    case "delay_fulfilled":
      label = t("lore_reason_delay_fulfilled");
      cls = "bg-warning-dim text-warning-text";
      break;
    case "decorator":
      label = t("lore_reason_decorator");
      cls = "bg-accent-dim text-accent-t";
      break;
    case "key_match": {
      const keys = reason.matchedKeys.join(", ");
      label = reason.scanState === "recursion"
        ? t("lore_reason_key_match_recursion", { keys })
        : t("lore_reason_key_match", { keys });
      cls = "bg-success-dim text-success-text";
      break;
    }
  }
  const badgeClass = cn("min-w-0 rounded px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-4px)] font-medium", cls);
  if (wrap) return <span className={cn(badgeClass, "break-all")}>{label}</span>;
  return <OverflowTooltip text={label} className={badgeClass} />;
}

export function MergedBadge({ sources }: { sources: MergedSource[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="min-w-0 max-w-full font-ui">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="cursor-pointer rounded bg-s3 px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-t3 hover:bg-s2">
        {t("trace_merged_badge", { n: sources.length })}
      </button>
      <AnimatedDisclosure open={open} className="min-w-0 max-w-full">
        <ul className="flex min-w-0 flex-col gap-1 p-1 text-[calc(var(--ui-fs)-3px)] text-t2">
          {sources.map((source, index) => (
            <li key={index} className="flex min-w-0 flex-wrap items-start gap-1">
              <span className="min-w-0 break-all">{source.name}</span>
              {source.reason && <LoreReasonBadge reason={source.reason} wrap />}
            </li>
          ))}
        </ul>
      </AnimatedDisclosure>
    </div>
  );
}
