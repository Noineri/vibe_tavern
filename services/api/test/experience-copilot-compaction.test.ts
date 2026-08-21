/**
 * Experience-copilot compaction service (CM-5 / CM-6) — LLM summarize-and-replace.
 *
 * Pins the digest-boundary semantics approved for Wave 2: a digest (role
 * "digest") stores the first-kept message id in `toolCallId` (the anchor);
 * everything strictly before the anchor is dropped from the model window, the
 * anchor onward survives. Covers: digest replaces window, prior digest folded
 * into the next, nothing-to-compact 400, tool-pair safety at the cursor
 * (same-millisecond turn write), provider-error propagation (→502 at the global
 * handler), auto-compaction threshold/toggle/dedupe, and lock release on error.
 *
 * The executor is INJECTED (no `mock.module("ai")` — that mock is process-global
 * and permanent under bun:test; see AGENTS.md gotcha).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ExperienceCopilotMessage,
  CopilotContextMetrics,
} from "@vibe-tavern/db";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";
import { ExperienceCopilotCompactionService } from "../src/domain/interactive/copilot/experience-copilot-compaction.js";
import {
  COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
  COPILOT_COMPACT_TEMPERATURE,
} from "../src/domain/interactive/copilot/copilot-limits.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeThread(overrides: Partial<ExperienceCopilotThread> = {}): ExperienceCopilotThread {
  return {
    id: "thread_1",
    scriptId: "script_1",
    draftSessionId: null,
    title: "Draft",
    archivedAt: null,
    contextMetrics: makeMetrics(),
    lastProviderProfileId: "prov_1",
    lastModel: "model_1",
    autoCompact: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<CopilotContextMetrics> = {}): CopilotContextMetrics {
  return {
    systemTokens: 100,
    digestTokens: 0,
    historyTokens: 200,
    totalTokens: 300,
    budgetTokens: 4000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMessage(id: string, role: string, overrides: Partial<ExperienceCopilotMessage> = {}): ExperienceCopilotMessage {
  return {
    id,
    threadId: "thread_1",
    role,
    content: `${role} ${id}`,
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a plain user/assistant alternation of `count` messages (ids m1…mN). */
function makeTurnSequence(count: number): ExperienceCopilotMessage[] {
  const out: ExperienceCopilotMessage[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(makeMessage(`m${i}`, i % 2 === 1 ? "user" : "assistant"));
  }
  return out;
}

// ─── Fake store / profiles / executor ────────────────────────────────────────

interface FakeStoreHandle {
  store: ExperienceCopilotStore;
  messages: ExperienceCopilotMessage[];
  appended: ExperienceCopilotMessage[];
  metricsCalls: Array<{ threadId: string; metrics: CopilotContextMetrics; providerProfileId: string; model: string }>;
  thread: ExperienceCopilotThread;
}

function makeStore(initialMessages: ExperienceCopilotMessage[], threadOverrides: Partial<ExperienceCopilotThread> = {}): FakeStoreHandle {
  const messages = [...initialMessages];
  const appended: ExperienceCopilotMessage[] = [];
  const metricsCalls: Array<{ threadId: string; metrics: CopilotContextMetrics; providerProfileId: string; model: string }> = [];
  const thread = makeThread(threadOverrides);

  const store = {
    async getById() {
      return thread;
    },
    async listMessages() {
      return [...messages];
    },
    async appendMessage(_threadId: string, input: { role: string; content?: string; toolCallsJson?: string | null; toolCallId?: string | null }) {
      const m = makeMessage(`digest_${appended.length + 1}`, input.role, {
        content: input.content ?? "",
        toolCallId: input.toolCallId ?? null,
      });
      appended.push(m);
      messages.push(m);
      return m;
    },
    async updateContextMetrics(threadId: string, metrics: CopilotContextMetrics, providerProfileId: string, model: string) {
      metricsCalls.push({ threadId, metrics, providerProfileId, model });
    },
    async getAutoCompact() {
      return thread.autoCompact;
    },
    async setAutoCompact(enabled: boolean) {
      thread.autoCompact = enabled;
    },
  } as unknown as ExperienceCopilotStore;

  return { store, messages, appended, metricsCalls, thread };
}

