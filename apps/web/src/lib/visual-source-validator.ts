/**
 * Static validator for experience visual sources (UX 2026-08-16 remark 6:
 * «сделать валидатор визуала для копайлота»).
 *
 * A visual source is self-contained HTML/CSS/JS that only executes inside the
 * sandboxed ExperienceFrame (opaque origin, no network — see ExperienceFrame).
 * Nothing validates it before it lands there: a copilot-proposed edit with a
 * broken `<script>` block only fails visually at runtime, far from the review
 * surface where the user accepted it. This validator gives the copilot's visual
 * pane static feedback WITHOUT executing anything:
 *
 *   - every `<script>` block must COMPILE — `new Function(body)` parses the
 *     code in a throwaway function scope and throws SyntaxError on malformed
 *     JS; the function is never invoked, so host-realm execution is impossible
 *     (compile-time only, by construction);
 *   - `<script>` / `<style>` blocks must be CLOSED (an unclosed block is the
 *     classic "model ran out of tokens mid-edit" artifact).
 *
 * Deliberately NOT attempted: HTML well-formedness beyond block closure, CSS
 * syntax, SDK-contract usage, runtime behavior — those belong to the sandbox.
 * The validator reports only what it is sure about; unknown shapes pass.
 */

export interface VisualSourceProblem {
  /** 1-based line of the problem in the FULL visual source, when known. */
  line: number | null;
  message: string;
}

export type VisualSourceValidation =
  | { ok: true }
  | { ok: false; problems: VisualSourceProblem[] };

/** Line number of a 0-based offset, 1-based result. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Find script blocks: opener tags and their (possibly missing) closers. */
const SCRIPT_OPEN = /<script\b[^>]*>/gi;
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const STYLE_OPEN = /<style\b[^>]*>/gi;
const STYLE_CLOSE = /<\/style\s*>/gi;

/**
 * Validate a visual source. Blank input is OK (nothing to check — an empty
 * visual is handled by the resource layer, not by syntax checks).
 */
export function validateVisualSource(source: string): VisualSourceValidation {
  const problems: VisualSourceProblem[] = [];
  if (source.trim() === "") return { ok: true };

  // ── Closed-ness of script/style blocks ────────────────────────────────────
  const scriptOpens = [...source.matchAll(SCRIPT_OPEN)];
  const scriptCloses = [...source.matchAll(/<\/script\s*>/gi)];
  if (scriptOpens.length > scriptCloses.length) {
    const last = scriptOpens[scriptOpens.length - 1]!;
    problems.push({
      line: lineAt(source, last.index ?? 0),
      message: "unclosed <script> block",
    });
  }
  const styleOpens = [...source.matchAll(STYLE_OPEN)];
  const styleCloses = [...source.matchAll(STYLE_CLOSE)];
  if (styleOpens.length > styleCloses.length) {
    const last = styleOpens[styleOpens.length - 1]!;
    problems.push({
      line: lineAt(source, last.index ?? 0),
      message: "unclosed <style> block",
    });
  }

  // ── Script bodies must compile (parse-only; never invoked) ────────────────
  let scriptIndex = 0;
  for (const match of source.matchAll(SCRIPT_BLOCK)) {
    scriptIndex++;
    const body = match[1] ?? "";
    if (body.trim() === "") continue;
    try {
      // Compile-only: builds a function object without running it. Syntax
      // errors throw here; runtime behavior is not our concern.
      void new Function(body);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push({
        line: lineAt(source, match.index ?? 0),
        message: `script block ${scriptIndex}: ${reason}`,
      });
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}
