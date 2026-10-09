/**
 * Script safety detector — static suspicion analysis for VT script sources
 * (SCRIPT_SAFETY_PLAN Wave 1, unit SS-1).
 *
 * WHY THIS EXISTS: imported third-party scripts run inside `node:vm` contexts
 * with host globals injected — not a confinement boundary (AD-024). This module
 * is the USER-ASSIST detection layer that feeds editor highlighting and the
 * imported-script findings modal; it is never a security boundary (masking
 * levels 5 "dormant until a condition" and 6 "AI-review steering" are invisible
 * to any static pass by construction).
 *
 * TWO INDEPENDENT LAYERS (SCRIPT_ALLOWED_SURFACE_REGISTRY.md §5 — do not
 * conflate):
 * - Allowlist layer = REACHABILITY: `ALLOWED_SCRIPT_GLOBALS` answers which
 *   globals a script of each kind may touch. It is THE single executable
 *   source — the web detector and the future QuickJS guest library import the
 *   same constant; the registry markdown is the human-readable description and
 *   drift check, never a data source for code.
 * - Category layer = SUSPICIOUSNESS: what in-surface code is suspicious is
 *   decided by the rule table below, authored from the vm2 attack catalog
 *   (SCRIPT_SAFETY_DETECTOR_RESEARCH.md §5.1 host reference primitives, §2
 *   js-x-ray transferable categories, §5.4 masking ladder) plus the
 *   eslint-plugin-security character-level detectors. Standard JavaScript is
 *   legitimate by construction — nothing here flags "anything not listed".
 *
 * CONTRACT:
 * - Pure function over (code, kind); no I/O. Runs at edit/import time only —
 *   never per keystroke (callers debounce) and never inside the run loop
 *   (vm2 #564: bridge-crossing scans cost ~175x on realistic workloads).
 * - Syntax errors produce NO findings — the editors' own parsers mark those.
 * - Severity → behavior (report § "What this means"): `info` = editor hint
 *   only; `warning` = highlighted line + findings modal for imported scripts;
 *   `critical` = the same modal, never silenceable. The modal itself arrives
 *   in later plan units; this module only reports.
 * - ruleIds are stable identifiers, NOT user-facing strings — UI messages come
 *   from i18n keys `script_safety_rule_<id>` in a later unit.
 *
 * PARSER: acorn (zero-dependency, MIT, ESTree) — the accepted FIRST runtime
 * dependency of this leaf package; switching parsers is a one-file change.
 */
import { parse } from "acorn";
import type {
  CallExpression,
  Identifier,
  Literal,
  MemberExpression,
  NewExpression,
  Node as AcornNode,
  ObjectPattern,
} from "acorn";
import { SCRIPT_KIND, type ScriptKind } from "./platform-constants.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ScriptSafetySeverity = "info" | "warning" | "critical";

export interface ScriptSafetyFinding {
  /** Stable rule identifier (see SCRIPT_SAFETY_RULES). */
  readonly ruleId: string;
  readonly severity: ScriptSafetySeverity;
  /** 1-based source line of the suspicious construct. */
  readonly line: number;
  /** 1-based column, when a node location backs the finding. */
  readonly col?: number;
}

/**
 * The rule table — one entry per implemented rule, severity per the report's
 * severity→behavior mapping: escape primitives and obfuscation → `critical`;
 * masking indicators → `warning`/`info`; surface violations → `warning`.
 * Categories (grouped prefixes):
 * - `escape-*` — vm2 Host Reference Primitive families (report §5.1).
 * - `unsafe-*` — string-to-code execution and module loading (report §2, §5.3).
 * - `out-of-surface-global` / `engine-internal-global` — registry §4/§5 layer.
 * - `masking-*` — the §5.4 masking ladder levels 2–4 (report §2, §5.4;
 *   eslint-plugin-security character detectors).
 * - `obfuscation-*` — obfuscation indicators (report §2).
 */
