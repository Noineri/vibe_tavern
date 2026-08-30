import type { RegexPreset } from "@vibe-tavern/domain";
import { applyRegexLayer, type RegexMacroSource } from "@vibe-tavern/prompt-pipeline";

export type NarrationRole = "character" | "narrator";

export interface NarrationRoleRun {
  role: NarrationRole;
  text: string;
}

/**
 * Split prepared narration text into ordered role runs.
 * Substrings inside double quotes ("...", “...", «...") are
 * "character"; everything between them is "narrator". Quotes
 * themselves are stripped and do not appear in the output text.
 * Adjacent runs of the same role are merged. Whitespace-only
 * narrator gaps are dropped. Unclosed quotes consume the rest of
 * the input as a trailing character run. Returns [] for empty or
 * whitespace-only input. Pure.
 */
export function splitNarrationRoles(text: string): NarrationRoleRun[] {
  if (!text || text.trim() === "") return [];
  const runs: NarrationRoleRun[] = [];
  function pushRun(role: NarrationRole, t: string): void {
    if (t === "") return;
    if (role === "narrator" && t.trim() === "") return;
    const last = runs[runs.length - 1];
    if (last && last.role === role) {
      last.text += t;
    } else {
      runs.push({ role, text: t });
    }
  }
  let i = 0;
  const len = text.length;
  while (i < len) {
    let openIndex = -1;
    let openChar = "";
    let closeChar = "";
    // Find earliest opening among ", «, "
    const idxDouble = text.indexOf('"', i);
    const idxGuilOpen = text.indexOf("«", i);
    const idxCurlyOpen = text.indexOf("“", i);
    let earliest = -1;
    let earliestChar = "";
    for (const [idx, ch] of [
      [idxDouble, '"'] as const,
      [idxGuilOpen, "«"] as const,
      [idxCurlyOpen, "“"] as const,
    ]) {
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestChar = ch;
      }
    }
    openIndex = earliest;
    openChar = earliestChar;
    if (openIndex === -1) {
      pushRun("narrator", text.slice(i));
      break;
    }
    // Narrator gap before the opening quote
    if (openIndex > i) {
      pushRun("narrator", text.slice(i, openIndex));
    }
    if (openChar === '"') closeChar = '"';
    else if (openChar === "«") closeChar = "»";
    else if (openChar === "“") closeChar = "”";
    const closeIndex = text.indexOf(closeChar, openIndex + 1);
    if (closeIndex === -1) {
      pushRun("character", text.slice(openIndex + 1));
      break;
    }
    pushRun("character", text.slice(openIndex + 1, closeIndex));
    i = closeIndex + 1;
  }
  return runs;
}

/**
 * Map role runs into synthesis-ready chunks where every output piece
 * is ≤ maxLen. Splits long runs on the same boundary discipline as
 * kokoro-text.ts: sentence punctuation (.[!?…] + whitespace) first,
 * then word whitespace, then hard cut. Every piece keeps its source
 * role and the concatenation of all pieces equals the concatenation
 * of all input runs exactly (no characters dropped or duplicated).
 * Pure.
 */
export function chunkRoleRuns(runs: NarrationRoleRun[], maxLen: number): NarrationRoleRun[] {
  if (maxLen <= 0) throw new Error("maxLen must be > 0");
  const out: NarrationRoleRun[] = [];
  for (const run of runs) {
    const t = run.text;
    if (t.length <= maxLen) {
      out.push({ role: run.role, text: t });
      continue;
    }
    let pos = 0;
    while (pos < t.length) {
      const remaining = t.length - pos;
      if (remaining <= maxLen) {
        out.push({ role: run.role, text: t.slice(pos) });
        break;
      }
      const windowEnd = pos + maxLen;
      const windowText = t.slice(pos, windowEnd);
      // Prefer last sentence boundary inside the window: punctuation + whitespace
      let lastSentenceEnd = -1;
      const sentenceRe = /[.!?…]\s+/g;
      let m: RegExpExecArray | null;
      while ((m = sentenceRe.exec(windowText)) !== null) {
        lastSentenceEnd = m.index + m[0].length;
      }
      let cut: number;
      if (lastSentenceEnd > 0) {
        cut = pos + lastSentenceEnd;
      } else {
        // Last whitespace inside window (word boundary), keep it in the first piece
        let lastWs = -1;
        for (let k = windowText.length - 1; k >= 0; k--) {
          if (/\s/.test(windowText[k]!)) {
            lastWs = k;
            break;
          }
        }
        if (lastWs > 0) {
          cut = pos + lastWs + 1;
        } else {
          cut = windowEnd;
        }
      }
      if (cut <= pos) cut = windowEnd;
      out.push({ role: run.role, text: t.slice(pos, cut) });
      pos = cut;
    }
  }
  return out;
}

