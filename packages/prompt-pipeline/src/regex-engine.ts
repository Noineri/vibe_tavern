/**
 * Pure SillyTavern-parity regex engine (REGEX_EXTENSION_PLAN, RX-3).
 *
 * Compiles and runs named regex presets (`RegexPreset`, domain RX-1) against
 * text with ST's semantics: `/pattern/flags` notation, `{{match}}` +
 * `$1`..`$9` + `$<name>` replacement references, Trim-Out strings, macro
 * substitution into the find pattern (ST `substituteRegex`: NONE/RAW/ESCAPED),
 * and placement + depth filtering.
 *
 * The module is PURE (no I/O, no store access). Macro resolution is injected
 * via {@link RegexMacroSource} — the caller (orchestrator / assembly) binds
 * the shared `MacroEngine`; without it the engine behaves as NONE and stays
 * usable standalone.
 *
 * A broken imported script must never crash the chat path: invalid patterns
 * surface as `null` from {@link compileRegexScript} and are skipped silently
 * by {@link applyRegexLayer}.
 */

import { REGEX_PLACEMENT, REGEX_SUBSTITUTE, type RegexPlacement, type RegexPreset } from "@vibe-tavern/domain";

// ─── Literal escaping (shared) ────────────────────────────────────────────────

/** Regex metacharacters — everything that changes meaning inside a pattern. */
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape a literal string so it matches verbatim inside a regex pattern.
 * Canonical home is this pure engine (RX-13): the orchestrator hook service
 * (RX-8) re-exports it, and the client display seam imports it from here.
 */
export function escapeRegexLiteral(value: string): string {
  return value.replace(REGEX_METACHARS, "\\$&");
}

// ─── Find-pattern parsing ──────────────────────────────────────────────────────

/** Result of parsing ST's `/pattern/flags` find notation. */
export interface ParsedFindRegex {
  pattern: string;
  flags: string;
}

// `/pattern/flags` — flags restricted to the standard JS alphabet; the pattern
// itself may contain slashes (greedy body + trailing segment split).
const DELIMITED_FIND = /^\/(.+)\/([dgimsuvy]*)$/;

/**
 * Deduplicate flags (ST exports may repeat them, e.g. `/a/igg`) preserving the
 * author's order, and always include `g` — presets apply with replace-all
 * semantics regardless of how they were authored.
 */
function normalizeFlags(raw: string): string {
  const seen: string[] = [];
  for (const flag of raw) {
    if (!seen.includes(flag)) seen.push(flag);
  }
  if (!seen.includes("g")) seen.push("g");
  return seen.join("");
}

/**
 * Parse ST's `/pattern/flags` notation. Input without the delimiter form is
 * treated as the entire pattern with default flags `"g"`. This never throws —
 * an unparsable PATTERN is handled later at compile time (see
 * {@link compileRegexScript}), so broken imports degrade to "skipped script",
 * not a crash.
 */
export function parseFindRegex(findRegex: string): ParsedFindRegex {
  const match = DELIMITED_FIND.exec(findRegex);
  if (!match) return { pattern: findRegex, flags: normalizeFlags("") };
  return { pattern: match[1], flags: normalizeFlags(match[2]) };
}

// ─── Macro seam (dependency-injected; keeps this module pure) ──────────────────

/**
 * Injected macro resolver for `substituteRegex` RAW/ESCAPED modes. The caller
 * binds the shared MacroEngine; `resolveEscaped` must return macro values
 * escaped for literal matching INSIDE a regular expression (parentheses,
 * brackets, quantifiers, …).
 */
export interface RegexMacroSource {
  resolve(text: string): string;
  resolveEscaped(text: string): string;
}

/** Macro token shape (`{{name}}`, `{{name::arg}}`) — matches the MacroEngine's
 *  own token scan; single-brace text is left alone. */
const MACRO_TOKEN = /\{\{[^{}]+\}\}/g;

/**
 * Build a {@link RegexMacroSource} from any plain text→text macro resolver
 * (server: `MacroEngine.resolve` bound to a variable context; client:
 * `replaceUiMacros` bound to the snapshot macro context). `resolveEscaped`
 * resolves each macro TOKEN separately and escapes the VALUE via
 * {@link escapeRegexLiteral} — the same per-value escaping semantics as the
 * RX-8 hook service, so a name like "A(B)" matches literally inside a find
 * pattern while the pattern's own regex syntax stays live.
 */
