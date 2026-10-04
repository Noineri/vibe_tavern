import type { ActivationInput } from "./lore-activation-engine.js";

interface ScanEntry {
  lorebookId: string;
  scanDepthOverride: number | null;
  matchSources: string[];
  includeNames: boolean;
}

export function entryBaseDepth(entry: ScanEntry, scanDepths: Map<string, number>): number {
  return entry.scanDepthOverride ?? (scanDepths.get(entry.lorebookId) ?? 2);
}

const SCAN_SENTINEL = "\x01";
const SCAN_JOINER = `\n${SCAN_SENTINEL}`;

export function buildLoreScanText(
  entry: ScanEntry,
  messages: ActivationInput["messages"],
  scanDepths: Map<string, number>,
  input: ActivationInput,
  depthSkew = 0,
  recurseBuffer: readonly string[] = [],
): string {
  const scanDepth = entryBaseDepth(entry, scanDepths) + depthSkew;
  // Array#slice(-0) is equivalent to slice(0), which scans the full chat.
  // ST's buffer has no chat-message units at depth 0 (world-info.js:279-297).
  const effectiveMessages = scanDepth === 0 ? [] : messages.slice(-scanDepth);
  const sources = entry.matchSources.length > 0 ? entry.matchSources : ["chat_messages"];

  // Port of ST's WorldInfoBuffer.get construction (world-info.js:278-325):
  // start with a sentinel, then separate every scanned message, selected
  // global source, and recursion-buffer unit with `\n\x01`. `\x01` is not
  // matched by JS `\s`, so regex keys cannot cross those seams. ST's message
  // text itself is assembled by chatForWI (public/script.js:4563-4572), which
  // supplies the optional speaker prefix below.
  let result = SCAN_SENTINEL;
  if (sources.includes("chat_messages")) {
    result += effectiveMessages.map(m =>
      entry.includeNames && m.name ? `${m.name}: ${m.content}` : m.content,
    ).join(SCAN_JOINER);
  }
  if (sources.includes("persona_desc") && input.personaDescription) {
    result += SCAN_JOINER + input.personaDescription;
  }
  if (sources.includes("character_desc") && input.characterDescription) {
    result += SCAN_JOINER + input.characterDescription;
  }
  if (sources.includes("character_personality") && input.characterPersonality) {
    result += SCAN_JOINER + input.characterPersonality;
  }
  if (sources.includes("character_note") && input.characterNote) {
    result += SCAN_JOINER + input.characterNote;
  }
  if (sources.includes("character_alt_greetings") && input.characterAltGreetings) {
    result += SCAN_JOINER + input.characterAltGreetings;
  }
  if (sources.includes("scenario") && input.scenario) {
    result += SCAN_JOINER + input.scenario;
  }
  if (sources.includes("creator_notes") && input.creatorNotes) {
    result += SCAN_JOINER + input.creatorNotes;
  }
  // ST appends prompt injections after its selected global sources
  // (world-info.js:317-320). ST gates Author's Note and the character depth
  // prompt with allowWIScan, default false (authors-note.js:295-305, 375-392;
  // script.js:4415-4430). VT has no global switch: selecting a source chip is
  // the per-entry, default-off gate. Persona remains separately selectable and
  // has no such global gate, matching ST's hardcoded scan=true at depth
  // (script.js:3155-3166).
  if (sources.includes("authors_note") && input.authorsNote) {
    result += SCAN_JOINER + input.authorsNote;
  }
  if (sources.includes("summaries") && input.summaries?.length) {
    result += SCAN_JOINER + input.summaries.join(SCAN_JOINER);
  }
  if (sources.includes("chat_dynamic_prompt") && input.chatDynamicPrompt) {
    result += SCAN_JOINER + input.chatDynamicPrompt;
  }
  if (sources.includes("chat_summary") && input.chatSummary) {
    result += SCAN_JOINER + input.chatSummary;
  }
  // The quiet prompt is always scanned in ST (`setExtensionPrompt(..., true)`
  // in public/script.js:4564), independently of an entry source chip.
  if (input.quietPrompt) {
    result += SCAN_JOINER + input.quietPrompt;
  }
  if (recurseBuffer.length > 0) {
    result += SCAN_JOINER + recurseBuffer.join(SCAN_JOINER);
  }
  return result;
}