/** Minimal provider profile — `bindPerModel:false` keeps `resolveEffectiveSummaryProfile`
 *  on the identity path so the overlay lookup is never consulted. */
function makeProviderProfiles() {
  const profile = {
    id: "prov_1",
    name: "Test",
    providerPreset: "openai",
    endpoint: "http://localhost",
    apiKey: "sk-test",
    defaultModel: "model_1",
    bindPerModel: false,
  };
  return {
    getProviderProfile: async () => profile,
    getProviderModelSettings: async () => null,
  };
}

type ExecuteResult = { text: string } | Error;

function makeExecutor(initial: ExecuteResult = { text: "summary" }) {
  let result: ExecuteResult = initial;
  const calls: Array<{
    model: string;
    prompt: Record<string, unknown>;
    input: Record<string, unknown>;
  }> = [];
  const execute = async (input: Record<string, unknown>) => {
    calls.push({
      model: input.model as string,
      prompt: input.prompt as Record<string, unknown>,
      input,
    });
    if (result instanceof Error) throw result;
    return { text: result.text, providerResponse: {} };
  };
  return {
    execute,
    calls,
    setResult(next: ExecuteResult) {
      result = next;
    },
  };
}

/** Poll until `cond` is true (bun:test has no RTL waitFor here). */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

function transcriptOf(call: { prompt: Record<string, unknown> }): string {
  const payload = call.prompt.finalPayload as { messages: Array<{ content: string }> };
  return payload.messages.map((m) => m.content).join("\n");
}

