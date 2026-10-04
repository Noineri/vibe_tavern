/**
 * Macro engine with tokenizer + recursive descent parser.
 *
 * Supports:
 *   {{name}}                     — simple macro
 *   {{name::arg1::arg2}}         — macro with arguments
 *   {{// comment}}               — comment (stripped)
 *   {{setvar::name::value}}      — set local variable
 *   {{getvar::name}}             — get local variable
 *   {{addvar::name::value}}      — add to variable
 *   {{incvar::name}}             — increment numeric variable
 *   {{decvar::name}}             — decrement numeric variable
 *   {{hasvar::name}}             — check if variable exists
 *   {{deletevar::name}}          — delete variable
 *   {{random::a::b::c}}          — random choice
 *   {{roll::1d20}}               — dice roll
 *   {{if condition}}...{{else}}...{{/if}}  — conditional block
 *   {{trim}}...{{/trim}}                   — trim scoped content
 *   <USER> / <BOT> / <CHAR>      — legacy markers
 *
 * Variable state persists across all resolve() calls on the same engine
 * instance within one prompt assembly pass.
 */

import type { PromptVariableContext } from "./prompt-variable-context.js";
import type { PronounForms } from "@vibe-tavern/domain";
import { resolvePronounForms } from "./pronoun-forms.js";
import { createRandomMacroResolvers } from "./random-macro-resolvers.js";
import { splitMacroArgs } from "./macro-argument-parser.js";
import { findTrimClose, removeTrimmedLineBreaks, TRIM_LINE_BREAK_MARKER } from "./macro-trim.js";
import { MacroVariableScope } from "./macro-variable-scope.js";
import { createVariableMacroResolvers, resolveVariableShorthand } from "./variable-macro-resolvers.js";
import { registerCharacterMacroResolvers } from "./macro-character-resolvers.js";
export { getMacroCatalog } from "./macro-catalog.js";

/** Macro resolvers whose values are frozen when a greeting or user message is written. */
export const VOLATILE_MACRO_NAMES = new Set([
  "random", "pick", "roll", "time", "date", "weekday", "isotime", "isodate",
  "datetimeformat", "idleduration", "timediff",
]);

// ─── Types ─────────────────────────────────────────────────────────────

export interface MacroResolutionState {
  didUseOriginal: boolean;
}

/**
 * Catalog grouping for a macro. A resolver without a category is treated as
 * internal (e.g. `banned`, collected for logit bias) and excluded from the
 * user-facing catalog / autocomplete.
 */
export const MacroCategory = {
  Identity: "identity",
  Pronouns: "pronouns",
  Character: "character",
  Chat: "chat",
  Runtime: "runtime",
  Time: "time",
  Utility: "utility",
  Variables: "variables",
  Random: "random",
} as const;
export type MacroCategory = (typeof MacroCategory)[keyof typeof MacroCategory];

export interface MacroResolver {
  name: string;
  aliases?: readonly string[];
  /** Human-readable description for the macro catalog / autocomplete picker. */
  description?: string;
  /** Catalog grouping; omit only for internal resolvers (excluded from catalog). */
  category?: MacroCategory;
  /**
   * Resolve this macro. Args are the ::-separated arguments (name excluded).
   * resolveNested can be called to resolve nested macros in a string. sourceOffset
   * is the macro's character offset in the source text being resolved.
   */
  resolve: (
    args: string[],
    context: PromptVariableContext,
    state: MacroResolutionState,
    variables: MacroVariableScope,
    resolveNested: (text: string) => string,
    sourceOffset: number,
  ) => string;
}

/** A displayable entry in the macro catalog (autocomplete / co-author subset). */
export interface MacroCatalogEntry {
  /** Canonical name — the inserted text is always `{{name}}`. */
  name: string;
  aliases: readonly string[];
  description: string;
  category: MacroCategory;
}

// ─── Tokenizer ─────────────────────────────────────────────────────────

type TokenType = "text" | "macro" | "ifOpen" | "else" | "ifClose" | "trimClose";

interface Token {
  type: TokenType;
  /** Raw text for text tokens, macro name for macro tokens, raw inner for if/else/close. */
  value: string;
  /** Args for macro tokens (split by ::). */
  args: string[];
  /** Original text span in input (for reconstruction). */
  raw: string;
  /** Character offset of the token's opening delimiter in its source text. */
  offset?: number;
}

