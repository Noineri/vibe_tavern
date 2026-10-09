/**
 * Script safety detector tests (SS-1).
 *
 * Sections:
 *  1. Legit-corpus pin — ZERO findings over every shipped script source: the
 *     9 script templates, the 6 interactive rules starters, both built-in
 *     experience sources. Each item is also proven to PARSE, so the pin can
 *     never pass vacuously on a syntax error (syntax errors yield no findings
 *     by design — the editors' parsers mark those).
 *  2. Positive fixtures per rule family, with line/severity assertions.
 *  3. Absence pins (allowed surface, prose strings) and syntax-error cases.
 *  4. Rule-table invariants (registry severities; every ruleId exercised).
 *
 * Cross-package reads follow the repo's one precedent for reaching apps/web
 * sources from another package: read as TEXT via `Bun.file()` anchored on
 * `import.meta.dir` (`services/api/test/script-templates.test.ts`) — never a
 * module import, because the dependency graph is strictly downward and
 * apps/web already imports this package.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parse } from "acorn";
import {
  ALLOWED_SCRIPT_GLOBALS,
  SCRIPT_SAFETY_RULES,
  analyzeScriptSource,
  type ScriptSafetyFinding,
} from "../src/script-safety.js";
import { BREAKOUT_RULES_SOURCE, CONVERSATION_RULES_SOURCE } from "../src/builtin-experiences.js";
import { SCRIPT_KIND } from "../src/platform-constants.js";

// packages/domain/test → three levels up reach the repo root (same anchoring
// pattern as services/api/test/script-templates.test.ts).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const TEMPLATES_DIR = join(
  REPO_ROOT,
  "apps",
  "web",
  "src",
  "components",
  "build",
  "editors",
  "script-templates",
);
const STARTERS_MODULE_PATH = join(REPO_ROOT, "apps", "web", "src", "lib", "experience-rules-starters.ts");

/**
 * Parse options mirrored from script-safety.ts (kept private there). If the
 * module's options change, this mirror must follow — its only job is proving
 * corpus sources parse, so the zero-finding pin stays non-vacuous.
 */
const PARSE_OPTIONS_MIRROR = {
  ecmaVersion: "latest",
  sourceType: "script",
  locations: true,
  allowReturnOutsideFunction: true,
} as const;

function expectParses(code: string, label: string): void {
  let parsed = false;
  try {
    parse(code, PARSE_OPTIONS_MIRROR);
    parsed = true;
  } catch {
    parsed = false;
  }
  expect(parsed, `${label} must parse (a parse failure would make the pin vacuous)`).toBe(true);
}

function ruleIdsOf(findings: readonly ScriptSafetyFinding[]): string[] {
  return findings.map((finding) => finding.ruleId);
}

function findingOf(findings: readonly ScriptSafetyFinding[], ruleId: string): ScriptSafetyFinding | undefined {
  return findings.find((finding) => finding.ruleId === ruleId);
}

// ─── 1. Legit corpus pin ──────────────────────────────────────────────────────

/** Kinds mirror `templateScriptKind` in script-templates/index.ts: the dice
 *  template is a PROMPT script; fate-die is the only dice-kind template. */
const TEMPLATE_CORPUS: ReadonlyArray<{ file: string; kind: "prompt" | "dice" }> = [
  { file: "advanced-lore.js", kind: SCRIPT_KIND.prompt },
  { file: "dice.js", kind: SCRIPT_KIND.prompt },
  { file: "events.js", kind: SCRIPT_KIND.prompt },
  { file: "fate-die.js", kind: SCRIPT_KIND.dice },
  { file: "hp.js", kind: SCRIPT_KIND.prompt },
  { file: "lorebook.js", kind: SCRIPT_KIND.prompt },
  { file: "memory.js", kind: SCRIPT_KIND.prompt },
  { file: "random.js", kind: SCRIPT_KIND.prompt },
  { file: "relationship.js", kind: SCRIPT_KIND.prompt },
];

/**
 * Lift one embedded rules-starter body out of the apps/web module text. The
 * four unique starters are TS string-array constants there (no raw files
 * exist); the array literal is repo-controlled source, so evaluating it is the
 * exact decode for every quote style and escape. The other two starters
 * re-export the domain built-ins pinned below.
 */