beforeEach(() => {
  setTokenCountFn((text: string) => text.length);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceCopilotCompactionService — manual compact (CM-5)", () => {
  it("replaces the window: keeps the anchor onward, summarizes the covered prefix", async () => {
    const { store, appended, metricsCalls } = makeStore(makeTurnSequence(20));
    const executor = makeExecutor({ text: "summary-1" });
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    const result = await service.compact({ threadId: "thread_1" });

    // 20 messages, keep-window 8 → the last 8 (m13..m20) survive; the digest's
    // anchor is the first kept message (m13).
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("digest");
    expect(appended[0].content).toBe("summary-1");
    expect(appended[0].toolCallId).toBe("m13");

    // Fresh metrics returned + persisted (honest "estimate").
    expect(result.metrics.source).toBe("estimate");
    expect(result.metrics.totalTokens).toBe(
      result.metrics.systemTokens + result.metrics.digestTokens + result.metrics.historyTokens,
    );
    expect(metricsCalls).toHaveLength(1);
    expect(metricsCalls[0].providerProfileId).toBe("prov_1");
    expect(metricsCalls[0].model).toBe("model_1");

    // The summarization prompt carries ONLY the covered prefix (m1..m12),
    // never the kept window (m13..m20).
    const transcript = transcriptOf(executor.calls[0]);
    expect(transcript).toContain("m1");
    expect(transcript).toContain("m12");
    expect(transcript).not.toContain("m13");
  });

  it("digest call carries copilot-owned sampler overrides, not the RP profile's (A-lite, 2026-08-17)", async () => {
    // The profile's samplers (temperature 1, maxTokens 2000) once let a
    // reasoning model burn the whole output cap on thinking → "Provider
    // returned an empty summary". The digest call must pin its own cool,
    // roomy samplers regardless of the profile.
    const { store } = makeStore(makeTurnSequence(20));
    const executor = makeExecutor({ text: "summary-1" });
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    await service.compact({ threadId: "thread_1" });

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].input.overrideTemperature).toBe(COPILOT_COMPACT_TEMPERATURE);
    expect(executor.calls[0].input.overrideMaxTokens).toBe(COPILOT_COMPACT_MAX_OUTPUT_TOKENS);
  });

  it("folds the prior digest into the next and re-anchors (successive compactions)", async () => {
    const { store, messages, appended } = makeStore(makeTurnSequence(20));
    const executor = makeExecutor({ text: "summary-1" });
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    await service.compact({ threadId: "thread_1" });
    expect(appended[0].content).toBe("summary-1");
    expect(appended[0].toolCallId).toBe("m13");

    // More turns arrive; the window grows past the keep-window again.
    messages.push(...makeTurnSequence(8).map((m, i) => makeMessage(`m${21 + i}`, m.role)));
    executor.setResult({ text: "summary-2" });

    await service.compact({ threadId: "thread_1" });

    expect(appended).toHaveLength(2);
    // The new digest folds the prior digest's text into the summarization prompt.
    const secondTranscript = transcriptOf(executor.calls[1]);
    expect(secondTranscript).toContain("summary-1");
    // Re-anchors to the new keep-window's first message (m21).
    expect(appended[1].toolCallId).toBe("m21");
  });

  it("rejects with a typed 400 when there is nothing to compact", async () => {
    const { store } = makeStore(makeTurnSequence(3));
    const executor = makeExecutor();
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    const error = await service.compact({ threadId: "thread_1" }).then(
      () => null,
      (e) => e,
    ) as { kind?: string } | null;

    expect(error).not.toBeNull();
    expect(error!.kind).toBe("Validation");
    expect(executor.calls).toHaveLength(0);
  });

  it("never splits an assistant tool call from its result (same-millisecond turn write)", async () => {
    // One tight turn: user → assistant(toolcalls) → tool-result → assistant text,
    // all sharing the same createdAt. The raw cursor would land on the tool
    // result; the boundary must walk back to the triggering user message.
    const sameMs = "2025-01-01T00:00:00.000Z";
    const messages: ExperienceCopilotMessage[] = [
      makeMessage("u1", "user", { createdAt: sameMs }),
      makeMessage("a2", "assistant", { createdAt: sameMs }),
      makeMessage("u3", "user", { createdAt: sameMs }),
      makeMessage("a4", "assistant", {
        createdAt: sameMs,
        toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: "tc1", toolName: "write_buffer", input: {} }]),
      }),
      makeMessage("t5", "tool", { createdAt: sameMs, content: JSON.stringify({ toolName: "write_buffer", output: { ok: true } }), toolCallId: "tc1" }),
      makeMessage("a6", "assistant", { createdAt: sameMs }),
      makeMessage("u7", "user", { createdAt: sameMs }),
      makeMessage("a8", "assistant", { createdAt: sameMs }),
      makeMessage("u9", "user", { createdAt: sameMs }),
      makeMessage("a10", "assistant", { createdAt: sameMs }),
    ];
    const { store, appended } = makeStore(messages);
    const executor = makeExecutor({ text: "summary" });
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    await service.compact({ threadId: "thread_1" });

    // The keep-window (8) with a raw cursor on t5 would split the tool pair;
    // the safe boundary walks back to u3 — so the anchor is u3, NOT t5 or a4.
    expect(appended[0].toolCallId).toBe("u3");

    // The summarization transcript covers only u1,a2 (everything before u3),
    // never the tool call/result or anything after it.
    const transcript = transcriptOf(executor.calls[0]);
    expect(transcript).toContain("u1");
    expect(transcript).toContain("a2");
    expect(transcript).not.toContain("u3");
    expect(transcript).not.toContain("a4");
    expect(transcript).not.toContain("t5");
  });

  it("propagates a provider error unchanged (global handler maps it to 502)", async () => {
    const { store } = makeStore(makeTurnSequence(20));
    const executor = makeExecutor(
      new ProviderExecutionError("upstream 502", "server_error", "openai", { statusCode: 502 }),
    );
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    const error = await service.compact({ threadId: "thread_1" }).then(
      () => null,
      (e) => e,
    );

    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect((error as Error).message).toBe("upstream 502");
  });

  it("a loopback endpoint without a saved API key passes the key check (local gateway injects credentials)", async () => {
    // Regression: a self-hosted gateway profile (e.g. http://127.0.0.1:8090/v1,
    // openaiCompat preset, empty apiKey) was rejected with "Selected provider
    // has no saved API key" even though generation through it works fine — the
    // gateway adds auth itself. Only non-loopback endpoints require a key.
    const profiles = makeProviderProfiles();
    const profile = {
      id: "prov_local",
      name: "Local gateway",
      providerPreset: "openai",
      endpoint: "http://127.0.0.1:8090/v1/",
      apiKey: "",
      defaultModel: "model_1",
      bindPerModel: false,
    };
    (profiles as { profile: unknown }).profile = profile;
    profiles.getProviderProfile = async () => profile;

    const { store, appended } = makeStore(makeTurnSequence(20));
    const executor = makeExecutor({ text: "summary via gateway" });
    const service = new ExperienceCopilotCompactionService(
      store,
      profiles as never,
      executor.execute as never,
    );

    await service.compact({ threadId: "thread_1" });

    // The compaction RAN (executor called, digest appended) — no key rejection.
    expect(executor.calls.length).toBe(1);
    expect(appended[0].role).toBe("digest");
  });
});

