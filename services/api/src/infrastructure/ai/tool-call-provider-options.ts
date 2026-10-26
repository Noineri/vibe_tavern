/**
 * Read-side narrowing for persisted tool-call provider options.
 *
 * `tool_calls_json` stores opaque JSON; the AI SDK's `ToolCallPart.providerOptions`
 * (replay-critical provider metadata — Gemini 3 `thoughtSignature`, aggregator
 * per-call metadata) must be a plain object or absent. This is the single
 * shared authority both history converters (Co-Author chat and the generic
 * agent loop) narrow through — a second hand-written narrowing would be a
 * defect from copy #2.
 */

import type { ToolCallPart } from "ai";

/** Narrow opaque JSON read from tool_calls_json back to AI SDK options:
 *  a stored plain object passes through verbatim; anything else (missing
 *  field, primitive, array) narrows to `undefined` so a replayed tool-call
 *  part never carries a malformed `providerOptions` payload. */
export function asToolProviderOptions(value: unknown): ToolCallPart["providerOptions"] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ToolCallPart["providerOptions"]
    : undefined;
}