function extractStarterSource(moduleText: string, constName: string): string {
  const marker = `const ${constName} = [`;
  const start = moduleText.indexOf(marker);
  if (start < 0) throw new Error(`${constName}: marker not found — starter module layout drifted`);
  const end = moduleText.indexOf('].join("\\n");', start);
  if (end < 0) throw new Error(`${constName}: terminator not found — starter module layout drifted`);
  const arrayLiteral = moduleText.slice(start + marker.length - 1, end + 1);
  return (new Function(`return ${arrayLiteral}`)() as string[]).join("\n");
}

const UNIQUE_STARTER_CONSTANTS = ["ROUND_SOURCE", "BOARD_SOURCE", "CARD_SOURCE", "BLANK_SOURCE"] as const;

describe("script safety — legit corpus pin (zero findings)", () => {
  it("all 9 script templates parse and produce zero findings", async () => {
    expect(TEMPLATE_CORPUS).toHaveLength(9);
    for (const { file, kind } of TEMPLATE_CORPUS) {
      const code = await Bun.file(join(TEMPLATES_DIR, file)).text();
      expectParses(code, file);
      const findings = analyzeScriptSource(code, kind);
      expect(ruleIdsOf(findings), `${file}: ${JSON.stringify(findings)}`).toEqual([]);
    }
  });

  it("all 6 rules starters: the 4 unique bodies parse clean; the 2 builtin-backed ones are the pinned built-ins", async () => {
    const moduleText = await Bun.file(STARTERS_MODULE_PATH).text();
    // The remaining two starters re-export the built-in sources analyzed in
    // the next test — pin that wiring textually so the 6/6 coverage is proven.
    expect(moduleText).toContain("source: MODEL_CONVERSATION_SOURCE");
    expect(moduleText).toContain("source: BREAKOUT_RULES_SOURCE");
    expect(moduleText).toContain("CONVERSATION_RULES_SOURCE as MODEL_CONVERSATION_SOURCE");
    for (const constName of UNIQUE_STARTER_CONSTANTS) {
      const code = extractStarterSource(moduleText, constName);
      expectParses(code, constName);
      const findings = analyzeScriptSource(code, SCRIPT_KIND.interactive);
      expect(ruleIdsOf(findings), `${constName}: ${JSON.stringify(findings)}`).toEqual([]);
    }
  });

  it("both built-in experience sources parse and produce zero findings", () => {
    const builtins: ReadonlyArray<[string, string]> = [
      ["CONVERSATION_RULES_SOURCE", CONVERSATION_RULES_SOURCE],
      ["BREAKOUT_RULES_SOURCE", BREAKOUT_RULES_SOURCE],
    ];
    expect(builtins).toHaveLength(2);
    for (const [name, code] of builtins) {
      expectParses(code, name);
      const findings = analyzeScriptSource(code, SCRIPT_KIND.interactive);
      expect(ruleIdsOf(findings), `${name}: ${JSON.stringify(findings)}`).toEqual([]);
    }
  });
});

// ─── 2. Positive fixtures per rule family ─────────────────────────────────────