describe("ExperienceCopilotCompactionService — auto-compact (CM-6)", () => {
  it("triggers after a turn that crosses 80% of budget", async () => {
    const { store, appended, thread } = makeStore(makeTurnSequence(20), {
      contextMetrics: makeMetrics({ totalTokens: 900, budgetTokens: 1000, reserveTokens: 100 }),
    });
    thread.lastProviderProfileId = "prov_1";
    thread.lastModel = "model_1";
    const executor = makeExecutor({ text: "auto-summary" });
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    await service.autoCompactAfterTurn("thread_1");

    expect(executor.calls).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(appended[0].content).toBe("auto-summary");
  });

  it("skips below the threshold, when toggled off, when nothing to compact, or with no last-used pair", async () => {
    // Below threshold (50%).
    {
      const { store } = makeStore(makeTurnSequence(20), {
        contextMetrics: makeMetrics({ totalTokens: 500, budgetTokens: 1000 }),
      });
      const executor = makeExecutor();
      const service = new ExperienceCopilotCompactionService(store, makeProviderProfiles() as never, executor.execute as never);
      await service.autoCompactAfterTurn("thread_1");
      expect(executor.calls).toHaveLength(0);
    }
    // Toggle off.
    {
      const { store } = makeStore(makeTurnSequence(20), {
        autoCompact: false,
        contextMetrics: makeMetrics({ totalTokens: 900, budgetTokens: 1000 }),
      });
      const executor = makeExecutor();
      const service = new ExperienceCopilotCompactionService(store, makeProviderProfiles() as never, executor.execute as never);
      await service.autoCompactAfterTurn("thread_1");
      expect(executor.calls).toHaveLength(0);
    }
    // Nothing to compact (history within the keep-window).
    {
      const { store } = makeStore(makeTurnSequence(3), {
        contextMetrics: makeMetrics({ totalTokens: 900, budgetTokens: 1000 }),
      });
      const executor = makeExecutor();
      const service = new ExperienceCopilotCompactionService(store, makeProviderProfiles() as never, executor.execute as never);
      await service.autoCompactAfterTurn("thread_1");
      expect(executor.calls).toHaveLength(0);
    }
    // No last-used pair.
    {
      const { store, thread } = makeStore(makeTurnSequence(20), {
        contextMetrics: makeMetrics({ totalTokens: 900, budgetTokens: 1000 }),
      });
      thread.lastProviderProfileId = null;
      thread.lastModel = null;
      const executor = makeExecutor();
      const service = new ExperienceCopilotCompactionService(store, makeProviderProfiles() as never, executor.execute as never);
      await service.autoCompactAfterTurn("thread_1");
      expect(executor.calls).toHaveLength(0);
    }
  });

  it("dedupes auto + manual concurrent compactions into one run", async () => {
    const { store } = makeStore(makeTurnSequence(20), {
      contextMetrics: makeMetrics({ totalTokens: 900, budgetTokens: 1000 }),
    });
    let release!: (v: { text: string }) => void;
    const gate = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    });
    const calls: unknown[] = [];
    const execute = async (input: unknown) => {
      calls.push(input);
      return gate;
    };
    const service = new ExperienceCopilotCompactionService(store, makeProviderProfiles() as never, execute as never);

    // Auto starts and acquires the lock (execute is now in-flight on the gate).
    const autoPromise = service.autoCompactAfterTurn("thread_1");
    await until(() => calls.length === 1);

    // Manual compact while auto is in-flight → conflict, no second run.
    const manualError = await service.compact({ threadId: "thread_1" }).then(
      () => null,
      (e) => e,
    ) as { kind?: string } | null;
    expect(manualError?.kind).toBe("Conflict");

    release({ text: "auto-summary" });
    await autoPromise;

    expect(calls).toHaveLength(1);
  });

  it("releases the lock after an auto-compaction error (fire-and-forget never throws)", async () => {
    const { store, appended } = makeStore(makeTurnSequence(20), {
      contextMetrics: makeMetrics({ totalTokens: 900, budgetTokens: 1000 }),
    });
    const executor = makeExecutor(new Error("summarize boom"));
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    // Fire-and-forget: the error is swallowed (logged via onError), never thrown.
    await expect(service.autoCompactAfterTurn("thread_1")).resolves.toBeUndefined();
    expect(appended).toHaveLength(0);

    // The lock was released: a follow-up manual compact runs cleanly.
    executor.setResult({ text: "manual-summary" });
    const result = await service.compact({ threadId: "thread_1" });
    expect(result.digest.content).toBe("manual-summary");
    expect(executor.calls).toHaveLength(2);
  });
});

