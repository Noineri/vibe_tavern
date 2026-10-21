/**
 * Script-agent stream wiring (AGENT_SHELL_PLAN, AS-8b-fix-A).
 *
 * Pins the `script` kind's seams through the REAL `streamScriptAgentTurn`
 * (generic loop + AS-7 assembly), with a fake store and a fake `streamText`
 * injected through the deps (no `mock.module`):
 * - the LIVE-BUFFER contract (the plan's failure point #3): the request's
 *   `code` overrides the stored row's code in the assembled prompt; without a
 *   request buffer the stored code is the fallback;
 * - auto-compaction: the injected `autoCompact` is called with the thread id
 *   after a completed turn when wired, and nothing is called when absent.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import type { LanguageModel } from "ai";
import type {
  AppendMessageInput,
  ExperienceCopilotMessage,
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ProviderProfile,
  ScriptRow,
  StoreContainer,
} from "@vibe-tavern/db";
import {
  streamScriptAgentTurn,
  type ScriptAgentStreamDeps,
} from "../src/domain/agent/script-agent/script-agent-stream.js";
// Side-effect import: registers the `script` agent kind (AS-7) so the
// assembly's descriptor path works regardless of which test file the shared
// process loaded first.
import "../src/domain/agent/kinds/script-kind.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

const STORED_CODE = "context.character.personality += ', STORED-CODE-MARKER';";
const LIVE_CODE = "context.character.personality += ', LIVE-CODE-MARKER';";

type CapturedMessage = { role: string; content: unknown };

/** The fake `streamText` records the model-facing messages it was called with. */
let capturedMessages: CapturedMessage[] = [];
let streamTextImpl: ((opts: { messages: CapturedMessage[] }) => unknown) | undefined;

function makeFakeStreamTextResult(parts: unknown[]): Record<string, unknown> {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    for (const p of parts) yield p;
  }
  return {
    stream: gen(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve(undefined),
  };
}

function createFakeStore(thread: ExperienceCopilotThread): ExperienceCopilotStore {
  const messages: ExperienceCopilotMessage[] = [];
  let counter = 0;
  return {
    async getById() { return thread; },
    async listMessages() { return [...messages]; },
    async appendMessage(_threadId: string, input: AppendMessageInput) {
      const msg: ExperienceCopilotMessage = {
        id: `msg_${counter++}`,
        threadId: thread.id,
        role: input.role,
        content: input.content ?? "",
        toolCallsJson: input.toolCallsJson ?? null,
        toolCallId: input.toolCallId ?? null,
        createdAt: new Date(Date.now() + counter * 1000).toISOString(),
      };
      messages.push(msg);
      return msg;
    },
    async updateContextMetrics() {},
    async updateTodo() {},
  } as unknown as ExperienceCopilotStore;
}

function makeProviderProfile(): ProviderProfile {
  return {
    id: "prov_1",
    name: "Test",
    providerPreset: "openai",
    coauthorTransport: "chatCompletions",
    endpoint: "http://test",
    apiKey: "key",
    defaultModel: "test-model",
    contextBudget: null,
    pinContextBudget: false,
    bindPerModel: false,
    maxTokens: 2000,
    temperature: 0.3,
    proxyMode: "inherit",
    proxyId: null,
    isActive: true,
  } as unknown as ProviderProfile;
}