interface Fixture {
  readonly name: string;
  readonly code: string;
  readonly kind?: "prompt" | "dice" | "interactive";
  readonly expected: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  // vm2 category 1 — constructor chains (critical)
  { name: "constructor chain traversal", code: "var a = 1;\nvar f = ({}).constructor.constructor;", expected: ["escape-constructor-chain"] },
  { name: "caught error constructor inside catch", code: "try {\n  run();\n} catch (e) {\n  var x = e.constructor;\n}", expected: ["escape-constructor-chain"] },
  { name: "this.constructor invoked with a string", code: 'this.constructor("return this");', expected: ["escape-constructor-chain"] },
  { name: "bare constructor read (warning tier)", code: "var t = x.constructor;", expected: ["escape-constructor-access"] },
  // vm2 category 2 — prototype manipulation (critical)
  { name: "__proto__ assignment", code: "var o = {};\no.__proto__ = payload;", expected: ["escape-proto-access"] },
  { name: "computed __proto__ access", code: 'o["__proto__"] = payload;', expected: ["escape-proto-access"] },
  { name: "__defineGetter__", code: 'o.__defineGetter__("x", fn);', expected: ["escape-proto-access"] },
  { name: "Object.setPrototypeOf", code: "Object.setPrototypeOf(a, b);", expected: ["escape-proto-access"] },
  { name: "defineProperty on a prototype", code: 'Object.defineProperty(Array.prototype, "x", { value: 1 });', expected: ["escape-prototype-pollution"] },
  // vm2 categories 3/18 — symbol hooks (critical)
  { name: "Symbol.species read (any role) + Promise out-of-surface", code: "var s = Promise[Symbol.species];", expected: ["escape-symbol-hook", "out-of-surface-global"] },
  { name: "Symbol.for cross-realm registry", code: 'var key = Symbol.for("app.key");', expected: ["escape-symbol-hook"] },
  { name: "Symbol.iterator override", code: "x[Symbol.iterator] = function () {};", expected: ["escape-symbol-hook"] },
  { name: "Symbol.toPrimitive override", code: "x[Symbol.toPrimitive] = function () {};", expected: ["escape-symbol-hook"] },
  // vm2 category 5 — caller/callee
  { name: "arguments.callee", code: "function outer() {\n  return arguments.callee;\n}", expected: ["escape-caller-callee"] },
  { name: ".caller / .arguments property reads (warning tier)", code: "var c = fn.caller;\nvar args = fn.arguments;", expected: ["escape-caller-property"] },
  // reflection enumeration (critical)
  { name: "Object.getOwnPropertySymbols", code: "Object.getOwnPropertySymbols(host);", expected: ["escape-reflection-api"] },
  { name: "Object.getOwnPropertyDescriptors", code: "var d = Object.getOwnPropertyDescriptors(host);", expected: ["escape-reflection-api"] },
  { name: "Object.getOwnPropertyNames", code: "Object.getOwnPropertyNames(host);", expected: ["escape-reflection-api"] },
  { name: "Object.getPrototypeOf", code: "var p = Object.getPrototypeOf(host);", expected: ["escape-reflection-api"] },
  { name: "Reflect.ownKeys", code: "var keys = Reflect.ownKeys(host);", expected: ["escape-reflection-api"] },
  { name: "Error.prepareStackTrace assignment", code: "Error.prepareStackTrace = fn;", expected: ["escape-reflection-api"] },
  // Proxy construction (critical)
  { name: "new Proxy", code: "var pr = new Proxy({}, handler);", expected: ["escape-proxy"] },
  { name: "Proxy.revocable", code: "var pair = Proxy.revocable({}, handler);", expected: ["escape-proxy"] },
  // string-to-code execution (critical)
  { name: "direct eval", code: "var r = eval(source);", expected: ["unsafe-eval"] },
  { name: "Function constructor call (incl. return-this idiom)", code: 'var g = Function("return this");', expected: ["unsafe-function-constructor"] },
  { name: "new Function", code: 'var h = new Function("a", "return a");', expected: ["unsafe-function-constructor"] },
  // module loading (critical)
  { name: "dynamic import", code: 'import("./more.js");', expected: ["unsafe-dynamic-import"] },
  // surface layer (warning)
  { name: "fetch reach", code: 'fetch("https://example.invalid");', expected: ["out-of-surface-global"] },
  { name: "process reach", code: "var env = process.env;", expected: ["out-of-surface-global"] },
  { name: "globalThis reach", code: "var g = globalThis;", expected: ["out-of-surface-global"] },
  { name: "window reach", code: "window.location;", expected: ["out-of-surface-global"] },
  { name: "engine-internal dunder global", code: "var out = __rollOutput;", expected: ["engine-internal-global"] },
  // masking ladder (info/warning)
  { name: "hex escape run", code: 'var p = "\\x48\\x65\\x6c\\x6c\\x6f\\x20";', expected: ["masking-encoded-literal"] },
  { name: "base64-shaped literal", code: 'var b = "aGVsbG8gd29ybGQgZnJvbSB2aWI=";', expected: ["masking-encoded-literal"] },
  {
    name: "packed space-less payload (750+ tier)",
    code: `var blob = "${"9f8e7d6c".repeat(100)}";`,
    expected: ["masking-suspicious-literal", "masking-encoded-literal"],
  },
  { name: "invisible character in a string", code: "var k = \"a​b\";", expected: ["masking-invisible-characters"] },
  { name: "bidi control character in a string", code: "var k2 = \"a‮b\";", expected: ["masking-bidi-characters"] },
  {
    name: "single-character identifier dominance",
    code: "function f(a,b){var c=a+b;var d=a-b;var e=c*d;var g=c+d;var h=e/g;var i=g+h;var j=i*h;var k=j+i;var l=k+j;var m=l+k;var n=m+l;return n}",
    expected: ["obfuscation-short-identifiers"],
  },
  // obfuscator signatures (critical)
  { name: "obfuscator.io _0x identifier", code: "var _0x1a2b = 1;\n_0x1a2b++;", expected: ["obfuscation-known-signature"] },
  { name: "jsfuck-shaped literal", code: 'var j = "+!![]+!![]+!![]+!![]+!![]+!![]";', expected: ["obfuscation-known-signature"] },
  { name: "$/_ identifier soup", code: "var $$$$$$$$ = 1;", expected: ["obfuscation-known-signature"] },
];