export const SCRIPT_SAFETY_RULES = {
  // `.constructor.constructor` chains, this/global constructors invoked,
  // caught-error constructors — the atomic escape (vm2 category 1).
  "escape-constructor-chain": "critical",
  // A bare `.constructor` read — the first hop of every chain; warning because
  // `x.constructor === Array`-style checks remain legal standard JS.
  "escape-constructor-access": "warning",
  // `__proto__` access/assignment, setPrototypeOf, __defineGetter__-family
  // (vm2 category 2).
  "escape-proto-access": "critical",
  // defineProperty/defineProperties aimed at a `.prototype` (vm2 category 2).
  "escape-prototype-pollution": "critical",
  // Symbol.species in any role, Symbol.hasInstance/iterator/toPrimitive
  // overrides, Symbol.for cross-realm registry (vm2 categories 3/18).
  "escape-symbol-hook": "critical",
  // `arguments.callee` / `arguments.caller` (vm2 category 5).
  "escape-caller-callee": "critical",
  // `.caller` / `.arguments` on other objects — deprecated stack-leaking
  // properties, warning because plain data objects may carry such field names.
  "escape-caller-property": "warning",
  // Reflection enumeration of object shape (getOwnPropertySymbols/Descriptors/
  // Names, getPrototypeOf, any `Reflect.*`, Error.prepareStackTrace) —
  // capability-name discovery and host-object probing (report §4, §5.1 cat. 8).
  "escape-reflection-api": "critical",
  // `new Proxy` / `Proxy.revocable` — the membrane-construction primitive
  // (vm2 global guidance names Proxy alongside constructor chains).
  "escape-proxy": "critical",
  // Direct `eval(...)` (report §2 unsafe-stmt).
  "unsafe-eval": "critical",
  // `Function(...)` / `new Function(...)` — including `Function("return this")`,
  // which libraries use legitimately but a VT guest never needs.
  "unsafe-function-constructor": "critical",
  // Dynamic `import(...)` — module loading is a detector signal (report §5.3).
  "unsafe-dynamic-import": "critical",
  // Host globals that do not exist inside any VT sandbox (registry §4 +
  // sandbox file headers) — reaching for them signals escape intent or a
  // broken script; `warning` because the reach itself fails at runtime.
  "out-of-surface-global": "warning",
  // Bare `__`-prefixed identifiers — engine internals of the VM orchestration
  // (registry §4: dunder globals are NOT user API).
  "engine-internal-global": "warning",
  // Hex/unicode escape runs and base64-shaped string literals (report §2
  // encoded-literal; §5.4 masking level 2).
  "masking-encoded-literal": "info",
  // Long space-less string literals — packed payloads regardless of encoding
  // (report §2 suspicious-literal: thresholds 45/70/200/750 chars, warning
  // when the summed per-file score exceeds 3).
  "masking-suspicious-literal": "warning",
  // Invisible Unicode format characters (ZWSP/ZWJ/soft hyphen/BOM class —
  // eslint-plugin-security detect-invisible-characters).
  "masking-invisible-characters": "warning",
  // Bidi control characters — trojan-source reordering (eslint-plugin-security
  // detect-bidi-characters).
  "masking-bidi-characters": "warning",
  // Identifier-length statistics: a file dominated by single-character names
  // (report §2 short-identifiers).
  "obfuscation-short-identifiers": "warning",
  // Known obfuscator signatures: `_0x…` hex identifiers (obfuscator.io),
  // jsfuck-shaped literals, `$`/`_`-only identifier soup (jjencode class) —
  // report §2 obfuscated-code: "a roleplay script has zero legitimate reason
  // to be obfuscated".
  "obfuscation-known-signature": "critical",
} as const satisfies Record<string, ScriptSafetySeverity>;

export type ScriptSafetyRuleId = keyof typeof SCRIPT_SAFETY_RULES;

// ─── Allowed surface (registry §1–§3 — the single executable source) ─────────

/**
 * The globals every VT sandbox injects (identical set in the prompt, dice and
 * interactive VMs — `script-sandbox.ts`, `dice-script-sandbox.ts` and
 * `experience-sandbox.ts` all spread the same standard-globals builder).
 * Derived ONCE here; the per-kind records below only add their `context`
 * channel. The QuickJS guest library imports this same constant as its parity
 * contract.
 */
