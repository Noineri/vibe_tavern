import { getGatewayBaseUrl } from "../api/client.js";
import { getMobileToken } from "../api/client.js";

/**
 * Temporary debug logger — writes to logs/send-debug.log via /api/debug/send-log.
 * Remove all calls to this once the vision-model hydration bug is fixed.
 */
export function devLog(event: string, data: Record<string, unknown> = {}): void {
  void fetch(`${getGatewayBaseUrl()}/api/debug/send-log`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getMobileToken() ? { Authorization: `Bearer ${getMobileToken()}` } : {}),
    },
    body: JSON.stringify({ event, ...data, clientTs: new Date().toISOString() }),
  }).catch(() => undefined);
}