/**
 * Tokenize input into text, macro, if/else/ifClose tokens.
 *
 * Handles:
 *   {{name}} or {{name::arg1::arg2}}  → macro token
 *   {{if condition}}                   → ifOpen token (condition = args[0])
 *   {{if::condition}}                  → ifOpen token (condition = args[0])
 *   {{else}}                           → else token
 *   {{/if}}                            → ifClose token
 *   {{// ...}}                         → stripped (empty text token)
 *   <USER>, <BOT>, <CHAR>             → macro token
 *   everything else                    → text token
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  // Legacy marker regex — simple, no nesting issues
  const legacyRe = /<(USER|BOT|CHAR)>/gi;

  while (pos < input.length) {
    // Check for legacy markers at current position
    const remaining = input.slice(pos);
    const legacyMatch = legacyRe.exec(remaining);

    // Check for {{ — possible macro start
    const curlyStart = remaining.indexOf("{{");

    // Determine what comes first
    const legacyIdx = legacyMatch ? legacyMatch.index : Infinity;

    if (curlyStart === -1 && legacyIdx === Infinity) {
      // No more macros — rest is text
      if (pos < input.length) {
        tokens.push({ type: "text", value: remaining, args: [], raw: remaining });
      }
      break;
    }

    // If legacy marker comes first (or only option)
    if (legacyIdx < (curlyStart === -1 ? Infinity : curlyStart)) {
      // Text before legacy marker
      if (legacyIdx > 0) {
        tokens.push({ type: "text", value: remaining.slice(0, legacyIdx), args: [], raw: remaining.slice(0, legacyIdx) });
      }
      const name = legacyMatch![1].toLowerCase();
      tokens.push({ type: "macro", value: name === "bot" ? "char" : name, args: [], raw: legacyMatch![0] });
      pos += legacyIdx + legacyMatch![0].length;
      legacyRe.lastIndex = 0;
      continue;
    }

    // If {{ comes first
    if (curlyStart === -1) break; // shouldn't happen but safety

    // Text before {{
    if (curlyStart > 0) {
      tokens.push({ type: "text", value: remaining.slice(0, curlyStart), args: [], raw: remaining.slice(0, curlyStart) });
      pos += curlyStart;
    }

    // Find matching }} — but count nested {{ }} pairs
    const innerStart = pos + 2;
    let depth = 1;
    let scan = innerStart;
    while (scan < input.length && depth > 0) {
      if (input[scan] === "{" && scan + 1 < input.length && input[scan + 1] === "{") {
        depth++;
        scan += 2;
      } else if (input[scan] === "}" && scan + 1 < input.length && input[scan + 1] === "}") {
        depth--;
        if (depth === 0) break;
        scan += 2;
      } else {
        scan++;
      }
    }

    if (depth > 0) {
      // No matching }} — treat as text
      tokens.push({ type: "text", value: "{{", args: [], raw: "{{" });
      pos += 2;
      continue;
    }

    // Extract inner content
    const inner = input.slice(innerStart, scan);
    const macroOffset = pos;
    const fullMatch = input.slice(pos, scan + 2);
    pos = scan + 2;

    // Comment: {{// ...}}
    if (inner.startsWith("//")) {
      continue;
    }

    // {{/trim}}
    if (inner.trim() === "/trim") {
      tokens.push({ type: "trimClose", value: "/trim", args: [], raw: fullMatch });
      continue;
    }

    // {{/if}}
    if (inner.trim() === "/if") {
      tokens.push({ type: "ifClose", value: "/if", args: [], raw: fullMatch });
      continue;
    }

    // {{else}}
    if (inner.trim() === "else") {
      tokens.push({ type: "else", value: "else", args: [], raw: fullMatch });
      continue;
    }

    // {{if condition}} or {{if::condition}}
    const ifMatch = inner.match(/^\s*if(?:::?\s*|\s+)(.*)/i);
    if (ifMatch) {
      const condition = ifMatch[1].trim();
      tokens.push({ type: "ifOpen", value: "if", args: [condition], raw: fullMatch, offset: macroOffset });
      continue;
    }

    // Regular macro: {{name}} or {{name::arg1::arg2}} or {{name:arg1,arg2}}
    const parts = splitMacroArgs(inner);
    tokens.push({ type: "macro", value: parts[0], args: parts.slice(1), raw: fullMatch, offset: macroOffset });
  }

  return tokens;
}

/**
 * Extract the distinct macro names appearing in `input`, reusing the canonical
 * tokenizer so the result matches what the engine would actually resolve.
 * Returns only "macro" tokens (named resolvers) — the tokenizer already skips
 * comments (`{{// ...}}`) and control-flow (`if`/`else`/`/if`) is emitted as
 * separate token types, so neither appears here. Used by the Co-Author apply
 * path (B5) to flag macros the model emitted outside the safe reusable subset.
 */
