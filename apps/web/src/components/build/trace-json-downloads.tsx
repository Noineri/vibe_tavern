import type { ProviderResponseTrace } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";

interface TraceJsonDownloadsProps {
  traceId: string;
  requestPayload: Record<string, unknown>;
  providerResponse?: ProviderResponseTrace;
  mobile?: boolean;
}

function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Separate downloads for the exact outbound payload and captured provider response. */
export function TraceJsonDownloads({
  traceId,
  requestPayload,
  providerResponse,
  mobile = false,
}: TraceJsonDownloadsProps) {
  const { t } = useT();
  const buttonClass = cn(
    "cursor-pointer rounded-md bg-s3 px-4 py-2 font-ui text-xs font-medium text-t2 transition-colors hover:bg-border2 hover:text-t1",
    mobile && "h-9 w-full active:bg-border2",
  );

  return (
    <div className={cn("flex gap-2", mobile && "flex-col gap-3")}>
      <button
        type="button"
        className={buttonClass}
        onClick={() => downloadJson(requestPayload, `prompt-request-${traceId}.json`)}
      >
        {t("trace_json_request")}
      </button>
      {providerResponse && (
        <button
          type="button"
          className={buttonClass}
          onClick={() => downloadJson(providerResponse, `model-response-${traceId}.json`)}
        >
          {t("trace_json_response")}
        </button>
      )}
    </div>
  );
}
