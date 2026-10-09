/**
 * script-safety-lint tests (SS-5).
 *
 * Pure mapping section pins the `ScriptSafetyFinding[] → Diagnostic[]` contract
 * (severity, 1-based line/column → 0-based offsets, empty input, clamp safety)
 * plus the kind forwarder — the whole point of the helper as the single source
 * between the domain detector and the editors.
 *
 * Editor-wiring section is the repo's cheap DOM pattern (CodeEditor.test.tsx):
 * mount the REAL shared `CodeEditor` with the lint extension, force the
 * debounced linter, and assert diagnostics actually land in the editor state.
 * No bare sleeps — `forceLinting` + `waitFor` flush the linter's microtask.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { useDomEnv } from "../../test/dom-env.js";
import {
  scriptSafetyDiagnostics,
  scriptSafetyLint,
  scriptSafetyLintSource,
  scriptSafetyRuleI18nKey,
} from "./script-safety-lint.js";
import { SCRIPT_KIND } from "@vibe-tavern/domain";
import type { ScriptSafetyFinding } from "@vibe-tavern/domain/script-safety";

useDomEnv();
const { act, render, waitFor } = await import("@testing-library/react");

let EditorView: typeof import("@codemirror/view").EditorView;
let CodeEditor: typeof import("../components/shared/CodeEditor.js").CodeEditor;

beforeAll(async () => {
  ({ EditorView } = await import("@codemirror/view"));
  ({ CodeEditor } = await import("../components/shared/CodeEditor.js"));
});

function getView(container: HTMLElement): import("@codemirror/view").EditorView {
  const dom = container.querySelector(".cm-editor");
  if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not mounted");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("EditorView not found");
  return view;
}

// ─── Pure mapping ────────────────────────────────────────────────────────────

describe("scriptSafetyRuleI18nKey", () => {
  it("maps kebab-case rule ids to underscore i18n keys", () => {
    expect(scriptSafetyRuleI18nKey("escape-constructor-chain")).toBe(
      "script_safety_rule_escape_constructor_chain",
    );
    expect(scriptSafetyRuleI18nKey("out-of-surface-global")).toBe(
      "script_safety_rule_out_of_surface_global",
    );
    expect(scriptSafetyRuleI18nKey("unsafe-eval")).toBe("script_safety_rule_unsafe_eval");
  });
});

describe("scriptSafetyDiagnostics — finding → diagnostic mapping", () => {
  // Three lines, each 3 chars: "aaa\nbbb\nccc" (lengths 3/3/3).
  const doc = EditorState.create({ doc: "aaa\nbbb\nccc" }).doc;

  it("maps severity info/warning/critical to info/warning/error", () => {
    const findings: readonly ScriptSafetyFinding[] = [
      { ruleId: "masking-encoded-literal", severity: "info", line: 1, col: 1 },
      { ruleId: "out-of-surface-global", severity: "warning", line: 2, col: 1 },
      { ruleId: "unsafe-eval", severity: "critical", line: 3, col: 1 },
    ];
    const diagnostics = scriptSafetyDiagnostics(findings, doc, (key) => key);
    expect(diagnostics.map((d) => d.severity)).toEqual(["info", "warning", "error"]);
  });

  it("converts 1-based line/col to 0-based absolute offsets (line end highlight)", () => {
    const diagnostics = scriptSafetyDiagnostics(
      [{ ruleId: "unsafe-eval", severity: "critical", line: 2, col: 2 }],
      doc,
      (key) => key,
    );
    expect(diagnostics).toHaveLength(1);
    // "bbb" spans offsets 4..7; col 2 (1-based) → offset 5.
    expect(diagnostics[0]!.from).toBe(5);
    expect(diagnostics[0]!.to).toBe(7);
  });

  it("defaults a missing column to the start of the line", () => {
    const diagnostics = scriptSafetyDiagnostics(
      [{ ruleId: "masking-invisible-characters", severity: "warning", line: 3 }],
      doc,
      (key) => key,
    );
    expect(diagnostics[0]!.from).toBe(8); // "ccc" line start
    expect(diagnostics[0]!.to).toBe(11);
  });

  it("resolves the message through the provided key resolver", () => {
    const diagnostics = scriptSafetyDiagnostics(
      [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }],
      doc,
      (key) => "MSG:" + key,
    );
    expect(diagnostics[0]!.message).toBe("MSG:script_safety_rule_unsafe_eval");
  });

  it("returns no diagnostics for empty findings", () => {
    expect(scriptSafetyDiagnostics([], doc, (key) => key)).toEqual([]);
  });

  it("clamps an out-of-range line to the last line without throwing", () => {
    const diagnostics = scriptSafetyDiagnostics(
      [{ ruleId: "unsafe-eval", severity: "critical", line: 99, col: 99 }],
      doc,
      (key) => key,
    );
    expect(diagnostics).toHaveLength(1);
    const line = doc.line(3);
    expect(diagnostics[0]!.from).toBe(line.to); // col clamped to line end
    expect(diagnostics[0]!.to).toBe(line.to);
  });
});

describe("scriptSafetyLintSource — kind forwarder", () => {
  it("threads the kind into the detector and runs it over the view doc", async () => {
    const state = EditorState.create({ doc: "eval('x')" });
    // The LintSource only reads `view.state.doc` — satisfy exactly that seam.
    const stubView = { state } as import("@codemirror/view").EditorView;
    // The domain detector is currently kind-invariant at the rule level, so the
    // pin is "the forwarder is parametric and actually runs analysis" (non-empty
    // findings), not per-kind output differences.
    for (const kind of [SCRIPT_KIND.prompt, SCRIPT_KIND.dice, SCRIPT_KIND.interactive]) {
      const source = scriptSafetyLintSource(kind, (key) => key);
      const diagnostics = await source(stubView);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0]!.message).toBe("script_safety_rule_unsafe_eval");
    }
  });
});

// ─── Editor wiring (cheap DOM render) ───────────────────────────────────────

describe("scriptSafetyLint — editor integration", () => {
  it("renders suspicion diagnostics in the shared CodeEditor (non-blocking)", async () => {
    const { container } = render(
      <CodeEditor
        value="eval('hi')"
        onChange={() => {}}
        extensions={scriptSafetyLint(SCRIPT_KIND.interactive, (key) => key)}
      />,
    );
    const view = getView(container);

    act(() => {
      forceLinting(view);
    });

    await waitFor(() => {
      expect(diagnosticCount(view.state)).toBeGreaterThan(0);
    });
  });

  it("renders no diagnostics for a clean document", async () => {
    const { container } = render(
      <CodeEditor
        value="const ok = 1;"
        onChange={() => {}}
        extensions={scriptSafetyLint(SCRIPT_KIND.interactive, (key) => key)}
      />,
    );
    const view = getView(container);

    act(() => {
      forceLinting(view);
    });

    // A clean doc must stay clean after the linter runs (no false positives).
    await waitFor(() => {
      expect(diagnosticCount(view.state)).toBe(0);
    });
  });
});