export function extractMacroNames(input: string): string[] {
  const names = new Set<string>();
  for (const t of tokenize(input)) {
    if (t.type === "macro") names.add(t.value);
  }
  return [...names];
}

// ─── AST Nodes ──────────────────────────────────────────────────────────

interface TextNode { kind: "text"; value: string }
interface MacroNode { kind: "macro"; name: string; args: string[]; raw: string; offset: number }
interface IfNode {
  kind: "if";
  condition: string;
  thenBranch: AstNode[];
  elseBranch: AstNode[] | null;
}

interface TrimNode {
  kind: "trim";
  content: AstNode[];
  openRaw: string;
  closeRaw: string;
}

type AstNode = TextNode | MacroNode | IfNode | TrimNode;

// ─── Parser ─────────────────────────────────────────────────────────────

/**
 * Parse flat token list into AST, handling if/else/ifClose nesting.
 */
function parse(tokens: Token[], start: number, end: number): AstNode[] {
  const nodes: AstNode[] = [];
  let i = start;

  while (i < end) {
    const token = tokens[i];

    if (token.type === "text") {
      nodes.push({ kind: "text", value: token.value });
      i++;
    } else if (token.type === "macro") {
      const name = normalizeName(token.value);
      if (name === "trim") {
        const trimClose = findTrimClose(tokens, i + 1, end);
        if (trimClose !== -1) {
          nodes.push({
            kind: "trim",
            content: parse(tokens, i + 1, trimClose),
            openRaw: token.raw,
            closeRaw: tokens[trimClose].raw,
          });
          i = trimClose + 1;
          continue;
        }
      }
      nodes.push({ kind: "macro", name, args: token.args, raw: token.raw, offset: token.offset ?? 0 });
      i++;
    } else if (token.type === "ifOpen") {
      // Find matching else and /if
      const { ifClose, elsePos } = findIfPair(tokens, i + 1, end);
      if (ifClose === -1) {
        // No matching /if — treat as text
        nodes.push({ kind: "text", value: token.raw });
        i++;
      } else {
        const thenEnd = elsePos !== -1 ? elsePos : ifClose;
        const thenBranch = parse(tokens, i + 1, thenEnd);
        let elseBranch: AstNode[] | null = null;
        if (elsePos !== -1) {
          elseBranch = parse(tokens, elsePos + 1, ifClose);
        }
        nodes.push({ kind: "if", condition: token.args[0], thenBranch, elseBranch });
        i = ifClose + 1;
      }
    } else if (token.type === "else" || token.type === "ifClose" || token.type === "trimClose") {
      // These are handled by the ifOpen parser — shouldn't be reached at top level.
      // Treat as text.
      nodes.push({ kind: "text", value: token.raw });
      i++;
    } else {
      i++;
    }
  }

  return nodes;
}

/**
 * Find the matching else and /if for an ifOpen at position `from`.
 * Returns { elsePos: index of else or -1, ifClose: index of /if }.
 */
function findIfPair(tokens: Token[], from: number, end: number): { elsePos: number; ifClose: number } {
  let depth = 0;
  let elsePos = -1;

  for (let i = from; i < end; i++) {
    const t = tokens[i];
    if (t.type === "ifOpen") {
      depth++;
    } else if (t.type === "ifClose") {
      if (depth === 0) {
        return { elsePos, ifClose: i };
      }
      depth--;
    } else if (t.type === "else" && depth === 0 && elsePos === -1) {
      elsePos = i;
    }
  }

  // No matching /if found
  return { elsePos: -1, ifClose: -1 };
}

