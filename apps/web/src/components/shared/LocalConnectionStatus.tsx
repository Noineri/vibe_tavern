import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";

/** The four local-server connection states — the ProviderModelSelector
 *  chip's state machine, extracted as the shared canon (IG-CF12a). */
export type LocalConnectionStatus = "unknown" | "checking" | "online" | "offline";

/** Shared local-connection status chip (IG-CF12a): colored dot + state
 *  label + endpoint + an optional mini re-check button, extracted VERBATIM
 *  from ProviderModelSelector (the LLM pane's canon — dot/label/endpoint
 *  classes unchanged; the `mb-2.5` placement margin moved to callers via
 *  `className`, which extends the baked base per FS-8b).
 *
 *  `onRefresh` presence gates the mini button; the caller owns what a
 *  re-check means (LLM pane: refetch models; IG pane: refetch samplers). */
export function LocalConnectionStatusChip({
  status,
  endpoint = "",
  onRefresh,
  refreshing = false,
  refreshLabel = "",
  className,
  testId,
}: {
  status: LocalConnectionStatus;
  endpoint?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Label for the mini re-check button — only consumed when `onRefresh`
   *  is present (TTS's docker chip renders D8's one-shot probe with no
   *  re-check, so it passes neither). */
  refreshLabel?: string;
  className?: string;
  testId?: string;
}) {
  const { t } = useT();
  const style = {
    unknown: { label: t("local_connection_unknown"), className: "border-border2 bg-s2 text-t3", dotClassName: "bg-t4" },
    checking: { label: t("local_connection_checking"), className: "border-accent/30 bg-accent/10 text-accent-t", dotClassName: "bg-accent animate-pulse" },
    online: { label: t("local_connection_online"), className: "border-success/30 bg-success/10 text-success", dotClassName: "bg-success" },
    offline: { label: t("local_connection_offline"), className: "border-danger/30 bg-danger/10 text-danger", dotClassName: "bg-danger" },
  }[status];

  return (
    <div
      data-testid={testId}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-3 py-2 font-ui text-[12px] sm:flex-row sm:items-center sm:justify-between",
        style.className,
        className,
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", style.dotClassName)} />
        <span className="shrink-0 font-medium">{style.label}</span>
        {endpoint && <span className="min-w-0 truncate text-t3">{t("local_connection_endpoint", { url: endpoint })}</span>}
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={() => onRefresh()}
          disabled={refreshing}
          className="self-start rounded border border-current/20 px-2 py-0.5 font-ui text-[11px] font-medium opacity-80 transition-opacity hover:opacity-100 disabled:opacity-50 sm:self-auto"
        >
          {refreshing ? t("testing") : refreshLabel}
        </button>
      )}
    </div>
  );
}