const STANDARD_SANDBOX_GLOBALS = [
  "Math", "JSON", "Date", "parseInt", "parseFloat", "isNaN", "isFinite", "Array", "Object",
  "String", "Number", "Boolean", "RegExp", "Map", "Set", "Error", "console",
] as const;

/** Per-kind allowed surface: injected globals + the channels of `context`. */
export interface AllowedScriptSurface {
  /** Globals resolvable inside the sandbox (the closed allowlist). */
  readonly globals: readonly string[];
  /**
   * Top-level channels of the `context` object (registry §1–§3). The prompt
   * kind's snake_case Janitor aliases live under `chat`; the interactive kind
   * merges the registration channel with the method-context fields; the
   * per-call second arguments (settings/viewer/action) are not context
   * channels. Engine internals (`__rollOutput` etc.) are deliberately absent —
   * they are not user API (registry §4).
   */
  readonly contextChannels: readonly string[];
}

/**
 * THE allowed-surface constant (registry §5: "single executable source").
 * Consumers: this detector (out-of-surface reachability) and the future
 * QuickJS guest library (parity contract). Do not derive a second copy
 * anywhere — AGENTS.md §3 one-source rule.
 */
export const ALLOWED_SCRIPT_GLOBALS: Readonly<Record<ScriptKind, AllowedScriptSurface>> = {
  [SCRIPT_KIND.prompt]: {
    globals: [...STANDARD_SANDBOX_GLOBALS, "context"],
    contextChannels: [
      "chat", "character", "lore", "state", "shared", "persona",
      "random", "randomInt", "pick", "weightedPick",
    ],
  },
  [SCRIPT_KIND.dice]: {
    globals: [...STANDARD_SANDBOX_GLOBALS, "context"],
    contextChannels: ["dice", "actor", "priorAttempts"],
  },
  [SCRIPT_KIND.interactive]: {
    globals: [...STANDARD_SANDBOX_GLOBALS, "context"],
    contextChannels: ["experience", "helpers", "state", "participants", "random", "chance"],
  },
};

/**
 * Host/dangerous globals that do not exist inside any VT sandbox. Every name
 * is traceable to a rule source: registry §4 names `process`, `Bun`, `fetch`,
 * `WebSocket`, `require`; the sandbox file headers name the deliberate
 * exclusions `setTimeout`/`setInterval`, `fetch`, `require`, `process`,
 * `globalThis`, `import`, `eval`, `Function`, `WebAssembly`, `Promise`,
 * `Reflect`; the rules-starter self-containment test adds `window`,
 * `document`, `XMLHttpRequest`; `global`/`self` are aliases of the named
 * `globalThis`. `eval`/`Function`/`Reflect`/`import(` carry their own critical
 * rules and stay out of this list to avoid double findings; bare `Symbol` use
 * is standard JS (the escape shapes `Symbol.species`/`Symbol.for` carry their
 * own rule).
 */
const HOST_GLOBAL_BLOCKLIST: readonly string[] = [
  "Bun", "Promise", "WebAssembly", "WebSocket", "XMLHttpRequest", "document", "fetch",
  "global", "globalThis", "process", "require", "self", "setInterval", "setTimeout", "window",
];

// ─── Analysis internals ───────────────────────────────────────────────────────

/** Parse options; tests mirror these when proving a source parses. */
const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  locations: true,
  allowReturnOutsideFunction: true,
} as const;

interface MemberAccessInfo {
  readonly node: MemberExpression;
  readonly parent: AcornNode | undefined;
  /** Static property name, or the string value of a computed literal key. */
  readonly propertyName: string | null;
}

interface CallInfo {
  readonly node: CallExpression | NewExpression;
  readonly isNew: boolean;
  /** Static callee member info when the callee is `a.b(...)`; else null. */
  readonly member: MemberAccessInfo | null;
  /** Callee identifier name when the callee is `f(...)`; else null. */
  readonly identifier: string | null;
}

