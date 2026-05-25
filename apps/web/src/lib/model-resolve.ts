/**
 * Resolves a model ID to a human-readable label for display in the UI.
 *
 * Strips provider prefix (e.g., "anthropic/claude-sonnet-4" → "claude-sonnet-4"),
 * returns last segment after "/", or the full string if no "/".
 */
export function resolveModelLabel(modelId: string): string {
  const lastSlash = modelId.lastIndexOf("/");
  return lastSlash >= 0 ? modelId.slice(lastSlash + 1) : modelId;
}
