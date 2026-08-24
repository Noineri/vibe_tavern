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

import { REGEX_SUBSTITUTE, type RegexPlacement, type RegexPreset } from "@vibe-tavern/domain";

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

  return { preset, run: (text: string) => runCompiled(regex, preset, text) };
}

/**
 * Expand the replace template for ONE match: `{{match}}` → the TRIMMED full
 * match text, `$n` → numbered capture (unmatched capture → "", nonexistent →
 * literal), `$<name>` → named capture (same rules). Returned strings are used
 * literally by the replace-callback, so `$` characters inside matched content
 * can never be re-interpreted as capture references.
 */
const REPLACE_TEMPLATE_TOKEN = /\{\{match\}\}|\$(\d{1,2})|\$<([^<>]+)>/i;

function expandReplaceTemplate(
  template: string,
  fullMatch: string,
  captures: ReadonlyArray<string | undefined>,
  named: Readonly<Record<string, string | undefined>>,
): string {
  return template.replace(REPLACE_TEMPLATE_TOKEN, (token, numStr: string | undefined, name: string | undefined) => {
    if (numStr !== undefined) {
      const index = Number(numStr);
      // Beyond the actual capture count stays literal (native `$99` parity);
      // within it, an unmatched optional capture expands to "".
      if (index >= 1 && index <= captures.length) return captures[index - 1] ?? "";
      return token;
    }
    if (name !== undefined) {
      if (Object.hasOwn(named, name)) return named[name] ?? "";
      return token;
    }
    return fullMatch;
  });
}

function runCompiled(regex: RegExp, preset: RegexPreset, text: string): string {
  return text.replace(regex, (full: string, ...rest: unknown[]) => {
    // ST "Trim Out": strip substrings from the full match BEFORE `{{match}}`
    // expansion. Guard "" — replaceAll("") would splice separators everywhere.
    let trimmed = full;
    for (const trim of preset.trimStrings) {
      if (trim !== "") trimmed = trimmed.replaceAll(trim, "");
    }

    // Callback args: (match, p1..pk, offset, string[, groups]). Captures end
    // where the numeric `offset` begins; the named-groups object, when the
    // pattern has named groups, rides last.
    const offsetIndex = rest.findIndex((arg) => typeof arg === "number");
    const captures = offsetIndex === -1 ? [] : (rest.slice(0, offsetIndex) as Array<string | undefined>);
    const last = rest[rest.length - 1];
    const named =
      typeof last === "object" && last !== null ? (last as Record<string, string | undefined>) : {};

    return expandReplaceTemplate(preset.replaceString, trimmed, captures, named);
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
