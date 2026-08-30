/**
 * TTS narration tags (TPE-1, AN-1).
 *
 * A narration annotation is the variant's content with expressive tags
 * inserted. Tags are stored in ONE canonical form — lowercase square
 * brackets, e.g. `[laugh]` — chosen to collide with nothing the narration
 * pipeline already does (stripHtml only touches `<...>`, the asterisk
 * filters only touch `*...*`).
 *
 * Two boundaries use this module:
 * 1. **Preservation (before synthesis):** the narration text pipeline may
 *    drop the words around a tag (quoted-dialogue mode keeps only quoted
 *    speech). Tags are extracted first and re-inserted after the pipeline,
 *    anchored to the next surviving word — so `[laugh]` between two quoted
 *    lines stays between them in every D26 mode.
 * 2. **Dialect mapping (at synthesis):** providers speak different tag
 *    syntaxes. Orpheus: `<laugh>` inline emotion tags. Chatterbox: `[laugh]`
 *    paralinguistic tags (already canonical). Everyone else: no tag support —
 *    the tag is stripped so the voice never reads the word "laugh" aloud.
 *    Both dialect facts are documented upstream (research round, provider
 *    matrix). Dialect resolution is fact-based for openai-compatible hosts:
 *    the profile's MODEL identifies the engine (orpheus-* / chatterbox-*);
 *    everything else strips.
 */

/** The canonical annotation tag set (AN-1 owner spec). */
export const TTS_ANNOTATION_TAGS = [
  "laugh",
  "sigh",
  "chuckle",
  "cough",
  "sniffle",
  "groan",
  "yawn",
  "gasp",
] as const;

export type TtsAnnotationTag = (typeof TTS_ANNOTATION_TAGS)[number];

/** Canonical token for a tag: lowercase square brackets. */
export function ttsTagToken(tag: TtsAnnotationTag): string {
  return `[${tag}]`;
}

const TAGS_PATTERN = new RegExp(
  `\\[(?:${TTS_ANNOTATION_TAGS.join("|")})\\]`,
  "g",
);

/** A tag pulled out of the text, plus its re-insertion anchor: the first
 * word that followed the tag in the ORIGINAL text. `anchor === null` means
 * nothing followed it (trailing tag) — it re-attaches at the end. */
export interface ExtractedTtsTag {
  tag: TtsAnnotationTag;
  anchor: string | null;
}

/** Split text into (tag-free text, ordered tags with anchors). Pure. */
export function extractTtsTags(text: string): { text: string; tags: ExtractedTtsTag[] } {
  const tags: ExtractedTtsTag[] = [];
  const stripped = text.replace(TAGS_PATTERN, (token, offset: number, whole: string) => {
    const tag = token.slice(1, -1) as TtsAnnotationTag;
    const after = whole.slice(offset + token.length);
    const wordMatch = after.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/u);
    tags.push({ tag, anchor: wordMatch?.[0] ?? null });
    return "";
  });
  return { text: stripped, tags };
}

/** Re-insert extracted tags into pipeline output. Each tag lands immediately
 *  before its anchor's FIRST occurrence that starts at/after the previous
 *  insertion point (anchors are searched left-to-right so same-anchor tags
 *  keep their original order); a tag whose anchor was dropped lands at the
 *  end, preserving relative order. Pure. */
export function reinsertTtsTags(text: string, tags: ExtractedTtsTag[]): string {
  if (tags.length === 0) return text;
  let out = text;
  let cursor = 0;
  const trailing: TtsAnnotationTag[] = [];
  for (const { tag, anchor } of tags) {
    let insertAt = -1;
    if (anchor !== null) {
      const from = Math.min(cursor, out.length);
      const idx = out.indexOf(anchor, from);
      if (idx !== -1) insertAt = idx;
    }
    if (insertAt === -1) {
      trailing.push(tag);
      continue;
    }
    out = out.slice(0, insertAt) + ttsTagToken(tag) + " " + out.slice(insertAt);
    cursor = insertAt + ttsTagToken(tag).length + 1 + anchor!.length;
  }
  if (trailing.length > 0) {
    const suffix = trailing.map(ttsTagToken).join(" ");
    out = out.length === 0 ? suffix : `${out} ${suffix}`;
  }
  // Tidy-up touches ONLY literal spaces — never `\s`, which would eat the
  // `\n\n` paragraph boundaries the narration orchestrator splits on.
  return out.replace(/ +([.,!?;:])/g, "$1").replace(/ {2,}/g, " ").replace(/^ +/, "").replace(/ +$/, "");
}

/** Synthesis dialects for narration tags. */
export type TtsTagDialect = "orpheus" | "chatterbox" | "strip";

/** Resolve the dialect for a TTS profile. Fact-based: only openai-compatible
 *  hosts can carry a tag engine, and the model names it (`orpheus-*`,
 * `chatterbox-*` — documented model families). Everything else strips. */
export function ttsTagDialectForProfile(profile: {
  backend: string;
  config?: Record<string, unknown> | null;
}): TtsTagDialect {
  if (profile.backend !== "openai-compatible") return "strip";
  const model = typeof profile.config?.model === "string" ? profile.config.model.toLowerCase() : "";
  if (model.includes("orpheus")) return "orpheus";
  if (model.includes("chatterbox")) return "chatterbox";
  return "strip";
}

/** Map canonical tags in text to the dialect's syntax. `strip` removes the
 *  tokens entirely (they must never be spoken as words). Pure. */
export function mapTtsTagsForDialect(text: string, dialect: TtsTagDialect): string {
  if (dialect === "chatterbox") return text; // canonical == native form
  if (dialect === "orpheus") {
    return text.replace(TAGS_PATTERN, (token) => `<${token.slice(1, -1)}>`);
  }
  // strip — remove the tokens so they are never spoken as words. The
  // tidy-up passes touch ONLY literal spaces (never `\s`, which would eat
  // the `\n\n` paragraph boundaries splitParagraphs splits on).
  return text
    .replace(TAGS_PATTERN, " ")
    .replace(/ {2,}/g, " ")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/^ +/, "")
    .replace(/ +$/, "");
}