// ─── Evaluator ──────────────────────────────────────────────────────────

function evaluate(
  nodes: AstNode[],
  resolvers: Map<string, MacroResolver>,
  context: PromptVariableContext,
  state: MacroResolutionState,
  variables: MacroVariableScope,
  resolveNested: (text: string) => string,
  shouldResolve: ((resolver: MacroResolver) => boolean) | undefined,
): string {
  let result = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        result += node.value;
        break;
      case "macro":
        result += resolveMacro(node.name, node.args, node.raw, node.offset, resolvers, context, state, variables, resolveNested, shouldResolve);
        break;
      case "if": {
        // Resolve the condition first
        const rawCondition = resolveNested(node.condition);
        const negate = rawCondition.startsWith("!");
        const condition = negate ? rawCondition.slice(1).trim() : rawCondition;
        const variableCondition = resolveVariableShorthand(condition, [], variables);
        const resolvedCondition = variableCondition ?? condition;
        let isTruthy = resolvedCondition !== "" && !isFalseBoolean(resolvedCondition);
        if (negate) isTruthy = !isTruthy;
        if (isTruthy) {
          result += evaluate(node.thenBranch, resolvers, context, state, variables, resolveNested, shouldResolve);
        } else if (node.elseBranch) {
          result += evaluate(node.elseBranch, resolvers, context, state, variables, resolveNested, shouldResolve);
        }
        break;
      }
      case "trim": {
        const resolver = resolvers.get("trim");
        const content = evaluate(node.content, resolvers, context, state, variables, resolveNested, shouldResolve);
        if (resolver && shouldResolve && !shouldResolve(resolver)) {
          result += `${node.openRaw}${content}${node.closeRaw}`;
        } else {
          result += content.trim();
        }
        break;
      }
    }
  }
  return result;
}

