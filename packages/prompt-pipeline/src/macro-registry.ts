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
 *   <USER> / <BOT> / <CHAR>      — legacy markers
 *
 * Variable state persists across all resolve() calls on the same engine
 * instance within one prompt assembly pass.
 */

import type { PromptVariableContext } from "./prompt-variable-context.js";
import type { PronounForms } from "@vibe-tavern/domain";
import { resolvePronounForms } from "./pronoun-forms.js";

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
   * resolveNested can be called to resolve nested macros in a string.
   */
  resolve: (
    args: string[],
    context: PromptVariableContext,
    state: MacroResolutionState,
    variables: Map<string, string>,
    resolveNested: (text: string) => string,
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

type TokenType = "text" | "macro" | "ifOpen" | "else" | "ifClose";

interface Token {
  type: TokenType;
  /** Raw text for text tokens, macro name for macro tokens, raw inner for if/else/close. */
  value: string;
  /** Args for macro tokens (split by ::). */
  args: string[];
  /** Original text span in input (for reconstruction). */
  raw: string;
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
    const fullMatch = input.slice(pos, scan + 2);
    pos = scan + 2;

    // Comment: {{// ...}}
    if (inner.startsWith("//")) {
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
      tokens.push({ type: "ifOpen", value: "if", args: [condition], raw: fullMatch });
      continue;
    }

    // Regular macro: {{name}} or {{name::arg1::arg2}} or {{name:arg1,arg2}}
    const parts = splitMacroArgs(inner);
    tokens.push({ type: "macro", value: parts[0], args: parts.slice(1), raw: fullMatch });
  }

  return tokens;
}

/**
 * Split macro inner text by :: separator.
 * "setvar::x::hello world" → ["setvar", "x", "hello world"]
 * Also handles single : for legacy syntax: "random:a,b,c" → ["random", "a,b,c"]
 * Respects escaped colons \:
 */
function splitMacroArgs(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\" && i + 1 < inner.length && inner[i + 1] === ":") {
      current += ":";
      i += 2;
    } else if (inner[i] === ":" && i + 1 < inner.length && inner[i + 1] === ":") {
      parts.push(current.trim());
      current = "";
      i += 2;
    } else {
      current += inner[i];
      i++;
    }
  }
  // If we have accumulated content and there was a single : before it
  // (legacy format like "random:a,b,c")
  const trimmed = current.trim();
  // Check for legacy single-colon syntax: name:value
  if (parts.length === 0) {
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      // "random:a,b,c" → ["random", "a,b,c"]
      // But only if the part before : looks like a macro name
      const possibleName = trimmed.slice(0, colonIdx).trim();
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(possibleName)) {
        return [possibleName, trimmed.slice(colonIdx + 1).trim()];
      }
    }
  }
  parts.push(trimmed);
  return parts;
}

// ─── AST Nodes ──────────────────────────────────────────────────────────

interface TextNode { kind: "text"; value: string }
interface MacroNode { kind: "macro"; name: string; args: string[] }
interface IfNode {
  kind: "if";
  condition: string;
  thenBranch: AstNode[];
  elseBranch: AstNode[] | null;
}