function makeThread(scriptId: string | null = "script_1"): ExperienceCopilotThread {
  return {
    id: "thread_1",
    scriptId,
    draftSessionId: null,
    title: "Script thread",
    archivedAt: null,
    contextMetrics: null,
    contextLinks: [],
    todo: [],
    lastProviderProfileId: null,
    lastModel: null,
    autoCompact: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeScriptRow(): ScriptRow {
  return {
    id: "script_1",
    name: "Stream pin script",
    description: "",
    code: STORED_CODE,
    enabled: true,
    scriptKind: "prompt",
    origin: "in_app",
    firstEnabledAt: null,
    creationIntentId: null,
    scopeType: "global",
    sortOrder: 0,
    characterId: null,
    personaId: null,
    chatId: null,
    defaultVisualId: null,
    copilotProfileId: null,
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ScriptRow;
}

function makeDeps(
  store: ExperienceCopilotStore,
  overrides: Partial<ScriptAgentStreamDeps> = {},
): ScriptAgentStreamDeps {
  const profile = makeProviderProfile();
  return {
    store,
    agentPlans: { get: async () => null, save: async () => {} },
    getScript: async () => makeScriptRow(),
    getContextCards: async () => ({ ownerNames: [], cards: [] }),
    getProviderProfile: async () => profile,
    getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    stores: {} as unknown as StoreContainer,
    // Type-erased seam: the fake returns the partial FullStream shape the loop
    // reads (`.stream`, `finishReason`, `usage`), not the SDK's full result.
    streamText: ((opts: { messages: CapturedMessage[] }) => {
      capturedMessages = opts.messages;
      return streamTextImpl
        ? streamTextImpl(opts)
        : makeFakeStreamTextResult([{ type: "text-delta", text: "ok" }]);
    }) as unknown as ScriptAgentStreamDeps["streamText"],
    ...overrides,
  };
}

async function drain(gen: AsyncGenerator<{ event: string; data: string }>): Promise<string[]> {
  const events: string[] = [];
  for await (const chunk of gen) events.push(chunk.event);
  return events;
}

/** Every model-facing message flattened to one string for marker assertions. */
function promptText(): string {
  return capturedMessages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

beforeEach(() => {
  capturedMessages = [];
  streamTextImpl = undefined;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("streamScriptAgentTurn - live-buffer contract", () => {
  it("request.code overrides the stored code in the assembled prompt", async () => {
    const store = createFakeStore(makeThread());
    const events = await drain(
      streamScriptAgentTurn(
        { threadId: "thread_1", content: "tweak it", providerProfileId: "prov_1", code: LIVE_CODE },
        makeDeps(store),
      ),
    );

    expect(events).toContain("finish");
    const prompt = promptText();
    expect(prompt).toContain("LIVE-CODE-MARKER");
    expect(prompt).not.toContain("STORED-CODE-MARKER");
  });

  it("an absent request.code falls back to the stored code", async () => {
    const store = createFakeStore(makeThread());
    const events = await drain(
      streamScriptAgentTurn(
        { threadId: "thread_1", content: "tweak it", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    expect(events).toContain("finish");
    const prompt = promptText();
    expect(prompt).toContain("STORED-CODE-MARKER");
    expect(prompt).not.toContain("LIVE-CODE-MARKER");
  });

  it("an empty live buffer is still a live buffer: the stored code is not resurrected", async () => {
    const store = createFakeStore(makeThread());
    await drain(
      streamScriptAgentTurn(
        { threadId: "thread_1", content: "start over", providerProfileId: "prov_1", code: "" },
        makeDeps(store),
      ),
    );

    expect(promptText()).not.toContain("STORED-CODE-MARKER");
  });
});

describe("streamScriptAgentTurn - context cards (AS-8e1)", () => {
  it("passes the request's build-panel ids to getContextCards and renders the returned cards in full", async () => {
    const store = createFakeStore(makeThread());
    let seenInput: unknown;
    const events = await drain(
      streamScriptAgentTurn(
        {
          threadId: "thread_1",
          content: "tweak it",
          providerProfileId: "prov_1",
          code: LIVE_CODE,
          contextCharacterId: "char_1",
          contextPersonaId: "persona_1",
        },
        makeDeps(store, {
          getContextCards: (async (input: {
            scriptId: string | null;
            contextCharacterId?: string;
            contextPersonaId?: string;
          }) => {
            seenInput = input;
            return {
              ownerNames: ["Aria"],
              cards: [
                { type: "character", id: "char_1", name: "Aria", content: "CARD-TEXT-ARIA-MARKER" },
                { type: "persona", id: "persona_1", name: "Muse", content: "PERSONA-DESC-MUSE-MARKER" },
              ],
            };
          }),
        }),
      ),
    );

    expect(events).toContain("finish");
    expect(seenInput).toEqual({
      scriptId: "script_1",
      contextCharacterId: "char_1",
      contextPersonaId: "persona_1",
    });
    const prompt = promptText();
    expect(prompt).toContain("- Linked owners: Aria");
    expect(prompt).toContain("## Character and persona cards");
    expect(prompt).toContain("### Character: Aria");
    expect(prompt).toContain("CARD-TEXT-ARIA-MARKER");
    expect(prompt).toContain("### Persona: Muse");
    expect(prompt).toContain("PERSONA-DESC-MUSE-MARKER");
  });

  it("a draft thread (scriptId null) still resolves the request ids' cards", async () => {
    const store = createFakeStore(makeThread(null));
    let seenInput: unknown;
    const events = await drain(
      streamScriptAgentTurn(
        {
          threadId: "thread_1",
          content: "start",
          providerProfileId: "prov_1",
          contextPersonaId: "persona_1",
        },
        makeDeps(store, {
          getScript: async () => null,
          getContextCards: (async (input: {
            scriptId: string | null;
            contextCharacterId?: string;
            contextPersonaId?: string;
          }) => {
            seenInput = input;
            return {
              ownerNames: [],
              cards: [
                { type: "persona", id: "persona_1", name: "Muse", content: "PERSONA-DESC-MUSE-MARKER" },
              ],
            };
          }),
        }),
      ),
    );

    expect(events).toContain("finish");
    expect(seenInput).toEqual({ scriptId: null, contextPersonaId: "persona_1" });
    expect(promptText()).toContain("PERSONA-DESC-MUSE-MARKER");
  });
});

describe("streamScriptAgentTurn - auto-compaction", () => {
  it("calls autoCompact with the thread id after a completed turn when wired", async () => {
    const store = createFakeStore(makeThread());
    const compactCalls: string[] = [];
    const events = await drain(
      streamScriptAgentTurn(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, {
          autoCompact: async (threadId: string) => {
            compactCalls.push(threadId);
          },
        }),
      ),
    );

    expect(events).toContain("finish");
    expect(compactCalls).toEqual(["thread_1"]);
  });

  it("an unwired turn completes with no compaction call", async () => {
    const store = createFakeStore(makeThread());
    const events = await drain(
      streamScriptAgentTurn(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    expect(events).toContain("finish");
  });

  it("does not call autoCompact when the turn fails before completing", async () => {
    const store = createFakeStore(makeThread());
    const compactCalls: string[] = [];
    streamTextImpl = () => {
      throw new Error("provider setup failed");
    };
    const events = await drain(
      streamScriptAgentTurn(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, {
          autoCompact: async (threadId: string) => {
            compactCalls.push(threadId);
          },
        }),
      ),
    );

    expect(events).toContain("error");
    expect(compactCalls).toEqual([]);
  });
});

describe("streamScriptAgentTurn - SC-17 attachedVariants", () => {
  it("a script thread ignores the field entirely — the turn runs unchanged and nothing is frozen", async () => {
    const store = createFakeStore(makeThread());
    const events = await drain(
      streamScriptAgentTurn(
        {
          threadId: "thread_1",
          content: "tweak it",
          providerProfileId: "prov_1",
          // The SC-17 field rides the shared stream body; the script kind
          // never reads it (the fake store exposes no event/timeline methods —
          // any freeze attempt would crash here, which IS the pin).
          attachedVariants: [
            { messageId: "msg_anywhere", variantId: "mvar_anywhere" },
          ],
        },
        makeDeps(store),
      ),
    );

    expect(events).toContain("finish");
    // The turn persisted exactly its own user row + reply — no event rows,
    // no validation of the (foreign) pairs: the field is inert for the kind.
    expect(promptText()).toContain("STORED-CODE-MARKER");
    expect(promptText()).not.toContain("msg_anywhere");
  });
});
