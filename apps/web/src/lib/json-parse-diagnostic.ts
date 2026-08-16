/**
 * JSON authoring diagnostics for the interactive tester / playground panels
 * (UX 2026-08-16 remark 5: «сделать более подробную диагностику жсон»).
 *
 * The panels' local `parseOptionalJson` copies swallowed the SyntaxError
 * entirely — the user saw a flat "must be valid JSON" label with no reason and
 * no location, and had to find a trailing comma by eye. This helper keeps the
 * same `{ok, present, value}` contract but carries a `diagnostic` string on
 * failure:
 *
 *   - the ENGINE's reason (e.g. JSC "JSON Parse error: Property name must be a
 *     string literal", V8 "Unexpected token ',' …") — engine messages name the
 *     problem but never (JSC) or unreliably (V8) give a position;
 *   - plus, when the light structural scanner below recognizes the anomaly, a
 *     location: line number for an unclosed `{`/`[`, a trailing comma, or a
 *     single-quoted string.
 *
 * The scanner is deliberately NOT a JSON parser — it runs only after
 * JSON.parse already failed, costs one cheap pass, and stays silent when it is
 * not confident (the engine message alone is then the diagnostic). Syntax the
 * scanner does not model (bad numbers, stray tokens…) still gets the engine
 * reason, which is strictly more than the old flat label.
 */

export type OptionalJsonResult =
  | { ok: true; present: boolean; value?: unknown }
  | { ok: false; diagnostic: string };

/** Line number of a character offset, 1-based. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * One-pass structural scan for the common JSON authoring mistakes that carry a
 * useful LOCATION. Returns a human-readable fragment like `unclosed '{' opened
 * at line 3` / `trailing ',' at line 5` / `' at line 2 — JSON strings use double
 * quotes`, or null when nothing recognizable was found.
 */
function scanStructuralAnomaly(source: string): string | null {
  const stack: Array<{ ch: string; offset: number }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '"') {
      // Scan the string; tolerate escapes. An unterminated string means EOF
      // with a pending opener — reported by whichever stack is non-empty (or
      // the string itself when the brackets all closed).
      const stringStart = i;
      // Scan the string; tolerate escapes. An unterminated string is reported
      // at its OPENING QUOTE's line — the EOF line would always blame the last row.
      i++;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === '"') break;
        i++;
      }
      if (i >= source.length) {
        return `unterminated string starting at line ${lineAt(source, stringStart)}`;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      return `' at line ${lineAt(source, i)} — JSON strings use double quotes`;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ ch, offset: i });
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
      continue;
    }
    if (ch === ",") {
      // Trailing comma: ',' then only whitespace before a close bracket.
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j] as string)) j++;
      const next = source[j];
      if (next === "}" || next === "]") {
        return `trailing ',' at line ${lineAt(source, i)}`;
      }
      i++;
      continue;
    }
    i++;
  }
  if (stack.length > 0) {
    const outermost = stack[0]!;
    return `unclosed '${outermost.ch}' opened at line ${lineAt(source, outermost.offset)}`;
  }
  return null;
}

/**
 * Parse an optional JSON text field. Blank input is "absent" (omitted from the
 * request); non-blank invalid JSON fails with a `diagnostic` the caller can
 * append to its error panel.
 */
export function parseOptionalJsonDiagnosed(raw: string): OptionalJsonResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, present: false };
  try {
    return { ok: true, present: true, value: JSON.parse(trimmed) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const anomaly = scanStructuralAnomaly(trimmed);
    return { ok: false, diagnostic: anomaly ? `${reason} (${anomaly})` : reason };
  }
}
