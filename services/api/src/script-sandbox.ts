import { runInNewContext } from "node:vm";

// ─── Input types ──────────────────────────────────────────────────────────

export interface ScriptInput {
  id: string;
  name: string;
  code: string;
  sortOrder: number;
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
}

export interface ScriptExecutionResult {
  /** Mutated character fields after all scripts ran */
  character: {
    personality: string;
    scenario: string;
  };
  /** Updated script state (to persist back to chat) */
  updatedScriptState: Record<string, Record<string, unknown>>;
  /** Errors per script */
  errors: Array<{ scriptId: string; scriptName: string; error: string; line?: number }>;
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

  const updatedScriptState: Record<string, Record<string, unknown>> = {};
  const errors: ScriptExecutionResult["errors"] = [];

  for (const script of input.scripts) {
    // Initialize state bucket for this script
    const stateBucket: Record<string, unknown> = { ...(scriptState[script.id] ?? {}) };

    // Build the context object with getter-based Janitor aliases
    const chatContext = buildChatContext(chat);
    const characterContext = buildCharacterContext(mutableCharacter);
    const loreContext = buildLoreContext(activeLoreEntries);
    const stateContext = buildStateContext(stateBucket);
    const utilityContext = buildUtilityContext();

    const sandbox = {
      context: {
        chat: chatContext,
        character: characterContext,
        lore: loreContext,
        state: stateContext,
        ...utilityContext,
      },
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
      console: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
    };

    try {
      runInNewContext(script.code, sandbox, {
        timeout: 5000,
        filename: script.name,
      });

      // Persist state after successful execution
      updatedScriptState[script.id] = { ...stateBucket };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      const stack =
        err instanceof Error ? err.stack : undefined;
      errors.push({
        scriptId: script.id,
        scriptName: script.name,
        error: message,
        line: stack ? extractLineNumber(stack) : undefined,
      });
      // Continue to next script — errors don't crash the pipeline
    }
  }

  return {
    character: {
      personality: mutableCharacter.personality,
      scenario: mutableCharacter.scenario,
    },
    updatedScriptState,
    errors,
  };
}

// ─── Context builders ─────────────────────────────────────────────────────

function buildChatContext(chat: ScriptExecutionInput["chat"]) {
  const messages = chat.messages;
  const ctx: Record<string, unknown> = {
    messages,
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

function buildLoreContext(entries: ScriptExecutionInput["activeLoreEntries"]) {
  return {
    activeEntries: Object.freeze(
      entries.map((e) => Object.freeze({ ...e })),
    ),
  };
}

function buildStateContext(stateBucket: Record<string, unknown>) {
  return {
    get(key: string): unknown {
      return stateBucket[key];
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

function buildUtilityContext() {
  return {
    random(): number {
      return Math.random();
    },
    randomInt(min: number, max: number): number {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
    pick<T>(arr: T[]): T {
      return arr[Math.floor(Math.random() * arr.length)];
    },
    weightedPick(
      items: Array<{ weight: number } & Record<string, unknown>>,
    ): (typeof items)[number] {
      const total = items.reduce((sum, item) => sum + (item.weight ?? 0), 0);
      let roll = Math.random() * total;
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