function resolveMacro(
  name: string,
  args: string[],
  raw: string,
  offset: number,
  resolvers: Map<string, MacroResolver>,
  context: PromptVariableContext,
  state: MacroResolutionState,
  variables: MacroVariableScope,
  resolveNested: (text: string) => string,
  shouldResolve: ((resolver: MacroResolver) => boolean) | undefined,
): string {
  const resolver = resolvers.get(name);
  if (!resolver) {
    // Selective volatile resolution must leave shorthand live in stored
    // messages, just like named non-volatile variable macros.
    if (shouldResolve && /^[.$][A-Za-z_]/.test(name)) return raw;
    const shorthand = resolveVariableShorthand(name, args, variables);
    if (shorthand != null) return shorthand;
    // Space-separated arguments cannot be distinguished from an unknown macro
    // name after parsing. Preserve the original literal form for that syntax.
    if (/^\{\{\s*[^\s:]+\s+/.test(raw)) return raw;
    // Unknown macro — resolve any nested macros in args, then reconstruct
    const resolvedArgs = args.map(resolveNested);
    if (resolvedArgs.length === 0) {
      return `{{${name}}}`;
    }
    return `{{${name}::${resolvedArgs.join("::")}}}`;
  }

  if (shouldResolve && !shouldResolve(resolver)) return raw;

  // Resolve nested macros in args before passing to resolver
  const resolvedArgs = args.map(resolveNested);
  return resolver.resolve(resolvedArgs, context, state, variables, resolveNested, offset);
}

function isFalseBoolean(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return lower === "false" || lower === "0" || lower === "off" || lower === "no";
}

// ─── MacroEngine ────────────────────────────────────────────────────────

export class MacroEngine {
  private readonly resolvers = new Map<string, MacroResolver>();

  constructor(private readonly variableScope = new MacroVariableScope()) {}

  register(resolver: MacroResolver): this {
    this.resolvers.set(normalizeName(resolver.name), resolver);
    for (const alias of resolver.aliases ?? []) {
      this.resolvers.set(normalizeName(alias), resolver);
    }
    return this;
  }

  /**
   * Resolve all macros in the input text.
   * Variables are shared across calls on this engine instance.
   */
  resolve(text: string, context: PromptVariableContext): string {
    return this.resolveWith(text, context);
  }

  /** Resolve only resolvers selected by name, preserving all other macro text verbatim. */
  resolveSelected(text: string, context: PromptVariableContext, names: ReadonlySet<string>): string {
    return this.resolveWith(text, context, (resolver) => names.has(normalizeName(resolver.name)));
  }

  private resolveWith(
    text: string,
    context: PromptVariableContext,
    shouldResolve?: (resolver: MacroResolver) => boolean,
  ): string {
    if (!text) return text;

    const state: MacroResolutionState = { didUseOriginal: false };
    const variables = this.variableScope;

    // Recursive resolve — used for nested content
    const resolveNested = (t: string): string => {
      if (!t) return t;
      const tokens = tokenize(t);
      const ast = parse(tokens, 0, tokens.length);
      return evaluate(ast, this.resolvers, context, state, variables, resolveNested, shouldResolve);
    };

    const tokens = tokenize(text);
    const ast = parse(tokens, 0, tokens.length);
    return removeTrimmedLineBreaks(evaluate(ast, this.resolvers, context, state, variables, resolveNested, shouldResolve));
  }

  /** Reset variable state. Call between prompt assembly passes. */
  resetVariables(): void {
    this.variableScope.reset();
  }

  /**
   * Build the displayable macro catalog from registered resolvers. Aliases map
   * to the same resolver, so entries are de-duplicated by canonical name.
   * Resolvers without a `category` (internal) are excluded.
   */
  catalog(): MacroCatalogEntry[] {
    const seen = new Map<string, MacroResolver>();
    for (const resolver of this.resolvers.values()) {
      const key = normalizeName(resolver.name);
      if (!seen.has(key)) seen.set(key, resolver);
    }
    const entries: MacroCatalogEntry[] = [];
    for (const resolver of seen.values()) {
      if (resolver.category == null) continue;
      entries.push({
        name: resolver.name,
        aliases: resolver.aliases ?? [],
        description: resolver.description ?? "",
        category: resolver.category,
      });
    }
    return entries;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

const normalizeName = (name: string): string => name.toLowerCase();

const firstDefined = (...values: Array<string | number | null | undefined>): string | number | null | undefined => {
  for (const value of values) {
    if (value != null) return value;
  }
  return undefined;
};

// ─── Built-in Macro Registrations ───────────────────────────────────────

export function createPhaseOneMacroEngine(variableScope?: MacroVariableScope): MacroEngine {
  return new MacroEngine(variableScope)

    // ─── Identity / Context ───────────────────────────────────────────

    .register({
      name: "user",
      aliases: ["<USER>"],
      resolve: () => "", // Overridden below with context
    })
    .register({
      name: "char",
      aliases: ["<CHAR>", "<BOT>"],
      resolve: () => "",
    });
}

/**
 * Create the full macro engine with all built-in macros.
 * This replaces createPhaseOneMacroEngine for the new parser.
 */
export function createFullMacroEngine(variableScope?: MacroVariableScope): MacroEngine {
  const engine = new MacroEngine(variableScope);

  // ─── Identity ──────────────────────────────────────────────────────

  engine.register({
    name: "user",
    aliases: ["<USER>"],
    description: "The user/persona name.",
    category: MacroCategory.Identity,
    resolve: (_args, context) => context.names.userName ?? "User",
  });

  engine.register({
    name: "char",
    aliases: ["<CHAR>", "<BOT>"],
    description: "The character name.",
    category: MacroCategory.Identity,
    resolve: (_args, context) => context.names.charName ?? "Assistant",
  });

  engine.register({
    name: "persona",
    description: "The active persona's description.",
    category: MacroCategory.Identity,
    resolve: (_args, context) => context.persona.description ?? "",
  });

  // ─── Pronoun declensions (VT-native) ────────────────────────────────────
  // Custom forms come from persona.pronounForms; presets resolve via PRESET_PRONOUN_FORMS.
  // When neither is set (no persona / unrecognized string), they expand to empty.
  const pronounField = (field: keyof PronounForms) => (_args: string[], context: PromptVariableContext): string =>
    resolvePronounForms(context.persona)?.[field] ?? "";

  engine.register({
    name: "sub",
    description: "Subjective pronoun — she / he / they.",
    category: MacroCategory.Pronouns,
    resolve: pronounField("subjective"),
  });
  engine.register({
    name: "obj",
    description: "Objective pronoun — her / him / them.",
    category: MacroCategory.Pronouns,
    resolve: pronounField("objective"),
  });
  engine.register({
    name: "poss",
    description: "Possessive determiner — her / his / their.",
    category: MacroCategory.Pronouns,
    resolve: pronounField("possessive"),
  });
  engine.register({
    name: "poss_p",
    description: "Possessive pronoun — hers / his / theirs.",
    category: MacroCategory.Pronouns,
    resolve: pronounField("possessivePronoun"),
  });
  engine.register({
    name: "ref",
    description: "Reflexive pronoun — herself / himself / themself.",
    category: MacroCategory.Pronouns,
    resolve: pronounField("reflexive"),
  });

  // ─── Pronoun declensions (ST-extension compat) ────────────────────────────
  // Mirror of Wolfsblvt's "SillyTavern-Pronouns" extension macros so prompts/
  // cards authored against it resolve identically in VT. Same PronounForms
  // data, different macro surface. Shorthand aliases ({{she}}, {{him}}, ...) are
  // intentionally omitted: they're off by default in the extension and ambiguous
  // (e.g. {{his}} = possessive pronoun, not determiner). See pronoun-forms.ts.
  engine.register({
    name: "pronoun.subjective",
    description: "SillyTavern-Pronouns extension form (subjective).",
    category: MacroCategory.Pronouns,
    resolve: pronounField("subjective"),
  });
  engine.register({
    name: "pronoun.objective",
    description: "SillyTavern-Pronouns extension form (objective).",
    category: MacroCategory.Pronouns,
    resolve: pronounField("objective"),
  });
  engine.register({
    name: "pronoun.pos_det",
    description: "SillyTavern-Pronouns extension form (possessive determiner).",
    category: MacroCategory.Pronouns,
    resolve: pronounField("possessive"),
  });
  engine.register({
    name: "pronoun.pos_pro",
    description: "SillyTavern-Pronouns extension form (possessive pronoun).",
    category: MacroCategory.Pronouns,
    resolve: pronounField("possessivePronoun"),
  });
  engine.register({
    name: "pronoun.reflexive",
    description: "SillyTavern-Pronouns extension form (reflexive).",
    category: MacroCategory.Pronouns,
    resolve: pronounField("reflexive"),
  });

  engine.register({
    name: "group",
    description: "The group-chat name (empty outside group chats).",
    category: MacroCategory.Identity,
    resolve: (_args, context) => context.names.groupName ?? "",
  });

  engine.register({
    name: "charIfNotGroup",
    description: "Character name, blanked in a group-chat context.",
    category: MacroCategory.Identity,
    resolve: (_args, context) => context.names.charIfNotGroup ?? context.names.charName ?? "Assistant",
  });

  // ─── Character fields ──────────────────────────────────────────────

  registerCharacterMacroResolvers(engine.register.bind(engine), MacroCategory);

  // ─── Chat context ──────────────────────────────────────────────────

  engine.register({
    name: "lastChatMessage",
    aliases: ["lastMessage"],
    description: "The last message in the chat (any role).",
    category: MacroCategory.Chat,
    resolve: (_args, context) => context.chat.lastMessage ?? "",
  });

  engine.register({
    name: "lastUserMessage",
    description: "The last user message.",
    category: MacroCategory.Chat,
    resolve: (_args, context) => context.chat.lastUserMessage ?? "",
  });

  engine.register({
    name: "lastCharMessage",
    description: "The last character message.",
    category: MacroCategory.Chat,
    resolve: (_args, context) => context.chat.lastCharMessage ?? "",
  });

  engine.register({
    name: "summary",
    description: "The current chat summary.",
    category: MacroCategory.Chat,
    resolve: (_args, context) => context.prompt.summary ?? "",
  });

  // ─── Runtime ───────────────────────────────────────────────────────

  engine.register({
    name: "model",
    description: "The active model id.",
    category: MacroCategory.Runtime,
    resolve: (_args, context) => context.runtime.model ?? "",
  });

  engine.register({
    name: "maxPrompt",
    aliases: ["maxPromptTokens"],
    description: "Max prompt-token budget.",
    category: MacroCategory.Runtime,
    resolve: (_args, context) => String(firstDefined(context.runtime.maxPromptTokens, context.prompt.contextBudget, context.runtime.contextBudget) ?? ""),
  });

  engine.register({
    name: "maxContext",
    aliases: ["maxContextTokens"],
    description: "Max context-window tokens.",
    category: MacroCategory.Runtime,
    resolve: (_args, context) => String(firstDefined(context.runtime.contextBudget, context.prompt.contextBudget) ?? ""),
  });

  engine.register({
    name: "maxResponse",
    aliases: ["maxResponseTokens"],
    description: "Max response tokens.",
    category: MacroCategory.Runtime,
    resolve: (_args, context) => String(firstDefined(context.runtime.maxResponseTokens, context.prompt.maxResponseTokens) ?? ""),
  });

  // ─── Time ──────────────────────────────────────────────────────────

  engine.register({
    name: "time",
    description: "Current local time (e.g. 10:30 PM).",
    category: MacroCategory.Time,
    resolve: (_args, context) => context.time.time,
  });
  engine.register({
    name: "date",
    description: "Current local date.",
    category: MacroCategory.Time,
    resolve: (_args, context) => context.time.date,
  });
  engine.register({
    name: "weekday",
    description: "Current weekday name.",
    category: MacroCategory.Time,
    resolve: (_args, context) => context.time.weekday,
  });
  engine.register({
    name: "isotime",
    description: "Current ISO 8601 time.",
    category: MacroCategory.Time,
    resolve: (_args, context) => context.time.isotime,
  });
  engine.register({
    name: "isodate",
    description: "Current ISO 8601 date.",
    category: MacroCategory.Time,
    resolve: (_args, context) => context.time.isodate,
  });

  // ─── Utility ───────────────────────────────────────────────────────

  engine.register({
    name: "newline",
    description: "Insert a line break.",
    category: MacroCategory.Utility,
    resolve: (_args) => "\n",
  });

  engine.register({
    name: "space",
    description: "Insert N spaces (default 1): {{space::3}}.",
    category: MacroCategory.Utility,
    resolve: (args) => " ".repeat(Math.max(1, parseInt(args[0] || "1", 10))),
  });

  engine.register({
    name: "noop",
    description: "Resolves to nothing (strips itself).",
    category: MacroCategory.Utility,
    resolve: () => "",
  });

  engine.register({
    name: "trim",
    description: "Remove surrounding line breaks, or trim scoped content.",
    category: MacroCategory.Utility,
    resolve: () => TRIM_LINE_BREAK_MARKER,
  });

  engine.register({
    name: "outlet",
    description: "Activated lore outlet text: {{outlet::name}}.",
    category: MacroCategory.Utility,
    resolve: (args, context) => {
      const name = args[0]?.trim() ?? "";
      if (!name) return "";
      // Lore activation resolves its own content before all outlet groups are
      // known. Its scoped first pass preserves this macro for the resolver's
      // outlet-only follow-up; every ordinary macro context follows ST and
      // resolves a missing outlet to an empty string.
      if (context.preserveOutletMacros) return `{{outlet::${args.join("::")}}}`;
      return context.outlets?.[name] ?? "";
    },
  });

  engine.register({
    name: "original",
    description: "The swapped-out original text (emitted once per pass).",
    category: MacroCategory.Utility,
    resolve: (_args, context, state) => {
      if (state.didUseOriginal) return "";
      state.didUseOriginal = true;
      return context.prompt.original ?? "";
    },
  });

  // ─── Variables (local and global, per-assembly) ─────────────────────

  for (const resolver of createVariableMacroResolvers()) engine.register(resolver);

  // ─── Random ────────────────────────────────────────────────────────

  for (const resolver of createRandomMacroResolvers()) engine.register(resolver);

  // ─── Banned words (collected for logit bias) ───────────────────────

  const bannedWords: string[] = [];
  engine.register({
    name: "banned",
    resolve: (args) => {
      const word = (args[0] ?? "").replace(/^"|"$/g, "");
      if (word) bannedWords.push(word);
      return "";
    },
  });

  return engine;
}