export function createValueEscapingMacroSource(resolve: (text: string) => string): RegexMacroSource {
  return {
    resolve,
    resolveEscaped: (text) => text.replace(MACRO_TOKEN, (token) => escapeRegexLiteral(resolve(token))),
  };
}

// ─── Compilation ────────────────────────────────────────────────────────────────

/** A preset whose find pattern compiled successfully, ready to transform text. */
export interface CompiledRegexScript {
  preset: RegexPreset;
  /** Apply ST find/replace semantics to the input text (replace-all). */
  run(text: string): string;
}

/**
 * Compile a preset into a runnable script. Returns `null` when the (possibly
 * macro-substituted) pattern fails to compile — the caller skips the script;
 * broken shared content never crashes generation.
 *
 * Macro substitution into the find pattern follows ST's `substituteRegex`:
 * NONE = none; RAW = `macroSource.resolve`; ESCAPED =
 * `macroSource.resolveEscaped`. Without a `macroSource`, every mode behaves as
 * NONE (the engine stays usable standalone).
 */
export function compileRegexScript(preset: RegexPreset, macroSource?: RegexMacroSource): CompiledRegexScript | null {
  const parsed = parseFindRegex(preset.findRegex);
  let pattern = parsed.pattern;
  if (macroSource != null && preset.substituteRegex === REGEX_SUBSTITUTE.Raw) {
    pattern = macroSource.resolve(pattern);
  } else if (macroSource != null && preset.substituteRegex === REGEX_SUBSTITUTE.Escaped) {
    pattern = macroSource.resolveEscaped(pattern);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, parsed.flags);
  } catch {
    return null;
  }

  // ST parity (R-14): `filterString` runs `substituteParams` on each trim
  // string before stripping (plain, unescaped — the RAW/plain resolution),
  // regardless of the find-pattern substituteRegex mode. Without a
  // macroSource the engine stays standalone and trims are used literally.
  const trims =
    macroSource != null ? preset.trimStrings.map((trim) => macroSource.resolve(trim)) : preset.trimStrings;

  return { preset, run: (text: string) => runCompiled(regex, preset, trims, text) };
}

/**
 * Expand the replace template for ONE match: `{{match}}` → the TRIMMED full
 * match text, `$n` → numbered capture (unmatched capture → "", nonexistent →
 * literal), `$<name>` → named capture (same rules). Returned strings are used
 * literally by the replace-callback, so `$` characters inside matched content
 * can never be re-interpreted as capture references.
 *
 * ST parity (R-14): the `g` flag makes EVERY reference expand, not just the
 * first; every referenced value (full match, numbered, named) passes through
 * the Trim-Out filter — ST `runRegexScript` calls `filterString` on each
 * referenced match (`replaceAll(/\$(\d+)|\$<([^>]+)>/g, ...)`).
 */
const REPLACE_TEMPLATE_TOKEN = /\{\{match\}\}|\$(\d{1,2})|\$<([^<>]+)>/gi;

/** Strip every non-empty trim string from `text` (ST `filterString`). */
function trimText(text: string, trims: readonly string[]): string {
  let out = text;
  // Guard "" — replaceAll("") would splice separators everywhere. Also guards
  // trims that macro-resolved to "".
  for (const trim of trims) {
    if (trim !== "") out = out.replaceAll(trim, "");
  }
  return out;
}

function expandReplaceTemplate(
  template: string,
  fullMatch: string,
  captures: ReadonlyArray<string | undefined>,
  named: Readonly<Record<string, string | undefined>>,
  trims: readonly string[],
): string {
  return template.replace(REPLACE_TEMPLATE_TOKEN, (token, numStr: string | undefined, name: string | undefined) => {
    if (numStr !== undefined) {
      const index = Number(numStr);
      // Beyond the actual capture count stays literal (native `$99` parity);
      // within it, an unmatched optional capture expands to "" (then the trim
      // filter is a no-op).
      if (index >= 1 && index <= captures.length) return trimText(captures[index - 1] ?? "", trims);
      return token;
    }
    if (name !== undefined) {
      if (Object.hasOwn(named, name)) return trimText(named[name] ?? "", trims);
      return token;
    }
    // {{match}} — the full match is already trimmed before expansion (ST trims
    // `$0` via filterString too).
    return fullMatch;
  });
}

