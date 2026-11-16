/**
 * Retry-storm guard in the generic agent loop (owner ruling 2026-11-13).
 *
 * The AI SDK's DEFAULT `maxRetries` is 2: a retryable upstream hiccup
 * (429/5xx/connection reset) silently re-fires the ENTIRE prompt up to 3
 * times, and each attempt can fan out across proxy rotation accounts with
 * identical giant bodies. That mechanical back-to-back burst is the prime
 * suspect in the TOS ban of a fresh Antigravity account (sidechat usage
 * 2026-11-12: the model visibly received one request twice, one truncated).
 *
 * This pins the loop's contract: the sidechat/agent path passes
 * `maxRetries: 0` to `streamText` — exactly one attempt; errors surface
 * immediately and the user retries deliberately through the UI.
 */
import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";
import type { ProviderProfile } from "@vibe-tavern/db";
import { streamAgentTurn, type AgentStreamDeps, type AgentStreamSeams, type AgentStreamThread } from "../src/domain/agent/agent-stream.js";

/** The options object the loop handed to streamText — the thing under test. */
let capturedArgs: Record<string, unknown> | null = null;

/** The streamText double: captures the options the loop handed in (the thing
 *  under test) and returns a settled single-attempt result. One cast at this
 *  definition site (callable literal → the SDK function type); the baseline
 *  entry moves with it. */
function makeCapturingStreamText(): AgentStreamDeps["streamText"] {
  return ((options: Record<string, unknown>) => {
    capturedArgs = options;
    async function* gen(): AsyncGenerator<unknown, void, unknown> {
      yield { type: "text-delta", text: "Answer" };
    }
    return { stream: gen(), finishReason: Promise.resolve("stop"), usage: Promise.resolve(undefined) };
  }) as unknown as AgentStreamDeps["streamText"];
}

function makeFakeStore() {
  const thread: AgentStreamThread = { id: "thread_1", scriptId: "script_1", contextLinks: [] };
  return {
    async getById() {
      return thread;
    },
    async listMessages() {
      return [] as const;
    },
    async appendMessage() {},
    async setToolResultOutput() {},
    async updateContextMetrics() {},
  };
}

function makeProfile(): ProviderProfile {
  return {
    id: "prov_1",
    providerPreset: "openai",
    endpoint: "http://test",
    apiKey: "key",
    defaultModel: "test-model",
    proxyMode: "inherit",
    proxyId: null,
  } as unknown as ProviderProfile;
}

describe("streamAgentTurn - retry-storm guard (maxRetries: 0)", () => {
  it("passes maxRetries: 0 to streamText — no silent SDK re-fires of the whole prompt", async () => {
    const profile = makeProfile();
    const deps: AgentStreamDeps = {
      store: makeFakeStore(),
      getProviderProfile: async () => profile,
      getEffectiveProviderProfile: async () => profile,
      resolveModel: () => ({}) as LanguageModel,
      streamText: makeCapturingStreamText(),
    };
    const seams: AgentStreamSeams = {
      logChannelPrefix: "test.agent-stream",
      threadLabel: "Agent thread",
      limits: { contextBudgetTokens: 100_000, responseReserveTokens: 4_000, toolLoopCeiling: 20 },
      loadContext: async () => null,
      resolveProfile: async () => ({}),
      assemble: async () => ({
        systemMessage: "sys",
        messages: [],
        tokenAccounting: { system: 1, digest: 0, history: 0, attached: 0, total: 1 },
      }),
      buildTools: () => ({}),
    };

    const events: string[] = [];
    for await (const chunk of streamAgentTurn(
      { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
      deps,
      seams,
    )) {
      events.push(chunk.event);
    }

    expect(events).toContain("finish");
    expect(capturedArgs).not.toBeNull();
    // The contract: exactly one provider attempt, ever.
    expect(capturedArgs!.maxRetries).toBe(0);
  });
});
