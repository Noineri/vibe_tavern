import type { Context, TypedResponse } from "hono";
import {
  UnknownAgentKindError,
  AgentKindNotChatOwnedError,
  AgentKindModeNotServedError,
} from "../../domain/agent/agent-kind-registry.js";

/**
 * Map the agent-kind registry's typed errors to the shared 400 `{ error, code }`
 * JSON shape used by the agent route modules (`agent-chat-sessions.ts`,
 * `agent-kind-settings.ts`); any other error (including the adapter's
 * `NotFound` DomainErrors) propagates to the app-level handler unchanged —
 * `null` means "not mine".
 *
 * SC-0c: the return is the precise `c.json` TypedResponse, NOT a bare
 * `Response` — hono's `MergeTypedResponse` maps a bare `Response` member to
 * the untyped fallback, which collapses the whole endpoint's hc `json()`
 * to `unknown` and makes a typed web client impossible without a cast.
 * Annotation-only (erased at runtime — behavior byte-identical).
 */
export function mapAgentKindError(
  c: Context,
  err: unknown,
): TypedResponse<{ error: string; code: string }, 400, "json"> | null {
  if (
    err instanceof UnknownAgentKindError ||
    err instanceof AgentKindNotChatOwnedError ||
    err instanceof AgentKindModeNotServedError
  ) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  return null;
}
