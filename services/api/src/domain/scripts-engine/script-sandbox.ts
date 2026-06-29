import { runInNewContext } from "node:vm";

// ─── Input types ──────────────────────────────────────────────────────────

export interface ScriptInput {
  id: string;
  name: string;
  code: string;
  sortOrder: number;
}

export interface PersonaInput {
  /** Persona display name (the `{{user}}` identity). Read-only to scripts. */
  name: string;
  /** Persona description text. Read-only to scripts. */
  description: string;
}

export interface ScriptExecutionInput {
  /** Scripts to execute, sorted by sortOrder ascending */
  scripts: ScriptInput[];
  /** Chat context data */
  chat: {
    messages: Array<{ message: string; role: string }>;
  };
  /** Character data — personality and scenario are mutable */
  character: {
    name: string;
    personality: string;
    scenario: string;
  };
  /** Active lore entries from activation engine (read-only) */
  activeLoreEntries: Array<{
    title: string;
    content: string;
    keys: string[];
  }>;
  /** Persistent state per-chat, keyed by script ID */
  scriptState: Record<string, Record<string, unknown>>;
  /** Active persona (read-only to scripts). Optional — absent in tests that
   *  don't care about persona; resolver always passes the effective persona. */
  persona?: PersonaInput;
  /** Initial shared bucket for the turn. Optional — absent means a fresh `{}`.
   *  The bucket is turn-scoped: it is NOT persisted across turns (unlike
   *  `scriptState`). Exposed so tests can seed `context.shared`. */
  shared?: Record<string, unknown>;
}

export interface InjectedMessage {
  content: string;
  role: 'system' | 'user' | 'assistant';
}

export type ConsoleLevel = 'log' | 'warn' | 'error';

export interface ConsoleEntry {
  level: ConsoleLevel;
  /** Stringified args, joined by space — mirrors `console.log(a, b)` output. */
  args: string;
}

export type ScriptRunStatus = 'ran' | 'errored';

export interface ScriptRunResult {
  scriptId: string;
  scriptName: string;
  /** Outcome of this individual script within the turn. */
  status: ScriptRunStatus;
  /** Full `character.personality` value AFTER this script ran, or '' if the
   *  script did not mutate it. Lets the trace show what each script produced
   *  without diffing against the initial value at the UI layer. */
  personalityMutation: string;
  /** Full `character.scenario` value AFTER this script ran, or '' if unchanged. */
  scenarioMutation: string;
  /** Messages this specific script injected via `context.chat.injectMessage(...)`. */
  injectedMessages: InjectedMessage[];
  /** Console output captured from this script (P1). */
  console: ConsoleEntry[];
  /** Error message + source line, present only when `status === 'errored'`. */
  error?: string;
  line?: number;
}

export interface ScriptExecutionResult {
  /** Mutated character fields after all scripts ran */
  character: {
    personality: string;
    scenario: string;
  };
  /** Messages injected by scripts via context.chat.injectMessage() (aggregate) */
  injectedMessages: InjectedMessage[];
  /** Updated script state (to persist back to chat) */
  updatedScriptState: Record<string, Record<string, unknown>>;
  /** Errors per script (aggregate — kept for back-comat with the resolver) */
  errors: Array<{ scriptId: string; scriptName: string; error: string; line?: number }>;
  /** Per-script breakdown of the turn (P4). Order matches execution order. */
  scriptRuns: ScriptRunResult[];
  /** Final turn-scoped shared bucket (post all scripts). Turn-scoped; the
   *  resolver does NOT persist this. Surfaced for the test panel and trace. */
  shared: Record<string, unknown>;
}

// ─── Seeded PRNG (P7) ─────────────────────────────────────────────────────

/**
 * mulberry32 — a tiny deterministic PRNG. Seeded per turn from the message
 * count so that regenerating the same turn reproduces the same `context.random*`
 * sequence, while a new turn re-sows. Bare `Math.random` stays available in the
 * sandbox globals for scripts that explicitly want nondeterminism.
 */
function createSeededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Main execution function ──────────────────────────────────────────────