describe("script safety — positive fixtures per rule family", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} → ${fixture.expected.join(", ")}`, () => {
      const findings = analyzeScriptSource(fixture.code, fixture.kind ?? SCRIPT_KIND.prompt);
      for (const ruleId of fixture.expected) {
        const hit = findingOf(findings, ruleId);
        expect(hit, `${fixture.name}: expected ${ruleId}, got ${JSON.stringify(findings)}`).toBeDefined();
        expect(hit?.severity, `${fixture.name}: ${ruleId} severity`).toBe(SCRIPT_SAFETY_RULES[ruleId as keyof typeof SCRIPT_SAFETY_RULES]);
      }
    });
  }

  it("every finding carries a 1-based line (and column when node-backed)", () => {
    const findings = analyzeScriptSource("var a = 1;\nvar f = ({}).constructor.constructor;", SCRIPT_KIND.prompt);
    const chain = findingOf(findings, "escape-constructor-chain");
    expect(chain?.line).toBe(2);
    expect(chain?.col).toBe(9);
    expect(chain?.severity).toBe("critical");
  });

  it("severity per family: escape primitives and obfuscation are critical", () => {
    const criticals = [
      "var f = ({}).constructor.constructor;",
      "o.__proto__ = x;",
      "Object.setPrototypeOf(a, b);",
      'Object.defineProperty(Array.prototype, "x", { value: 1 });',
      "var s = obj[Symbol.species];",
      'Symbol.for("k");',
      "function f() { return arguments.callee; }",
      "Object.getOwnPropertySymbols(host);",
      "Reflect.ownKeys(host);",
      "new Proxy({}, h);",
      'eval("1");',
      'Function("return this");',
      "var _0x1a2b = 1;",
    ];
    for (const code of criticals) {
      const findings = analyzeScriptSource(code, SCRIPT_KIND.prompt).filter(
        (finding) => finding.severity !== "critical",
      );
      expect(findings, `${code}: non-critical findings ${JSON.stringify(findings)}`).toEqual([]);
    }
  });

  it("severity per family: masking indicators are info/warning, surface violations warning", () => {
    const checks: ReadonlyArray<[string, string]> = [
      ['var p = "\\x41\\x42\\x43\\x44";', "masking-encoded-literal"],
      ['var b = "aGVsbG8gd29ybGQgZnJvbSB2aWI=";', "masking-encoded-literal"],
      ["var g = globalThis;", "out-of-surface-global"],
      ["var out = __rollOutput;", "engine-internal-global"],
    ];
    for (const [code, ruleId] of checks) {
      const hit = findingOf(analyzeScriptSource(code, SCRIPT_KIND.prompt), ruleId);
      expect(hit?.severity, `${ruleId} must not be critical (it is an indicator, not a proven escape)`).not.toBe("critical");
    }
  });
});

// ─── 3. Absence pins and syntax errors ────────────────────────────────────────

describe("script safety — absence pins", () => {
  it("the allowed surface stays silent", () => {
    const prompt = [
      "var last = context.chat.lastMessage;",
      "context.chat.injectMessage('ok');",
      "context.state.set('hp', 100);",
      "var n = context.randomInt(1, 6);",
      "Math.random();",
      "JSON.stringify({});",
      "new Date();",
      "new Map();",
      "console.log('hi');",
      "parseInt('42');",
      "new RegExp('a+');",
    ].join("\n");
    expect(analyzeScriptSource(prompt, SCRIPT_KIND.prompt)).toEqual([]);

    const dice = "context.dice.register({ id: 'x', label: 'X' });\nMath.floor(1.5);";
    expect(analyzeScriptSource(dice, SCRIPT_KIND.dice)).toEqual([]);

    const interactive = "context.experience.register({ create() { return { count: 0 }; } });";
    expect(analyzeScriptSource(interactive, SCRIPT_KIND.interactive)).toEqual([]);
  });

  it("long prose strings (with spaces) do not trip the literal rules", () => {
    const code = 'var s = " The cozy establishment has ambient sounds of clinking dishes and gentle music everywhere.";';
    expect(analyzeScriptSource(code, SCRIPT_KIND.prompt)).toEqual([]);
  });

  it("a lone mid-tier space-less literal stays below the suspicious threshold (score ≤ 3)", () => {
    const code = 'var s = "abcdefghijabcdefghijabcdefghijabcdefghijabcdefghij";';
    const findings = analyzeScriptSource(code, SCRIPT_KIND.prompt);
    expect(findingOf(findings, "masking-suspicious-literal")).toBeUndefined();
  });

  it("Symbol.iterator READS stay clean (only overrides are flagged)", () => {
    const code = "var it = x[Symbol.iterator];\nvar step = it.call(x);";
    expect(analyzeScriptSource(code, SCRIPT_KIND.prompt)).toEqual([]);
  });

  it("syntax errors produce no findings and never throw", () => {
    const broken: readonly string[] = [
      "const broken = {",
      "function f(",
      "var x = 'unterminated",
      "}}}",
      "",
    ];
    for (const code of broken) {
      expect(analyzeScriptSource(code, SCRIPT_KIND.prompt)).toEqual([]);
    }
  });
});

// ─── 4. Rule table and surface constants ──────────────────────────────────────

describe("script safety — rule table and surface constants", () => {
  it("every registered ruleId is exercised by at least one fixture (no dead rules)", () => {
    const exercised = new Set<string>();
    for (const fixture of FIXTURES) {
      for (const ruleId of fixture.expected) exercised.add(ruleId);
    }
    const registered = Object.keys(SCRIPT_SAFETY_RULES);
    expect([...exercised].sort()).toEqual([...registered].sort());
  });

  it("the severity mapping follows the report: escape/obfuscation critical, masking warning/info", () => {
    expect(SCRIPT_SAFETY_RULES["escape-constructor-chain"]).toBe("critical");
    expect(SCRIPT_SAFETY_RULES["escape-proto-access"]).toBe("critical");
    expect(SCRIPT_SAFETY_RULES["escape-symbol-hook"]).toBe("critical");
    expect(SCRIPT_SAFETY_RULES["escape-reflection-api"]).toBe("critical");
    expect(SCRIPT_SAFETY_RULES["unsafe-eval"]).toBe("critical");
    expect(SCRIPT_SAFETY_RULES["obfuscation-known-signature"]).toBe("critical");
    expect(SCRIPT_SAFETY_RULES["masking-encoded-literal"]).toBe("info");
    expect(SCRIPT_SAFETY_RULES["masking-suspicious-literal"]).toBe("warning");
    expect(SCRIPT_SAFETY_RULES["out-of-surface-global"]).toBe("warning");
    expect(SCRIPT_SAFETY_RULES["engine-internal-global"]).toBe("warning");
  });

  it("ALLOWED_SCRIPT_GLOBALS transcribes the registry §1–§3 surface", () => {
    const standardGlobals = [
      "Math", "JSON", "Date", "parseInt", "parseFloat", "isNaN", "isFinite",
      "Array", "Object", "String", "Number", "Boolean", "RegExp", "Map", "Set",
      "Error", "console",
    ];
    for (const kind of [SCRIPT_KIND.prompt, SCRIPT_KIND.dice, SCRIPT_KIND.interactive] as const) {
      const surface = ALLOWED_SCRIPT_GLOBALS[kind];
      for (const name of [...standardGlobals, "context"]) {
        expect(surface.globals, `${kind}: ${name} must be allowed`).toContain(name);
      }
    }
    expect([...ALLOWED_SCRIPT_GLOBALS[SCRIPT_KIND.prompt].contextChannels].sort()).toEqual(
      ["chat", "character", "lore", "state", "shared", "persona", "random", "randomInt", "pick", "weightedPick"].sort(),
    );
    expect([...ALLOWED_SCRIPT_GLOBALS[SCRIPT_KIND.dice].contextChannels].sort()).toEqual(
      ["dice", "actor", "priorAttempts"].sort(),
    );
    expect([...ALLOWED_SCRIPT_GLOBALS[SCRIPT_KIND.interactive].contextChannels].sort()).toEqual(
      ["experience", "helpers", "state", "participants", "random", "chance"].sort(),
    );
  });
});
