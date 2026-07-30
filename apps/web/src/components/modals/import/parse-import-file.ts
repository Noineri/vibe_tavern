/**
 * Pure parse helpers for the character + chat import flows.
 *
 * Extracted from `ImportModals.tsx` (plan unit IF-1) so the desktop modal flow
 * and the future mobile picker flow (IF-5) share one implementation. No React,
 * no toasts — parsing throws, callers handle UI feedback.
 *
 * Avatar URL ownership: `parseCharacterFile` creates the object URL for PNG
 * character cards and returns it on `CharacterPreview.avatarUrl`. The caller
 * owns revocation (revoke on unmount and before replacing the preview) — this
 * module never revokes.
 */
import { extractPngMetadata, parseCharacterMetadata } from "../../../lib/png-reader.js";
import { unpackMonolith, type VtfCharacterContent } from "@vibe-tavern/db/codecs";
import { getT } from "../../../i18n/locale-helpers.js";

export interface CharacterPreview {
  file: File;
  name: string;
  description: string;
  tags: string[];
  avatarUrl: string | null;
}

export interface ChatPreview {
  file: File;
  fileName: string;
  title: string;
  messageCount: number;
  characterName: string;
  messages: Array<{ role: string; name: string; text: string }>;
}

/**
 * Parse a character card file into a `CharacterPreview`. PNG cards have their
 * metadata extracted from the file's tEXt/iTXt chunks; JSON cards are parsed
 * directly. For PNG cards an avatar object URL is created — the caller owns
 * revoking it (see module doc).
 */
export async function parseCharacterFile(file: File): Promise<CharacterPreview> {
  const lowerName = file.name.toLowerCase();
  const isPng = lowerName.endsWith(".png") || file.type === "image/png";
  const raw = await readCardRaw(file);
  const data = normalizeCharacterPreview(raw, file);
  return {
    ...data,
    file,
    avatarUrl: isPng ? URL.createObjectURL(file) : null,
  };
}

/**
 * Read a character-card File into a V3-card-shaped raw object, regardless of
 * container: PNG (`chara`/`ccv3` tEXt), JSON, or a standalone VTF monolith
 * (`.md`/`.markdown`/`.vtmd`, unpacked + reshaped to the V3 `data` block so every
 * downstream consumer — preview normalizers AND `parseCardToDraft` — sees one
 * uniform shape). Shared by every character-import entry point (modal preview,
 * setup wizard, build-editor merge) so no path is left unable to read a VTF
 * monolith. Throws on a malformed file; the caller surfaces the error.
 */
export async function readCardRaw(file: File): Promise<unknown> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".png") || file.type === "image/png") {
    return parseCharacterMetadata(await extractPngMetadata(file));
  }
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || lowerName.endsWith(".vtmd")) {
    return vtfContentToCardRaw(unpackMonolith(await file.text()));
  }
  return JSON.parse(await file.text());
}

/** Reshape a parsed VTF monolith into a V3-card-shaped object (`{ spec, data }`). */
function vtfContentToCardRaw(content: VtfCharacterContent): Record<string, unknown> {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: content.name,
      description: content.description,
      personality: content.personalitySummary,
      scenario: content.defaultScenario,
      first_mes: content.firstMessage,
      mes_example: content.mesExample,
      mes_example_mode: content.mesExampleMode,
      mes_example_depth: content.mesExampleDepth,
      alternate_greetings: content.alternateGreetings,
      post_history_instructions: content.postHistoryInstructions,
      creator_notes: content.creatorNotes,
      depth_prompt: content.depthPrompt,
      depth_prompt_depth: content.depthPromptDepth,
      depth_prompt_role: content.depthPromptRole,
      system_prompt: content.systemPrompt,
      tags: content.tags,
    },
  };
}

/**
 * Parse a SillyTavern `.jsonl` chat export into a `ChatPreview`. Throws on
 * non-`.jsonl` input or when the file contains no parseable messages; the
 * caller is responsible for surfacing the error to the user.
 */
export async function parseChatFile(file: File): Promise<ChatPreview> {
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".jsonl")) throw new Error(getT()("import_invalid_format"));
  return parseChatPreview(file, await file.text());
}

/**
 * Truncate a string to `length` chars, appending "..." when shortened. Used by
 * the chat preview JSX (kept inline in `ImportModals.tsx` for IF-1; moves to
 * `ImportPreview.tsx` in IF-2).
 */
export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

/**
 * First letter (uppercased) of a name, for the avatar fallback glyph. Used by
 * the character preview JSX (kept inline in `ImportModals.tsx` for IF-1; moves
 * to `ImportPreview.tsx` in IF-2).
 */
export function initial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "?";
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function normalizeCharacterPreview(raw: unknown, file: File): Omit<CharacterPreview, "file" | "avatarUrl"> {
  const obj = asRecord(raw);
  const data = asRecord(obj.data) ?? obj;
  const name = stringValue(data.name) || stringValue(obj.name) || stringValue(data.char_name) || stringValue(obj.char_name) || file.name.replace(/\.[^/.]+$/, "");
  const description = stringValue(data.description) || stringValue(data.personality) || stringValue(data.char_persona) || stringValue(obj.description) || "";
  const tags = arrayOfStrings(data.tags) ?? arrayOfStrings(obj.tags) ?? [];
  return { name, description, tags };
}

function parseChatPreview(file: File, text: string): ChatPreview {
  const messages: ChatPreview["messages"] = [];
  let characterName = "Unknown";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    const role = stringValue(record.role) || (record.is_user === true ? "user" : "assistant");
    const name = stringValue(record.name) || stringValue(record.user_name) || (role === "user" ? "User" : stringValue(record.character_name) || "Character");
    const messageText = stringValue(record.mes) || stringValue(record.text) || stringValue(record.content) || "";
    if (role !== "user" && name !== "Character") characterName = name;
    messages.push({ role, name, text: messageText });
  }
  if (messages.length === 0) throw new Error(getT()("import_no_messages"));
  return {
    file,
    fileName: file.name,
    title: file.name.replace(/\.jsonl$/i, ""),
    messageCount: messages.length,
    characterName,
    messages: messages.slice(0, 24),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}