export interface NarrationTextOptions {
  /** Apply these (already-filtered) regex presets to the raw text first. */
  regexPresets: RegexPreset[];
  macroSource?: RegexMacroSource;
  /** Remove fenced ``` code blocks entirely. Default false. */
  skipCodeblocks: boolean;
  /** Strip HTML tags + decode the common entities. Default false. */
  stripHtml: boolean;
  /** Remove *action* spans (content too); strip **bold** markers keeping content. Default false. */
  stripAsteriskActions: boolean;
  /** Strip asterisk MARKERS only, keeping the span content (`*not*` → `not`, `**bold**` → `bold`). Default false. (D26) */
  stripAsteriskMarkers: boolean;
  /** Keep only quoted dialogue; if NO quotes found, keep the full text (fallback). Default false. */
  quotedOnly: boolean;
}

/** Pre-narration text pipeline (TTS_PLAN TS-10). Stage order is FIXED:
 *  regex layer → stripHtml → skipCodeblocks → stripAsteriskActions → stripAsteriskMarkers → quotedOnly → whitespace collapse + trim.
 *  Returns "" when nothing survives the filters (the orchestrator's
 *  splitParagraphs then yields zero paragraphs → immediate complete).
 *  The final collapse PRESERVES newlines (D10): collapsing all `\s+` erased
 *  every paragraph boundary, so the orchestrator synthesized the whole
 *  message as one unbounded segment. Blank lines survive as `\n\n`
 *  boundaries; CRLF is normalized; spaces/tabs around newlines are trimmed
 *  so `splitParagraphs` never sees padded boundaries. */
export function prepareNarrationText(text: string, options: NarrationTextOptions): string {
  let out = text;

  // 1. regex layer — already-filtered presets, array order.
  if (options.regexPresets.length > 0) {
    out = applyRegexLayer(out, options.regexPresets, options.macroSource);
  }

  // 2. stripHtml
  if (options.stripHtml) {
    out = stripHtml(out);
  }

  // 3. skipCodeblocks — fenced ``` blocks
  if (options.skipCodeblocks) {
    out = stripCodeblocks(out);
  }

  // 4. stripAsteriskActions
  if (options.stripAsteriskActions) {
    out = stripAsteriskActions(out);
  }

  // 4b. stripAsteriskMarkers (D26 "full text" mode: markers gone, words kept)
  if (options.stripAsteriskMarkers) {
    out = stripAsteriskMarkers(out);
  }

  // 5. quotedOnly
  if (options.quotedOnly) {
    out = extractQuotedOnly(out);
  }

  // 6. whitespace collapse + trim — collapse non-newline runs to single
  // spaces, then trim spaces around each newline. Newlines themselves stay:
  // they are the paragraph boundaries splitParagraphs splits on. ` *\n *`
  // contains exactly one \n so it can never eat a blank-line boundary.
  out = out
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();

  return out;
}

/** Convenience factory: every filter off, no regex presets. */
export function defaultNarrationTextOptions(): NarrationTextOptions {
  return {
    regexPresets: [],
    macroSource: undefined,
    skipCodeblocks: false,
    stripHtml: false,
    stripAsteriskActions: false,
    stripAsteriskMarkers: false,
    quotedOnly: false,
  };
}

// ─── Narration text mode (D26) ───────────────────────────────────────────────