interface IdentifierRefInfo {
  readonly node: Identifier;
  readonly parent: AcornNode | undefined;
}

interface StringLiteralInfo {
  readonly node: Literal;
  readonly value: string;
  readonly raw: string;
}

interface AnalysisContext {
  readonly code: string;
  readonly members: readonly MemberAccessInfo[];
  readonly calls: readonly CallInfo[];
  readonly dynamicImports: readonly AcornNode[];
  readonly identifierRefs: readonly IdentifierRefInfo[];
  /** Reference + declaration identifier occurrences, for length statistics. */
  readonly identifierStats: readonly Identifier[];
  readonly stringLiterals: readonly StringLiteralInfo[];
  readonly templateQuasis: readonly { node: AcornNode; value: string }[];
  /** Ancestors (program → parent) per node, for context-sensitive rules. */
  readonly ancestorsOf: (node: AcornNode) => readonly AcornNode[];
}

function isAstNode(value: unknown): value is AcornNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function nodeRecord(node: AcornNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

/** Collect binding Identifier nodes from a declaration pattern (the names
 *  themselves are not needed — only which Identifier nodes are bindings). */
function collectPatternNames(node: AcornNode | null | undefined, nodes: Set<AcornNode>): void {
  if (!node) return;
  if (node.type === "Identifier") {
    nodes.add(node);
    return;
  }
  if (node.type === "ObjectPattern") {
    // Recurse into binding VALUES only — pattern keys are property names, not
    // bindings (`const { fetch: renamed } = x` binds `renamed`).
    for (const property of (node as ObjectPattern).properties) {
      const record = nodeRecord(property as AcornNode);
      collectPatternNames(
        (record.value ?? record.argument) as AcornNode | null | undefined,
        nodes,
      );
    }
    return;
  }
  // ArrayPattern (elements), AssignmentPattern (left), RestElement (argument).
  for (const key of ["elements", "left", "argument"] as const) {
    const value = nodeRecord(node)[key];
    if (Array.isArray(value)) {
      for (const element of value) if (isAstNode(element)) collectPatternNames(element, nodes);
    } else if (isAstNode(value)) {
      collectPatternNames(value, nodes);
    }
  }
}

const DECLARATION_ID_PARENT_TYPES = new Set([
  "VariableDeclarator",
  "FunctionDeclaration",
  "FunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
]);

/** True when an Identifier sits in a position that names something rather than
 *  referencing it (member property, object key, label). */
function isNonReferencePosition(parent: AcornNode, key: string): boolean {
  if (parent.type === "MemberExpression" && key === "property") {
    return !(parent as MemberExpression).computed;
  }
  if (
    (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
    key === "key"
  ) {
    return !(parent as unknown as { computed: boolean }).computed;
  }
  if (
    (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") &&
    key === "label"
  ) {
    return true;
  }
  return false;
}

function memberPropertyName(member: MemberExpression): string | null {
  const { property, computed } = member;
  if (!computed && property.type === "Identifier") return (property as Identifier).name;
  if (property.type === "Literal" && typeof (property as Literal).value === "string") {
    return (property as Literal).value as string;
  }
  return null;
}

function memberInfoOf(node: MemberExpression, parent: AcornNode | undefined): MemberAccessInfo {
  return { node, parent, propertyName: memberPropertyName(node) };
}

function identifierNameOf(node: AcornNode | null | undefined): string | null {
  return node && node.type === "Identifier" ? (node as Identifier).name : null;
}

function isStringArgument(argument: AcornNode): boolean {
  return argument.type === "Literal" && typeof (argument as Literal).value === "string";
}

function collectAnalysis(ast: AcornNode, code: string): AnalysisContext {
  const members: MemberAccessInfo[] = [];
  const calls: CallInfo[] = [];
  const dynamicImports: AcornNode[] = [];
  const identifierRefs: IdentifierRefInfo[] = [];
  const identifierStats: Identifier[] = [];
  const stringLiterals: StringLiteralInfo[] = [];
  const templateQuasis: { node: AcornNode; value: string }[] = [];
  const ancestors = new Map<AcornNode, AcornNode[]>();
  const declarationNodes = new Set<AcornNode>();

  const visit = (node: AcornNode, parent: AcornNode | undefined, key: string | undefined, path: AcornNode[]): void => {
    ancestors.set(node, path);

    // Harvest binding names from declaration positions before the generic
    // recursion reaches them, so those Identifiers are not counted as refs.
    // Independent checks: a function declaration carries BOTH an id and params.
    if (node.type === "CatchClause") {
      collectPatternNames(nodeRecord(node).param as AcornNode | undefined, declarationNodes);
    }
    if (DECLARATION_ID_PARENT_TYPES.has(node.type)) {
      collectPatternNames(nodeRecord(node).id as AcornNode | undefined, declarationNodes);
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const params = nodeRecord(node).params;
      if (Array.isArray(params)) {
        for (const param of params) {
          if (isAstNode(param)) collectPatternNames(param, declarationNodes);
        }
      }
    }

    switch (node.type) {
      case "MemberExpression":
        members.push(memberInfoOf(node as MemberExpression, parent));
        break;
      case "CallExpression":
      case "NewExpression": {
        const callee = (node as CallExpression).callee;
        calls.push({
          node: node as CallExpression,
          isNew: node.type === "NewExpression",
          member: callee.type === "MemberExpression" ? memberInfoOf(callee as MemberExpression, node) : null,
          identifier: callee.type === "Identifier" ? (callee as Identifier).name : null,
        });
        break;
      }
      case "ImportExpression":
        dynamicImports.push(node);
        break;
      case "Identifier": {
        const identifier = node as Identifier;
        const isDeclaration = declarationNodes.has(node);
        const namesPosition =
          parent !== undefined && key !== undefined && isNonReferencePosition(parent, key);
        if (isDeclaration || !namesPosition) {
          identifierStats.push(identifier);
        }
        if (!isDeclaration && !namesPosition) {
          identifierRefs.push({ node: identifier, parent });
        }
        break;
      }
      case "Literal": {
        const literal = node as Literal;
        if (typeof literal.value === "string") {
          stringLiterals.push({
            node: literal,
            value: literal.value,
            raw: code.slice(literal.start, literal.end),
          });
        }
        break;
      }
      case "TemplateElement": {
        const cooked = (node as unknown as { value: { cooked: string | null } }).value.cooked;
        if (typeof cooked === "string") templateQuasis.push({ node, value: cooked });
        break;
      }
      default:
        break;
    }
  };

  const walk = (value: unknown, parent: AcornNode | undefined, key: string | undefined, path: AcornNode[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, parent, key, path);
      return;
    }
    if (!isAstNode(value)) return;
    visit(value, parent, key, path);
    const nextPath = [...path, value];
    const record = nodeRecord(value);
    for (const childKey of Object.keys(record)) {
      if (childKey === "type") continue;
      walk(record[childKey], value, childKey, nextPath);
    }
  };

  walk(ast, undefined, undefined, []);

  return {
    code,
    members,
    calls,
    dynamicImports,
    identifierRefs,
    identifierStats,
    stringLiterals,
    templateQuasis,
    ancestorsOf: (node) => ancestors.get(node) ?? [],
  };
}

// ─── Rule constants ───────────────────────────────────────────────────────────

const GLOBAL_OBJECT_ALIASES = new Set(["globalThis", "global", "self"]);
const PROTO_MANIPULATION_MEMBERS = new Set([
  "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);
const OBJECT_PROTO_APIS = new Set(["setPrototypeOf"]);
const PROTOTYPE_TARGET_APIS = new Set(["defineProperty", "defineProperties"]);
const REFLECTION_OBJECT_APIS = new Set([
  "getOwnPropertySymbols",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getPrototypeOf",
]);
/** Symbol hooks: `species` in any role; the rest only as overrides (writes). */
const SYMBOL_HOOKS_OVERRIDE_ONLY = new Set(["hasInstance", "iterator", "toPrimitive"]);
const ENCODED_ESCAPE = /\\x[0-9a-fA-F]{2}|\\u\{[0-9a-fA-F]{1,6}\}|\\u[0-9a-fA-F]{4}/g;
const BASE64_SHAPED = /^[A-Za-z0-9+/]{20,}={0,2}$/;
const BIDI_CHARACTERS = /[\u061C\u202A-\u202E\u2066-\u2069]/g;
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u2060-\u2064\u206A-\u206F\uFEFF]/g;
const OBFUSCATOR_HEX_IDENTIFIER = /^_0x[0-9a-fA-F]+$/;
const JSFUCK_LITERAL = /^[+!()[\]{}]{30,}$/;
const DOLLAR_UNDERSCORE_SOUP = /^[$_]{8,}$/;
/**
 * Single-character identifiers must dominate the file this strongly before the
 * statistics rule fires (the legit corpus tops out ≈0.15; minified code ≈0.9).
 */
const SHORT_IDENTIFIER_FRACTION = 0.6;
const SHORT_IDENTIFIER_MIN_OCCURRENCES = 15;
/** suspicious-literal score tiers (report §2: thresholds 45/70/200/750). */
function suspiciousLiteralScore(length: number): number {
  if (length >= 750) return 4;
  if (length >= 200) return 3;
  if (length >= 70) return 2;
  if (length >= 45) return 1;
  return 0;
}

function lineAt(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (code.charCodeAt(i) === 10 /* \n */) line++;
  return line;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Analyze a script source of the given kind. Pure; syntax errors yield an
 * empty list (the editors' own parsers mark those). Findings are sorted by
 * (line, col, ruleId) and deduplicated per (ruleId, line, col).
 */
export function analyzeScriptSource(code: string, kind: ScriptKind): readonly ScriptSafetyFinding[] {
  let ast: AcornNode;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch {
    return [];
  }

  const ctx = collectAnalysis(ast, code);
  const seen = new Set<string>();
  const findings: ScriptSafetyFinding[] = [];

  const pushFinding = (ruleId: ScriptSafetyRuleId, line: number, col: number | undefined): void => {
    const dedupeKey = `${ruleId}:${line}:${col ?? 0}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    findings.push({
      ruleId,
      severity: SCRIPT_SAFETY_RULES[ruleId],
      line,
      ...(col === undefined ? {} : { col }),
    });
  };
  const emitAtNode = (ruleId: ScriptSafetyRuleId, node: AcornNode): void => {
    const loc = node.loc;
    if (!loc) return;
    pushFinding(ruleId, loc.start.line, loc.start.column + 1);
  };
  const emitAtIndex = (ruleId: ScriptSafetyRuleId, index: number): void => {
    pushFinding(ruleId, lineAt(code, index), undefined);
  };

  const insideCatch = (node: AcornNode): boolean =>
    ctx.ancestorsOf(node).some((ancestor) => ancestor.type === "CatchClause");

  /** True when the node sits anywhere inside an assignment TARGET — covers both
   *  `Symbol.iterator = f` and the computed `x[Symbol.iterator] = f` shape. */
  const inAssignmentTarget = (node: AcornNode): boolean => {
    const path = ctx.ancestorsOf(node);
    let child: AcornNode = node;
    for (let i = path.length - 1; i >= 0; i--) {
      const parent = path[i] as AcornNode;
      if (parent.type === "AssignmentExpression" && (parent as unknown as { left: AcornNode }).left === child) {
        return true;
      }
      child = parent;
    }
    return false;
  };

  // ── vm2 category 1: constructor chain traversal ──
  for (const member of ctx.members) {
    if (member.propertyName !== "constructor") continue;
    const object = member.node.object;
    const isChainHop =
      object.type === "MemberExpression" &&
      memberPropertyName(object as MemberExpression) === "constructor";
    // Inner hops of a longer chain are covered by the outermost member.
    const partOfLongerChain =
      member.parent !== undefined &&
      member.parent.type === "MemberExpression" &&
      (member.parent as MemberExpression).object === member.node &&
      memberPropertyName(member.parent as MemberExpression) === "constructor";
    if (partOfLongerChain) continue;
    const calledWithStringArgument =
      member.parent !== undefined &&
      member.parent.type === "CallExpression" &&
      (member.parent as CallExpression).arguments.some(isStringArgument);
    const objectIsThisOrGlobal =
      object.type === "ThisExpression" ||
      GLOBAL_OBJECT_ALIASES.has(identifierNameOf(object) ?? "");
    if (isChainHop || calledWithStringArgument || objectIsThisOrGlobal || insideCatch(member.node)) {
      emitAtNode("escape-constructor-chain", member.node);
    } else {
      emitAtNode("escape-constructor-access", member.node);
    }
  }

  // ── vm2 category 2: prototype chain manipulation ──
  for (const member of ctx.members) {
    if (member.propertyName !== null && PROTO_MANIPULATION_MEMBERS.has(member.propertyName)) {
      emitAtNode("escape-proto-access", member.node);
    }
  }
  for (const call of ctx.calls) {
    const callee = call.member;
    if (callee === null || callee.propertyName === null) continue;
    if (identifierNameOf(callee.node.object) === "Object") {
      if (OBJECT_PROTO_APIS.has(callee.propertyName)) {
        emitAtNode("escape-proto-access", call.node);
      }
      if (PROTOTYPE_TARGET_APIS.has(callee.propertyName)) {
        const target = call.node.arguments[0];
        if (target !== undefined && target.type === "MemberExpression" && memberPropertyName(target as MemberExpression) === "prototype") {
          emitAtNode("escape-prototype-pollution", call.node);
        }
      }
    }
  }

  // ── vm2 categories 3/18: symbol protocol hooks ──
  for (const member of ctx.members) {
    if (identifierNameOf(member.node.object) !== "Symbol") continue;
    if (member.propertyName === "for") {
      emitAtNode("escape-symbol-hook", member.node);
      continue;
    }
    const { property, computed } = member.node;
    if (!computed && property.type === "Identifier") {
      const symbolName = (property as Identifier).name;
      if (symbolName === "species") {
        emitAtNode("escape-symbol-hook", member.node);
      } else if (SYMBOL_HOOKS_OVERRIDE_ONLY.has(symbolName) && inAssignmentTarget(member.node)) {
        emitAtNode("escape-symbol-hook", member.node);
      }
    }
  }

  // ── vm2 category 5: caller/callee access ──
  for (const member of ctx.members) {
    if (member.propertyName === "callee" || member.propertyName === "caller") {
      if (identifierNameOf(member.node.object) === "arguments") {
        emitAtNode("escape-caller-callee", member.node);
      } else {
        emitAtNode("escape-caller-property", member.node);
      }
    } else if (member.propertyName === "arguments") {
      emitAtNode("escape-caller-property", member.node);
    }
  }

  // ── reflection enumeration (report §4, §5.1 category 8) ──
  for (const member of ctx.members) {
    const objectName = identifierNameOf(member.node.object);
    if (objectName === "Reflect") {
      emitAtNode("escape-reflection-api", member.node);
    } else if (objectName === "Error" && member.propertyName === "prepareStackTrace") {
      emitAtNode("escape-reflection-api", member.node);
    }
  }
  for (const call of ctx.calls) {
    const callee = call.member;
    if (
      callee !== null &&
      callee.propertyName !== null &&
      identifierNameOf(callee.node.object) === "Object" &&
      REFLECTION_OBJECT_APIS.has(callee.propertyName)
    ) {
      emitAtNode("escape-reflection-api", call.node);
    }
  }

  // ── Proxy construction ──
  for (const call of ctx.calls) {
    if (call.identifier === "Proxy") {
      emitAtNode("escape-proxy", call.node);
    } else if (call.member !== null && identifierNameOf(call.member.node.object) === "Proxy") {
      emitAtNode("escape-proxy", call.node);
    }
  }

  // ── string-to-code execution (report §2 unsafe-stmt) ──
  for (const call of ctx.calls) {
    if (call.identifier === "eval" && !call.isNew) emitAtNode("unsafe-eval", call.node);
    if (call.identifier === "Function") emitAtNode("unsafe-function-constructor", call.node);
  }

  // ── dynamic import (report §5.3) ──
  for (const node of ctx.dynamicImports) emitAtNode("unsafe-dynamic-import", node);

  // ── surface layer (registry §4/§5) ──
  const allowedGlobals = new Set(ALLOWED_SCRIPT_GLOBALS[kind].globals);
  for (const ref of ctx.identifierRefs) {
    if (HOST_GLOBAL_BLOCKLIST.includes(ref.node.name) && !allowedGlobals.has(ref.node.name)) {
      emitAtNode("out-of-surface-global", ref.node);
    }
    if (ref.node.name.startsWith("__")) {
      emitAtNode("engine-internal-global", ref.node);
    }
  }

  // ── masking: encoded literals (report §2, §5.4 level 2) ──
  for (const literal of ctx.stringLiterals) {
    const escapeCount = (literal.raw.match(ENCODED_ESCAPE) ?? []).length;
    if (escapeCount >= 3 || BASE64_SHAPED.test(literal.value)) {
      emitAtNode("masking-encoded-literal", literal.node);
    }
  }
  for (const quasi of ctx.templateQuasis) {
    if (BASE64_SHAPED.test(quasi.value)) emitAtNode("masking-encoded-literal", quasi.node);
  }

  // ── masking: suspicious long literals (report §2; space-less only — the
  //    legit corpus's long strings are prose with spaces) ──
  const suspicious = ctx.stringLiterals.filter(
    (literal) => !/\s/.test(literal.value) && suspiciousLiteralScore(literal.value.length) > 0,
  );
  const totalScore = suspicious.reduce(
    (sum, literal) => sum + suspiciousLiteralScore(literal.value.length),
    0,
  );
  if (totalScore > 3) {
    for (const literal of suspicious) {
      if (suspiciousLiteralScore(literal.value.length) >= 2) {
        emitAtNode("masking-suspicious-literal", literal.node);
      }
    }
  }

  // ── masking: invisible / bidi characters (eslint-plugin-security) ──
  for (const match of code.matchAll(BIDI_CHARACTERS)) {
    emitAtIndex("masking-bidi-characters", match.index ?? 0);
  }
  for (const match of code.matchAll(INVISIBLE_CHARACTERS)) {
    emitAtIndex("masking-invisible-characters", match.index ?? 0);
  }

  // ── obfuscation: identifier length statistics ──
  const totalIdentifiers = ctx.identifierStats.length;
  if (totalIdentifiers >= SHORT_IDENTIFIER_MIN_OCCURRENCES) {
    const shortIdentifiers = ctx.identifierStats.filter((identifier) => identifier.name.length === 1);
    if (
      shortIdentifiers.length > 0 &&
      shortIdentifiers.length / totalIdentifiers >= SHORT_IDENTIFIER_FRACTION
    ) {
      emitAtNode("obfuscation-short-identifiers", shortIdentifiers[0]);
    }
  }

  // ── obfuscation: known tool signatures (per name+line, not per occurrence) ──
  const signatureSeen = new Set<string>();
  for (const identifier of ctx.identifierStats) {
    if (!OBFUSCATOR_HEX_IDENTIFIER.test(identifier.name) && !DOLLAR_UNDERSCORE_SOUP.test(identifier.name)) {
      continue;
    }
    const line = identifier.loc?.start.line ?? 0;
    if (signatureSeen.has(`${identifier.name}:${line}`)) continue;
    signatureSeen.add(`${identifier.name}:${line}`);
    emitAtNode("obfuscation-known-signature", identifier);
  }
  for (const literal of ctx.stringLiterals) {
    if (JSFUCK_LITERAL.test(literal.value)) emitAtNode("obfuscation-known-signature", literal.node);
  }

  findings.sort(
    (a, b) => a.line - b.line || (a.col ?? 0) - (b.col ?? 0) || a.ruleId.localeCompare(b.ruleId),
  );
  return findings;
}