export function executeScripts(input: ScriptExecutionInput): ScriptExecutionResult {
  const { chat, character, activeLoreEntries, scriptState } = input;

  // Mutable state — scripts modify this in-place via context
  const mutableCharacter = {
    name: character.name,
    personality: character.personality,
    scenario: character.scenario,
  };

  const injectedMessages: InjectedMessage[] = [];
  const updatedScriptState: Record<string, Record<string, unknown>> = {};
  const errors: ScriptExecutionResult["errors"] = [];
  const scriptRuns: ScriptRunResult[] = [];

  // Turn-scoped shared bucket (P5): fresh per turn unless the caller seeded it.
  const sharedBucket: Record<string, unknown> = { ...(input.shared ?? {}) };

  // Seeded RNG (P7): turn index = message count. Reseed per executeScripts
  // call, shared across all scripts in the turn so they form one deterministic
  // sequence (script N's first roll depends on scripts 1..N-1's roll counts).
  const rng = createSeededRandom(chat.messages.length);

  for (const script of input.scripts) {
    // Initialize state bucket for this script
    const stateBucket: Record<string, unknown> = { ...(scriptState[script.id] ?? {}) };

    // Per-run trace accumulators
    const consoleBuffer: ConsoleEntry[] = [];
    const runInjected: InjectedMessage[] = [];
    const personalityBefore = mutableCharacter.personality;
    const scenarioBefore = mutableCharacter.scenario;

    // Build the context object with getter-based Janitor aliases
    const chatContext = buildChatContext(chat, injectedMessages, runInjected);
    const characterContext = buildCharacterContext(mutableCharacter);
    const loreContext = buildLoreContext(activeLoreEntries);
    const stateContext = buildStateContext(stateBucket);
    const sharedContext = buildSharedContext(sharedBucket);
    const personaContext = input.persona ? buildPersonaContext(input.persona) : null;
    const utilityContext = buildUtilityContext(rng);

    const consoleStub = {
      log: (...args: unknown[]) => { consoleBuffer.push({ level: 'log', args: stringifyArgs(args) }); },
      warn: (...args: unknown[]) => { consoleBuffer.push({ level: 'warn', args: stringifyArgs(args) }); },
      error: (...args: unknown[]) => { consoleBuffer.push({ level: 'error', args: stringifyArgs(args) }); },
    };

    const contextObj: Record<string, unknown> = {
      chat: chatContext,
      character: characterContext,
      lore: loreContext,
      state: stateContext,
      shared: sharedContext,
      ...utilityContext,
    };
    if (personaContext) contextObj.persona = personaContext;

    const sandbox = {
      context: contextObj,
      // Standard globals scripts might need
      Math,
      JSON,
      Date,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      Error,
      console: consoleStub,
    };

    let status: ScriptRunStatus = 'ran';
    let runError: { message: string; line?: number } | undefined;

    try {
      runInNewContext(script.code, sandbox, {
        timeout: 5000,
        filename: script.name,
      });

      // Persist state after successful execution
      updatedScriptState[script.id] = { ...stateBucket };
    } catch (err: unknown) {
      status = 'errored';
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const line = stack ? extractLineNumber(stack) : undefined;
      runError = { message, line };
      errors.push({
        scriptId: script.id,
        scriptName: script.name,
        error: message,
        line,
      });
      // Continue to next script — errors don't crash the pipeline
    }

    // Per-run mutation deltas (full value AFTER run if it changed, else '')
    const personalityAfter = mutableCharacter.personality;
    const scenarioAfter = mutableCharacter.scenario;
    scriptRuns.push({
      scriptId: script.id,
      scriptName: script.name,
      status,
      personalityMutation: personalityAfter !== personalityBefore ? personalityAfter : '',
      scenarioMutation: scenarioAfter !== scenarioBefore ? scenarioAfter : '',
      injectedMessages: runInjected,
      console: consoleBuffer,
      error: runError?.message,
      line: runError?.line,
    });
  }

  return {
    character: {
      personality: mutableCharacter.personality,
      scenario: mutableCharacter.scenario,
    },
    injectedMessages,
    updatedScriptState,
    errors,
    scriptRuns,
    shared: sharedBucket,
  };
}

// ─── Context builders ─────────────────────────────────────────────────────