/** D26 narration text mode — the ONE user-facing setting that replaces the
 *  v1 hardcoded `stripAsteriskActions: true, quotedOnly: false` (the TS-10
 *  silent scope cut). Neutral naming on purpose: asterisk spans are
 *  mechanically indistinguishable between stage directions and emphasis
 *  (`I'm *not* going`), so nothing here says "actions".
 *  - "full": markers stripped, ALL words spoken (default — safe under any
 *    writing style; emphasis survives).
 *  - "skip-asterisk-spans": v1 behavior — single-asterisk spans dropped with
 *    content (emphasis is dropped too; honestly labeled in the UI).
 *  - "quoted-dialogue": only quoted speech is spoken; quote-less messages
 *    fall back to full text (pipeline-level fallback). */
export type NarrationTextMode = "full" | "skip-asterisk-spans" | "quoted-dialogue";

export const NARRATION_TEXT_MODES = ["full", "skip-asterisk-spans", "quoted-dialogue"] as const;

export function isNarrationTextMode(value: unknown): value is NarrationTextMode {
  return typeof value === "string" && (NARRATION_TEXT_MODES as readonly string[]).includes(value);
}

/** The asterisk/quote filter triple for a mode — spread over the call site's
 *  base options (`regexPresets` / `skipCodeblocks` / `stripHtml` stay at the
 *  call site). Note "quoted-dialogue" uses the MARKERS strip, never the
 *  actions strip: `*not*` inside a quoted line must keep the word "not" —
 *  the meaning-inversion defect is exactly what D26 fixes. */
export function narrationTextOptionsForMode(
  mode: NarrationTextMode,
): Pick<NarrationTextOptions, "stripAsteriskActions" | "stripAsteriskMarkers" | "quotedOnly"> {
  switch (mode) {
    case "full":
      return { stripAsteriskActions: false, stripAsteriskMarkers: true, quotedOnly: false };
    case "skip-asterisk-spans":
      return { stripAsteriskActions: true, stripAsteriskMarkers: false, quotedOnly: false };
    case "quoted-dialogue":
      return { stripAsteriskActions: false, stripAsteriskMarkers: true, quotedOnly: true };
  }
}

function stripHtml(input: string): string {
  // Replace tags with a space so block boundaries don't join words (e.g. <br>).
  let out = input.replace(/<[^>]*>/g, " ");
  // Decode common entities via naive literal replacement — no full table needed.
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return out;
}

function stripCodeblocks(input: string): string {
  // Fenced blocks ``` ... ``` with optional language tag, non-greedy, multiline.
  // Matches ```lang?\n ... ``` including the fences and interior.
  return input.replace(/```[\s\S]*?```/g, " ");
}

function stripAsteriskActions(input: string): string {
  let out = input;
  // **bold** → bold  (strip the paired markers, keep content). Must run before
  // single-asterisk removal so **bold** doesn't become an empty single-span.
  out = out.replace(/\*\*([^*]+?)\*\*/g, "$1");
  // *action* spans with content → removed entirely. Underscore _emphasis_ is
  // intentionally NOT touched in this slice (word-internal underscores make
  // naive removal unsafe).
  out = out.replace(/\*[^*]*?\*/g, "");
  // Unmatched trailing/remaining asterisks → stripped.
  out = out.replace(/\*/g, "");
  return out;
}

function stripAsteriskMarkers(input: string): string {
  let out = input;
  // **bold** → bold
  out = out.replace(/\*\*([^*]+?)\*\*/g, "$1");
  // *span* → span (D26 "full text": the CONTENT survives — `I'm *not* going`
  // must keep "not", unlike the actions strip above).
  out = out.replace(/\*([^*]*?)\*/g, "$1");
  // Unmatched trailing/remaining asterisks → stripped.
  out = out.replace(/\*/g, "");
  return out;
}

function extractQuotedOnly(input: string): string {
  const parts: string[] = [];
  // Quote forms: ASCII "…", «…», curly “…” . Newlines inside are kept here
  // and collapsed later by the final whitespace step.
  const re = /"([^"]*?)"|«([^»]*?)»|“([^”]*?)”/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const inner = match[1] ?? match[2] ?? match[3] ?? "";
    // Keep even empty inner? Join will collapse, but avoid pushing empty that
    // would add extra spaces. Preserve non-empty after trim? Spec: join kept
    // quoted contents. Empty quotes contribute nothing.
    if (inner.length > 0) {
      parts.push(inner);
    }
  }
  if (parts.length === 0) {
    // Fallback — never narrate silence for quote-less messages.
    return input;
  }
  return parts.join(" ");
}