// ─── Echo stubbing in the summarizer transcript + post-compaction metrics (#16) ──

describe("ExperienceCopilotCompactionService — echo stubs (#16)", () => {
  it("the summarizer transcript carries stubs, not superseded buffer copies; keep-window metrics are stub-honest", async () => {
    // A 16-message session with two BIG write_buffer exchanges: an early one
    // (summarized away) and a late one (inside the 8-message keep window but
    // older than the last two user turns).
    const BIG = "XXBIGXX ".repeat(600);
    const call = (id: string) =>
      JSON.stringify([
        { type: "tool-call", toolCallId: id, toolName: "write_buffer", input: { target: "rules", content: BIG, summary: `edit ${id}` } },
      ]);
    const result = (id: string) =>
      JSON.stringify({ toolName: "write_buffer", output: { target: "rules", proposed: BIG, summary: `edit ${id}` } });
    const messages: ExperienceCopilotMessage[] = [
      makeMessage("m1", "user"),
      makeMessage("m2", "assistant", { toolCallsJson: call("tc1") }),
      makeMessage("m3", "tool", { content: result("tc1"), toolCallId: "tc1" }),
      makeMessage("m4", "user"),
      makeMessage("m5", "assistant"),
      makeMessage("m6", "user"),
      makeMessage("m7", "assistant"),
      makeMessage("m8", "user"),
      makeMessage("m9", "assistant", { toolCallsJson: call("tc2") }),
      makeMessage("m10", "tool", { content: result("tc2"), toolCallId: "tc2" }),
      makeMessage("m11", "user"),
      makeMessage("m12", "assistant"),
      makeMessage("m13", "user"),
      makeMessage("m14", "assistant"),
      makeMessage("m15", "user"),
      makeMessage("m16", "assistant"),
    ];
    const { store, metricsCalls } = makeStore(messages);
    const executor = makeExecutor({ text: "summary-echo" });
    const service = new ExperienceCopilotCompactionService(
      store,
      makeProviderProfiles() as never,
      executor.execute as never,
    );

    await service.compact({ threadId: "thread_1" });

    // Transcript: the summarized prefix's buffer echo is stubbed on both
    // sides, the one-line summary survives, the raw copy is gone.
    const transcript = transcriptOf(executor.calls[0]);
    expect(transcript).toContain("superseded buffer content");
    expect(transcript).toContain("edit tc1");
    expect(transcript).not.toContain("XXBIGXX");

    // Metrics honesty: the keep window (m9..m16) contains the tc2 tool row
    // (a full BIG copy, ~4.8k chars un-stubbed), but it is older than the
    // last two user turns → the estimate stubs it → historyTokens stay far
    // below BIG's own size.
    expect(metricsCalls[0].metrics.historyTokens).toBeLessThan(BIG.length);
  });
});
