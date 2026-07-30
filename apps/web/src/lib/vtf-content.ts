import type { VtfCharacterContent } from "@vibe-tavern/db/codecs";
import type { AppCharacter } from "../app-client.js";

/**
 * Map an `AppCharacter` (frontend snapshot type) + the V3 export JSON to a
 * `VtfCharacterContent` (the db storage/exchange type `packMonolith` consumes).
 * Used by PNG export to embed the lossless `vtmd` monolith chunk alongside the
 * ST-compatible `chara`/`ccv3` chunks, and by standalone VTF export.
 * `scenario` → `defaultScenario` is the one field rename; `extensions` is
 * lifted out of the V3 `data.extensions` block. Tolerant: a missing/malformed
 * extensions block yields `{}` rather than throwing.
 *
 * The lorebook (`data.character_book`) is injected into the extensions fence so
 * the VTF monolith carries it losslessly — the ST V3 spec keeps it at
 * `data.character_book`, while the VTF codec keeps it inside `extensions`; the
 * import adapter promotes `extensions.character_book` back out to the dedicated
 * `characterBook` field on the return trip.
 */
export function appCharacterToVtfContent(
  char: AppCharacter,
  v3Export: Record<string, unknown>,
): VtfCharacterContent {
  const dataBlock = v3Export.data;
  const ext = dataBlock && typeof dataBlock === "object" && !Array.isArray(dataBlock)
    ? (dataBlock as Record<string, unknown>).extensions
    : undefined;
  // Fresh copy (don't alias the export's data.extensions), then inject the
  // lorebook so both the PNG `vtmd` chunk and a standalone VTF export carry it.
  const extensions: Record<string, unknown> = ext && typeof ext === "object" && !Array.isArray(ext)
    ? { ...(ext as Record<string, unknown>) }
    : {};
  const book = dataBlock && typeof dataBlock === "object" && !Array.isArray(dataBlock)
    ? (dataBlock as Record<string, unknown>).character_book
    : undefined;
  if (book && typeof book === "object" && !Array.isArray(book)) {
    extensions.character_book = book;
  }
  return {
    name: char.name,
    description: char.description,
    personalitySummary: char.personalitySummary,
    defaultScenario: char.scenario ?? null,
    firstMessage: char.firstMessage ?? "",
    mesExample: char.mesExample,
    mesExampleMode: char.mesExampleMode,
    mesExampleDepth: char.mesExampleDepth,
    alternateGreetings: char.alternateGreetings,
    postHistoryInstructions: char.postHistoryInstructions,
    creatorNotes: char.creatorNotes,
    depthPrompt: char.depthPrompt,
    depthPromptDepth: char.depthPromptDepth,
    depthPromptRole: char.depthPromptRole,
    systemPrompt: char.systemPrompt,
    tags: char.tags,
    extensions,
  };
}