type AstNode = TextNode | MacroNode | IfNode;

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
      nodes.push({ kind: "macro", name: normalizeName(token.value), args: token.args });
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
    } else if (token.type === "else" || token.type === "ifClose") {
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
  variables: Map<string, string>,
  resolveNested: (text: string) => string,
): string {
  let result = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        result += node.value;
        break;
      case "macro":
        result += resolveMacro(node.name, node.args, resolvers, context, state, variables, resolveNested);
        break;
      case "if": {
        // Resolve the condition first
        const rawCondition = resolveNested(node.condition);
        const negate = rawCondition.startsWith("!");
        const condition = negate ? rawCondition.slice(1).trim() : rawCondition;
        let isTruthy = condition !== "" && !isFalseBoolean(condition);
        if (negate) isTruthy = !isTruthy;
        if (isTruthy) {
          result += evaluate(node.thenBranch, resolvers, context, state, variables, resolveNested);
        } else if (node.elseBranch) {
          result += evaluate(node.elseBranch, resolvers, context, state, variables, resolveNested);
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
  resolvers: Map<string, MacroResolver>,
  context: PromptVariableContext,
  state: MacroResolutionState,
  variables: Map<string, string>,
  resolveNested: (text: string) => string,
): string {
  const resolver = resolvers.get(name);
  if (!resolver) {
    // Unknown macro — resolve any nested macros in args, then reconstruct
    const resolvedArgs = args.map(resolveNested);
    if (resolvedArgs.length === 0) {
      return `{{${name}}}`;
    }
    return `{{${name}::${resolvedArgs.join("::")}}}`;
  }

  // Resolve nested macros in args before passing to resolver
  const resolvedArgs = args.map(resolveNested);
  return resolver.resolve(resolvedArgs, context, state, variables, resolveNested);
}

function isFalseBoolean(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return lower === "false" || lower === "0" || lower === "off" || lower === "no";
}

// ─── MacroEngine ────────────────────────────────────────────────────────

export class MacroEngine {
  private readonly resolvers = new Map<string, MacroResolver>();

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
    if (!text) return text;

    const state: MacroResolutionState = { didUseOriginal: false };
    const variables = this.variables;

    // Recursive resolve — used for nested content
    const resolveNested = (t: string): string => {
      if (!t) return t;
      const tokens = tokenize(t);
      const ast = parse(tokens, 0, tokens.length);
      return evaluate(ast, this.resolvers, context, state, variables, resolveNested);
    };

    const tokens = tokenize(text);
    const ast = parse(tokens, 0, tokens.length);
    return evaluate(ast, this.resolvers, context, state, variables, resolveNested);
  }

  /** Shared variable state for this engine instance. */
  private readonly variables = new Map<string, string>();

  /** Reset variable state. Call between prompt assembly passes. */
  resetVariables(): void {
    this.variables.clear();
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

/**
 * The full macro catalog (all user-facing resolvers), derived from a fresh full
 * engine and cached (the registry is static after module load). Used by the
 * editor autocomplete and to derive the Co-Author's allowed subset.
 */
let macroCatalogCache: MacroCatalogEntry[] | null = null;
export function getMacroCatalog(): MacroCatalogEntry[] {
  if (macroCatalogCache == null) macroCatalogCache = createFullMacroEngine().catalog();
  return macroCatalogCache;
}

// ─── Helpers ────────────────────────────────────────────────────────────

const normalizeName = (name: string): string => name.toLowerCase();

const firstDefined = (...values: Array<string | number | null | undefined>): string | number | null | undefined => {
  for (const value of values) {
    if (value != null) return value;
  }
  return undefined;
};

// ─── Dice Roller ────────────────────────────────────────────────────────

/**
 * Roll dice: "1d20" → { rolls: [14], total: 14 }, "3d6+4" → { rolls: [3,5,2], total: 14 }
 */
function rollDice(formula: string): { total: number } | null {
  const match = formula.match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  const count = Math.max(1, parseInt(match[1] || "1", 10));
  const sides = parseInt(match[2], 10);
  const modifier = parseInt(match[3] || "0", 10);
  if (sides < 2 || count > 100) return null;

  let total = modifier;
  for (let i = 0; i < count; i++) {
    total += Math.floor(Math.random() * sides) + 1;
  }
  return { total };
}

// ─── Built-in Macro Registrations ───────────────────────────────────────

export function createPhaseOneMacroEngine(): MacroEngine {
  return new MacroEngine()

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
export function createFullMacroEngine(): MacroEngine {
  const engine = new MacroEngine();

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

  engine.register({
    name: "description",
    aliases: ["charDescription"],
    description: "The character's description field.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.description ?? "",
  });

  engine.register({
    name: "personality",
    aliases: ["charPersonality"],
    description: "The character's personality field.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.personality ?? "",
  });

  engine.register({
    name: "scenario",
    aliases: ["charScenario"],
    description: "The character's scenario field.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.scenario ?? "",
  });

  engine.register({
    name: "mesExamplesRaw",
    aliases: ["mesExamples"],
    description: "The character's example dialogue, raw text.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.mesExample ?? "",
  });

  engine.register({
    name: "charFirstMessage",
    aliases: ["greeting"],
    description: "The character's first message / greeting.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.firstMessage ?? "",
  });

  engine.register({
    name: "charCreatorNotes",
    aliases: ["creatorNotes"],
    description: "The character's creator notes.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.creatorNotes ?? "",
  });

  engine.register({
    name: "charDepthPrompt",
    description: "The character's depth-prompt.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.depthPrompt ?? "",
  });

  engine.register({
    name: "charVersion",
    aliases: ["version", "char_version"],
    description: "The character's version string.",
    category: MacroCategory.Character,
    resolve: (_args, context) => context.character.version?.title ?? "",
  });

  // ─── Chat context ──────────────────────────────────────────────────

  engine.register({
    name: "lastChatMessage",
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
    name: "original",
    description: "The swapped-out original text (emitted once per pass).",
    category: MacroCategory.Utility,
    resolve: (_args, context, state) => {
      if (state.didUseOriginal) return "";
      state.didUseOriginal = true;
      return context.prompt.original ?? "";
    },
  });

  // ─── Variables (local, per-assembly) ───────────────────────────────

  engine.register({
    name: "setvar",
    description: "Set a local variable: {{setvar::name::value}}.",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      const name = args[0] ?? "";
      const value = args[1] ?? "";
      if (name) variables.set(name, value);
      return "";
    },
  });

  engine.register({
    name: "getvar",
    description: "Read a local variable, with optional fallback: {{getvar::name::fallback}}.",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      const name = args[0] ?? "";
      const fallback = args[1] ?? "";
      if (!name) return fallback;
      return variables.has(name) ? (variables.get(name) ?? "") : fallback;
    },
  });

  engine.register({
    name: "addvar",
    description: "Append (or numerically add to) a local variable.",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      const name = args[0] ?? "";
      const value = args[1] ?? "";
      if (!name) return "";
      const existing = variables.get(name) ?? "0";
      const existingNum = Number(existing);
      const addNum = Number(value);
      if (!isNaN(existingNum) && !isNaN(addNum)) {
        variables.set(name, String(existingNum + addNum));
      } else {
        variables.set(name, existing + value);
      }
      return "";
    },
  });

  engine.register({
    name: "incvar",
    description: "Increment a numeric variable and emit the new value.",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      const name = args[0] ?? "";
      if (!name) return "0";
      const current = Number(variables.get(name) ?? "0");
      const next = current + 1;
      variables.set(name, String(next));
      return String(next);
    },
  });

  engine.register({
    name: "decvar",
    description: "Decrement a numeric variable and emit the new value.",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      const name = args[0] ?? "";
      if (!name) return "0";
      const current = Number(variables.get(name) ?? "0");
      const next = current - 1;
      variables.set(name, String(next));
      return String(next);
    },
  });

  engine.register({
    name: "hasvar",
    aliases: ["varexists"],
    description: "Whether a variable exists (true / false).",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      return variables.has(args[0] ?? "") ? "true" : "false";
    },
  });

  engine.register({
    name: "deletevar",
    aliases: ["flushvar"],
    description: "Delete a local variable.",
    category: MacroCategory.Variables,
    resolve: (args, _ctx, _state, variables) => {
      variables.delete(args[0] ?? "");
      return "";
    },
  });

  // ─── Random ────────────────────────────────────────────────────────

  engine.register({
    name: "random",
    description: "Pick one option at random: {{random::a::b::c}} or {{random:a,b,c}}.",
    category: MacroCategory.Random,
    resolve: (args) => {
      // {{random::a::b::c}} → args = ["a", "b", "c"]
      // {{random:a,b,c}} → args = ["a,b,c"] (legacy single-arg form)
      let items = args;
      if (args.length === 1 && args[0].includes(",")) {
        items = args[0].split(",").map(s => s.trim());
      }
      if (items.length === 0) return "";
      return items[Math.floor(Math.random() * items.length)];
    },
  });

  engine.register({
    name: "roll",
    description: "Roll dice and emit the total: {{roll::1d20}}, {{roll::3d6+2}}.",
    category: MacroCategory.Random,
    resolve: (args) => {
      const formula = args[0]?.trim() ?? "";
      if (!formula) return "";
      // "d20" → "1d20"
      const normalized = /^d\d+/i.test(formula) ? "1" + formula : formula;
      const result = rollDice(normalized);
      return result ? String(result.total) : "";
    },
  });

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
