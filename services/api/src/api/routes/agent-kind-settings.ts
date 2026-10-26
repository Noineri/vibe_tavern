import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";
import { mapAgentKindError } from "./agent-kind-error-map.js";

/**
 * Per-agent-kind model-settings routes (SIDECHAT_PLAN SC-0d):
 *
 *   GET   /api/agent/kinds/:kind/settings
 *   PATCH /api/agent/kinds/:kind/settings
 *
 * The kind's remembered model binding (provider profile + model name) and
 * profile default — a UI DEFAULT only: the copilot stream and compaction keep
 * taking provider/model from each request. Every REGISTERED kind is
 * addressable (script- and chat-owned alike — a kind's remembered default
 * exists regardless of who owns its threads); an unregistered kind is a 400
 * `UNKNOWN_AGENT_KIND` (the registry's typed error, mapped by the shared
 * {@link mapAgentKindError} exactly like the SC-0b lifecycle routes). The GET
 * response on a kind with no row yet is the legacy `ui_settings` copilot pair
 * (the store's read-time fallback — owner decision 2). The PATCH body is
 * `.strict()`: unknown keys are rejected, absent fields keep their stored
 * value, `null` clears one.
 */
export function createAgentKindSettingsRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .get("/api/agent/kinds/:kind/settings", async (c) => {
      const { kind } = c.req.param();
      try {
        return c.json(await runtime.agentKindGetSettings(kind));
      } catch (err) {
        const mapped = mapAgentKindError(c, err);
        if (mapped !== null) return mapped;
        throw err;
      }
    })
    .patch(
      "/api/agent/kinds/:kind/settings",
      zValidator("json", schemas.agentKindSettingsPatchSchema),
      async (c) => {
        const { kind } = c.req.param();
        const body = c.req.valid("json");
        try {
          return c.json(await runtime.agentKindPatchSettings(kind, body));
        } catch (err) {
          const mapped = mapAgentKindError(c, err);
          if (mapped !== null) return mapped;
          throw err;
        }
      },
    );
}
