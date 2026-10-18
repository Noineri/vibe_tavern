import type { AgentToolActivity } from "../stores/agent-turn-store.js";

/**
 * Parse an activity's tool output (AS-8e7a) — the single spelling for the
 * safe-parse the script host's `scriptTestCaption` (AS-8e5) used inline:
 * JSON-parse `activity.summary`, unwrap the persisted `{ toolName, output }`
 * wrapper, and return the output object. Unparseable, empty, or non-object
 * summaries return undefined (the card keeps its raw-summary fallback).
 */
export function parseAgentToolOutput(activity: AgentToolActivity): Record<string, unknown> | undefined {
  if (typeof activity.summary !== "string" || activity.summary === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(activity.summary);
  } catch {
    return undefined;
  }
  if (typeof parsed === "object" && parsed !== null && "output" in parsed && "toolName" in parsed) {
    parsed = (parsed as { output: unknown }).output;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}
