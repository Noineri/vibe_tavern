import type { GenerationFormat } from "@vibe-tavern/domain";

/**
 * Structural validation of a stored format-template payload.
 * String fields stay strings and malformed payloads degrade to null so callers
 * can fall back to automatic generation formatting.
 */
export function sanitizeGenerationFormatPayload(payload: Record<string, unknown>): GenerationFormat | null {
  const mode = payload["mode"];
  if (mode !== "manual" && mode !== "auto") return null;
  const out: GenerationFormat = { mode };
  for (const key of [
    "inputSequence", "outputSequence", "firstOutputSequence", "lastOutputSequence",
    "systemSequence", "systemSequencePrefix", "systemSequenceSuffix",
    "inputSuffix", "outputSuffix", "systemSuffix", "selection",
  ] as const) {
    const value = payload[key];
    if (typeof value === "string") out[key] = value;
  }
  if (typeof payload.wrap === "boolean") out.wrap = payload.wrap;
  if (payload.namesBehavior === "force" || payload.namesBehavior === "always" || payload.namesBehavior === "never") {
    out.namesBehavior = payload.namesBehavior;
  }
  return out;
}