function runCompiled(regex: RegExp, preset: RegexPreset, trims: readonly string[], text: string): string {
  return text.replace(regex, (full: string, ...rest: unknown[]) => {
    // ST "Trim Out": strip substrings from the full match BEFORE `{{match}}`
    // expansion — and from every capture-group reference at expansion time.
    const trimmed = trimText(full, trims);

    // Callback args: (match, p1..pk, offset, string[, groups]). Captures end
    // where the numeric `offset` begins; the named-groups object, when the
    // pattern has named groups, rides last.
    const offsetIndex = rest.findIndex((arg) => typeof arg === "number");
    const captures = offsetIndex === -1 ? [] : (rest.slice(0, offsetIndex) as Array<string | undefined>);
    const last = rest[rest.length - 1];
    const named =
      typeof last === "object" && last !== null ? (last as Record<string, string | undefined>) : {};

    return expandReplaceTemplate(preset.replaceString, trimmed, captures, named, trims);
  });
}

// ─── Selection helpers ────────────────────────────────────────────────────────

/**
 * Filter presets for one application site: drops disabled presets, keeps only
 * those registered for `opts.placement`, and — when `opts.depth` is given —
 * keeps only those whose `[minDepth, maxDepth]` window covers it (`null`
 * bounds are unlimited; ST counts depth 0 as the last message). SLASH_COMMAND
 * is never requested by VT call sites, so it simply never passes through here.
 */
export function filterRegexPresets(
  presets: RegexPreset[],
  opts: { placement: RegexPlacement; depth?: number },
): RegexPreset[] {
  return presets.filter((preset) => {
    if (preset.disabled) return false;
    if (!preset.placement.includes(opts.placement)) return false;
    if (opts.depth !== undefined) {
      if (preset.minDepth !== null && opts.depth < preset.minDepth) return false;
      if (preset.maxDepth !== null && opts.depth > preset.maxDepth) return false;
    }
    return true;
  });
}

/**
 * Convenience: apply presets IN ARRAY ORDER (the caller resolves and sorts by
 * `sortOrder`). Un-compilable presets are skipped silently — see
 * {@link compileRegexScript}.
 */
export function applyRegexLayer(text: string, presets: RegexPreset[], macroSource?: RegexMacroSource): string {
  let result = text;
  for (const preset of presets) {
    const compiled = compileRegexScript(preset, macroSource);
    if (compiled == null) continue;
    result = compiled.run(result);
  }
  return result;
}

// ─── Chat-history transform (RX-13 assembled-prompt seam) ─────────────────────

/** Minimal message shape the history transform reads. */
export interface RegexHistoryMessage {
  role: string;
  content: string;
}

/**
 * Apply the ASSEMBLED-PROMPT regex seam (RX-13) to a chat-history window.
 *
 * This is the prompt-side half of the non-persist apply-targets. The MODE
 * filter is authoritative here (the caller hands the full active set):
 * only prompt-affecting presets (ST `promptOnly` — the "prompt" and
 * "display+prompt" apply-targets) transform history. Persist-mode presets
 * already applied at generation time (RX-5/8) and are excluded so they never
 * double-apply; display-only presets belong to the client render seam.
 *
 * Placement maps to the message role: USER_INPUT (1) transforms user
 * messages, AI_OUTPUT (2) transforms assistant messages; system/tool
 * messages carry no placement and are never transformed. Depth counts from
 * the END of the window (ST: depth 0 = last message). Presets run in array
 * order — the caller resolves and sorts by `sortOrder`.
 *
 * Pure and non-destructive: returns the INPUT array (same reference) when
 * nothing applies; otherwise a new array where only transformed messages are
 * new objects. Never throws — broken patterns are skipped by
 * {@link compileRegexScript}.
 */
export function applyRegexToChatHistory<T extends RegexHistoryMessage>(
  messages: T[],
  presets: RegexPreset[],
  macroSource?: RegexMacroSource,
): T[] {
  if (messages.length === 0) return messages;
  const promptPresets = presets.filter((preset) => preset.promptOnly && !preset.disabled);
  if (promptPresets.length === 0) return messages;

  let result: T[] | null = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const placement =
      message.role === "user"
        ? REGEX_PLACEMENT.UserInput
        : message.role === "assistant"
          ? REGEX_PLACEMENT.AiOutput
          : null;
    if (placement === null) continue;
    const depth = messages.length - 1 - index;
    const applicable = filterRegexPresets(promptPresets, { placement, depth });
    if (applicable.length === 0) continue;
    const transformed = applyRegexLayer(message.content, applicable, macroSource);
    if (transformed === message.content) continue;
    if (result === null) result = messages.slice();
    result[index] = { ...message, content: transformed };
  }
  return result ?? messages;
}
