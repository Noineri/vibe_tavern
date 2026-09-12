import type { RegexAssistRequest, RegexAssistResponse } from "@vibe-tavern/api-contracts";
import { getGatewayBaseUrl } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

export async function requestRegexAssist(
  body: RegexAssistRequest,
  options?: { signal?: AbortSignal },
): Promise<RegexAssistResponse> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/ai/regex-assist`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<RegexAssistResponse>;
}
