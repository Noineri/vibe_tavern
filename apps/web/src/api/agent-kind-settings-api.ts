/**
 * Per-agent-kind settings client (SIDECHAT_PLAN SC-0e) — the typed twin of the
 * SC-0d routes, following the `agent-chat-api.ts` (SC-0c) pattern:
 *
 *   GET   /api/agent/kinds/:kind/settings
 *   PATCH /api/agent/kinds/:kind/settings
 *
 * The kind's remembered model binding (provider profile + model name) — a UI
 * default only. An unregistered kind is a 400 `UNKNOWN_AGENT_KIND`
 * (surfacing through `unwrapRpc` as a plain error).
 */
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import type {
  AgentKindSettingsPatchRequest,
  AgentKindSettingsWire,
} from "@vibe-tavern/api-contracts";

/** One kind's effective settings — the kind's row, or the legacy `ui_settings`
 *  copilot pair when the kind has no row yet (the store's read-time fallback). */
export async function getAgentKindSettings(kind: string): Promise<AgentKindSettingsWire> {
  const response = await client.api.agent.kinds[":kind"].settings.$get({
    param: { kind },
  });
  return unwrapRpc(response);
}

/** Upsert one kind's settings: only the fields present are written (absent
 *  keeps the stored value, `null` clears it). Returns the updated row. */
export async function patchAgentKindSettings(
  kind: string,
  patch: AgentKindSettingsPatchRequest,
): Promise<AgentKindSettingsWire> {
  const response = await client.api.agent.kinds[":kind"].settings.$patch({
    param: { kind },
    json: patch,
  });
  return unwrapRpc(response);
}
