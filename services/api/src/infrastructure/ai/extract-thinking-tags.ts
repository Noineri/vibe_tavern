/**
 * Re-export from @vibe-tavern/domain for backward compatibility.
 *
 * The canonical implementation lives in the domain package so it can be
 * used by both the API layer (streaming/nonstreaming generation) and the
 * DB layer (message edit extraction) without circular dependencies.
 */
export { extractThinkingTags } from "@vibe-tavern/domain";