function buildChatContext(
  chat: ScriptExecutionInput["chat"],
  injectedMessages: InjectedMessage[],
  runInjected: InjectedMessage[],
) {
  const messages = chat.messages;
  const ctx: Record<string, unknown> = {
    messages,
    injectMessage(content: string, role: 'system' | 'user' | 'assistant' = 'system') {
      const entry = { content, role };
      injectedMessages.push(entry);
      runInjected.push(entry);
    },
  };

  // Primary names
  Object.defineProperty(ctx, "lastMessage", {
    get() {
      return messages.at(-1)?.message ?? "";
    },
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(ctx, "messageCount", {
    get() {
      return messages.length;
    },
    enumerable: true,
    configurable: false,
  });

  // Janitor aliases (getter-based, no value duplication)
  // Use closure reference to ctx rather than `this` to avoid untyped access
  Object.defineProperty(ctx, "last_message", {
    get() {
      return messages.at(-1)?.message ?? "";
    },
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(ctx, "message_count", {
    get() {
      return messages.length;
    },
    enumerable: true,
    configurable: false,
  });
  // Janitor alias for injectMessage
  ctx.inject_message = ctx.injectMessage;

  return ctx;
}

function buildCharacterContext(character: {
  name: string;
  personality: string;
  scenario: string;
}) {
  return {
    name: character.name,
    get personality() {
      return character.personality;
    },
    set personality(val: string) {
      character.personality = val;
    },
    get scenario() {
      return character.scenario;
    },
    set scenario(val: string) {
      character.scenario = val;
    },
  };
}

function buildPersonaContext(persona: PersonaInput) {
  // Read-only and frozen — mirroring lore's protection. A script must not be
  // able to mutate the persona in a way that leaks into the prompt or other
  // scripts.
  return Object.freeze({
    name: persona.name,
    description: persona.description,
  });
}

function buildLoreContext(entries: ScriptExecutionInput["activeLoreEntries"]) {
  return {
    activeEntries: Object.freeze(
      entries.map((e) => Object.freeze({ ...e })),
    ),
  };
}

function buildStateContext(stateBucket: Record<string, unknown>) {
  return {
    // Map.get-style: returns `defaultValue` when the key is absent (undefined).
    // Without this, `state.get('hp', 100)` returns undefined on first read and
    // the HP-tracker template computes NaN. Mirrors the in-app API reference
    // (`context.state.get(key, default)`) and JS Map semantics.
    get(key: string, defaultValue?: unknown): unknown {
      const v = stateBucket[key];
      return v === undefined ? defaultValue : v;
    },
    set(key: string, value: unknown): void {
      stateBucket[key] = value;
    },
    increment(key: string, amount = 1): number {
      const current = (stateBucket[key] as number) ?? 0;
      const next = current + amount;
      stateBucket[key] = next;
      return next;
    },
  };
}

/**
 * Turn-scoped shared bucket (P5). Same shape as `context.state` but NOT
 * namespaced by script id and NOT persisted across turns. Intended for
 * cross-script communication within a single turn: script A writes, script B
 * (running later in the same turn) reads. Because it is order-dependent,
 * it ships together with the drag-reorder UI (`sortOrder` editor).
 *
 * Distinct from lorebook activation recursion: no auto-activation happens here,
 * this is plain turn-scoped memory.
 */
function buildSharedContext(sharedBucket: Record<string, unknown>) {
  return {
    get(key: string, defaultValue?: unknown): unknown {
      const v = sharedBucket[key];
      return v === undefined ? defaultValue : v;
    },
    set(key: string, value: unknown): void {
      sharedBucket[key] = value;
    },
    increment(key: string, amount = 1): number {
      const current = (sharedBucket[key] as number) ?? 0;
      const next = current + amount;
      sharedBucket[key] = next;
      return next;
    },
  };
}

function buildUtilityContext(rng: () => number) {
  return {
    random(): number {
      return rng();
    },
    randomInt(min: number, max: number): number {
      return Math.floor(rng() * (max - min + 1)) + min;
    },
    pick<T>(arr: T[]): T {
      return arr[Math.floor(rng() * arr.length)];
    },
    weightedPick(
      items: Array<{ weight: number } & Record<string, unknown>>,
    ): (typeof items)[number] {
      const total = items.reduce((sum, item) => sum + (item.weight ?? 0), 0);
      let roll = rng() * total;
      for (const item of items) {
        roll -= item.weight ?? 0;
        if (roll <= 0) return item;
      }
      return items[items.length - 1];
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractLineNumber(stack: string): number | undefined {
  const match = stack.match(/:(\d+):\d+/);
  return match ? parseInt(match[1], 10) : undefined;
}

/** Stringify console args the way `console.log(a, b, c)` would — objects
 *  via JSON, others via String, joined by a space. Good enough for the debug
 *  panel; not a full `util.inspect` replacement. */
function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'object' && a !== null ? safeStringify(a) : String(a)))
    .join(' ');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
