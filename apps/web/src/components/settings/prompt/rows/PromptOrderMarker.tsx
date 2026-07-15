/** Built-in slot marker card (worldInfoBefore/After, persona, character fields,
 *  scenario, dialogueExamples) — read-only position, toggle-only enable. */
import { cn } from "../../../../lib/cn.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { DragHandle } from "../drag-handle.js";

export function PromptOrderMarker({ identifier, label, kind, enabled = true, onToggle, tooltip }: {
  identifier: string;
  label: string;
  kind: "builtIn" | "marker" | "chat";
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  tooltip?: string;
}) {
  return (
    <div className={cn(
      "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 font-ui text-[12px] transition-colors",
      !enabled && "opacity-55",
      kind === "chat" ? "border-accent/35 bg-accent/10 text-accent-t" :
      kind === "marker" ? "border-border2 text-t4" :
      "border-border bg-s2/70 text-t2",
    )}>
      <DragHandle />
      <CustomTooltip content={enabled ? "Enabled" : "Disabled"}>
        <button
          type="button"
          className={cn(
            "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[13px] transition-colors",
            enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
          )}
          onClick={() => onToggle?.(identifier)}
        >
          {enabled ? "●" : "○"}
        </button>
      </CustomTooltip>
      <span className="min-w-0 flex-1 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip">
        {tooltip ? (
          <CustomTooltip content={tooltip}>
            <span className="cursor-help border-b border-dotted border-current pb-0.5">{label}</span>
          </CustomTooltip>
        ) : (
          label
        )}
      </span>
      <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">
        {kind === "chat" ? "marker" : kind === "marker" ? "slot" : "read-only"}
      </span>
    </div>
  );
}
