import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { AssemblePromptResponse, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import { ChatLifecycleRuntime, type ChatLifecycleRuntimeDeps } from "../src/runtime/session/session-runtime-chat-lifecycle.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { ChatSummaryService, withSummaryPromptAsFinalUserMessage } from "../src/domain/chat/chat-summary-service.js";
import { resolveSummaryPrompt } from "../src/domain/prompt/summary-prompt.js";

let capturedPrompt: AssemblePromptResponse | null = null;
// SUM-2: capture execute sampler overrides + ranged-assemble contextBudget
// so the override-threading boundary can be asserted directly.
let capturedExecuteArgs: { overrideMaxTokens?: number; overrideTemperature?: number } | null = null;
let capturedAssembleRangedArgs: { contextBudget?: number | null } | null = null;

const chat = {
  id: "chat_1",
  activeBranchId: "branch_1",
};

function assembled(prompt: AssemblePromptResponse = {
  layers: [],
  finalPayload: { messages: [] },
}): { branchId: ChatBranchId; prompt: AssemblePromptResponse; promptTraceDraft: never } {
  return { branchId: "branch_1" as ChatBranchId, prompt, promptTraceDraft: undefined as never };
}

function makeLifecycle(
  assemblePrompt: ChatLifecycleRuntimeDeps["assemblePrompt"],
  messages: Array<{ id: string; position: number }> = [],
  summaries: Array<{ id: string; label?: string; content: string; summarizedFrom: number; summarizedTo: number }> = [],
) {
  const deps = {
    stores: {
      chats: { getById: async () => chat },
      messages: { getMessages: async () => messages },
      // SPC-3: assembleRangedSummaryPrompt now loads the preceding chain via
      // listByChatBranch. Default empty → no priors (byte-equivalent).
      chatSummaries: { listByChatBranch: async () => summaries },
    },
    assemblePrompt,
  } as unknown as ChatLifecycleRuntimeDeps;
  return new ChatLifecycleRuntime(deps);
}

describe("ChatLifecycleRuntime summary assembly", () => {
  it("passes the full-summary preparation parameters through unchanged", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    });

    await lifecycle.assembleSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      recentMessageLimit: 24,
      contextBudget: 4096,
    });

    expect(calls).toEqual([[
      "chat_1",
      "branch_1",
      { model: "summary-model", recentMessageLimit: 24, contextBudget: 4096, summary: true },
    ]]);
  });

  it("selects exactly the requested inclusive range for ranged summaries", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    }, [
      { id: "msg_1", position: 0 },
      { id: "msg_2", position: 1 },
      { id: "msg_3", position: 2 },
      { id: "msg_4", position: 3 },
    ]);

    await lifecycle.assembleRangedSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      summarizedFrom: 2,
      summarizedTo: 3,
      contextBudget: 2048,
    });

    expect(calls).toEqual([[
      "chat_1",
      "branch_1",
      {
        model: "summary-model",
        recentMessageLimit: 4,
        excludeMessageIds: ["msg_1", "msg_4"],
        contextBudget: 2048,
        summary: true,
      },
    ]]);
  });
});

// ─── SUMMARY_PRIOR_CONTEXT_PLAN W1 (SPC-1) ─────────────────────────
//
// Ranged and full summary assembly today pass NO prior-summaries context
// when there are no preceding summaries. (W3 added prior-loading to ranged;
// with an empty chain the ranged options stay byte-equivalent — pinned here.)
// The full `summarizeChat` path never loads priors at all (out of scope).
describe("ChatLifecycleRuntime prior-context characterization (SPC-1)", () => {
  it("assembleRangedSummaryPrompt omits priorSummaries when no preceding summaries exist", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    }, [
      { id: "msg_1", position: 0 },
      { id: "msg_2", position: 1 },
    ]);

    await lifecycle.assembleRangedSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      summarizedFrom: 1,
      summarizedTo: 2,
      contextBudget: 2048,
    });

    expect(calls[0][2].priorSummaries).toBeUndefined();
  });

  it("assembleSummaryPrompt (full) does not pass priorSummaries (out of scope)", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    });

    await lifecycle.assembleSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      recentMessageLimit: 24,
      contextBudget: 4096,
    });

    expect(calls[0][2].priorSummaries).toBeUndefined();
  });
});

// ─── SUMMARY_PRIOR_CONTEXT_PLAN W3 (SPC-3): ranged prior-chain loading ────
//
// assembleRangedSummaryPrompt loads preceding summaries (summarizedFrom < from),
// count-capped to maxPriorSummaries most-recent, reversed to oldest→newest,
// and passes them as priorSummaries. Toggle off / max=0 / no priors → omitted.
describe("ChatLifecycleRuntime prior-chain loading (SPC-3)", () => {
  const chain = [
    { id: "s1", label: "Ch1", content: "first chapter", summarizedFrom: 1, summarizedTo: 10 },
    { id: "s2", label: "Ch2", content: "second chapter", summarizedFrom: 11, summarizedTo: 20 },
    { id: "s3", label: "Ch3", content: "third chapter", summarizedFrom: 21, summarizedTo: 30 },
    { id: "s4", label: "Ch4", content: "fourth chapter", summarizedFrom: 31, summarizedTo: 40 },
    { id: "s5", label: "Ch5", content: "fifth chapter", summarizedFrom: 41, summarizedTo: 50 },
  ];

  async function runRanged(opts: {
    from: number;
    to: number;
    includePriorSummaries?: boolean;
    maxPriorSummaries?: number;
  }) {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    }, [], chain);
    await lifecycle.assembleRangedSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      summarizedFrom: opts.from,
      summarizedTo: opts.to,
      contextBudget: 8192,
      ...(opts.includePriorSummaries !== undefined ? { includePriorSummaries: opts.includePriorSummaries } : {}),
      ...(opts.maxPriorSummaries !== undefined ? { maxPriorSummaries: opts.maxPriorSummaries } : {}),
    });
    return calls[0][2];
  }

  it("passes preceding summaries (summarizedFrom < from) as priorSummaries oldest→newest", async () => {
    // ranged [61..70] → all 5 (summarizedFrom <= 41 < 61) qualify, default cap 10.
    const options = await runRanged({ from: 61, to: 70 });
    expect(options.priorSummaries).toEqual([
      { id: "s1", label: "Ch1", content: "first chapter" },
      { id: "s2", label: "Ch2", content: "second chapter" },
      { id: "s3", label: "Ch3", content: "third chapter" },
      { id: "s4", label: "Ch4", content: "fourth chapter" },
      { id: "s5", label: "Ch5", content: "fifth chapter" },
    ]);
    expect(options.summary).toBe(true);
  });

  it("caps to maxPriorSummaries most-recent and reverses to oldest→newest", async () => {
    // ranged [61..70], cap 2 → most-recent [s5,s4] → reversed oldest-first [s4,s5].
    const options = await runRanged({ from: 61, to: 70, maxPriorSummaries: 2 });
    expect(options.priorSummaries).toEqual([
      { id: "s4", label: "Ch4", content: "fourth chapter" },
      { id: "s5", label: "Ch5", content: "fifth chapter" },
    ]);
  });

  it("includes summaries that start before from even when their end overlaps it", async () => {
    // ranged [25..30]: prior = summaries that START before 25. s1(1), s2(11),
    // s3(21) all start < 25 → qualify, even though s3 ends at 30 (overlaps the
    // range). Only s4(from=31) and s5(from=41) are excluded, as future-spoilers.
    // Prior is decoupled from the range END — the old summarizedTo<from rule
    // cut s3 here (30 < 25 = false) and silently cold-started the model.
    const options = await runRanged({ from: 25, to: 30 });
    expect(options.priorSummaries?.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("feeds prior across an inclusive-chunk seam (regression: session-number reset)", async () => {
    // User incident: chunk "T1–T50" then "T50–T100" — message 50 belongs to BOTH
    // ranges (inclusive bounds). Old rule (summarizedTo < from) cut the prior at
    // the seam (50 < 50 = false) → model cold-started → reset session numbering
    // to 1 / hallucinated. New rule (summarizedFrom < from): the first chapter
    // (from=1) starts before 50 → it is fed as prior.
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    }, [], [
      { id: "first", label: "T1–T50", content: "first chapter", summarizedFrom: 1, summarizedTo: 50 },
    ]);
    await lifecycle.assembleRangedSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      summarizedFrom: 50,
      summarizedTo: 99,
      contextBudget: 8192,
    });
    expect(calls[0][2].priorSummaries).toEqual([
      { id: "first", label: "T1–T50", content: "first chapter" },
    ]);
  });

  it("omits priorSummaries when includePriorSummaries is false", async () => {
    const options = await runRanged({ from: 61, to: 70, includePriorSummaries: false });
    expect(options.priorSummaries).toBeUndefined();
  });

  it("omits priorSummaries when maxPriorSummaries is 0", async () => {
    const options = await runRanged({ from: 61, to: 70, maxPriorSummaries: 0 });
    expect(options.priorSummaries).toBeUndefined();
  });

  it("falls back to a Trange label when the summary has none", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    }, [], [
      { id: "sX", content: "no label body", summarizedFrom: 1, summarizedTo: 5 },
    ]);
    await lifecycle.assembleRangedSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      summarizedFrom: 6,
      summarizedTo: 10,
      contextBudget: 2048,
    });
    expect(calls[0][2].priorSummaries).toEqual([
      { id: "sX", label: "T1–T5", content: "no label body" },
    ]);
  });
});

const summaryPrompt: AssemblePromptResponse = {
  layers: [
    { id: "character_base", text: "Character context" },
    { id: "prompt_preset_summary", text: "Summarize the case." },
  ],
  finalPayload: {
    messages: [
      { role: "system", content: "Character context", layerId: "character_base" },
      { role: "system", content: "Summarize the case.", layerId: "prompt_preset_summary" },
    ],
  },
};

describe("SessionRuntime summary assembly", () => {
  it("forwards every assembly option to the active chat-mode strategy", async () => {
    let received: Record<string, unknown> | null = null;
    const runtime = {
      getActiveProviderProfile: async () => null,
      resolveChatModeStrategy: async () => ({
        assemble: async (input: Record<string, unknown>) => {
          received = input;
          return {};
        },
      }),
      promptService: {},
      buildChatModeLoaders: () => ({}),
    };

    const assemblePrompt = Reflect.get(SessionRuntime.prototype, "assemblePrompt");
    const options = {
      excludeMessageIds: ["msg_1"],
      model: "summary-model",
      recentMessageLimit: 20,
      summary: true,
      contextBudget: 4096,
      responseReserve: 512,
      presetId: "preset_1",
      // SPC-3: priorSummaries threads through SessionRuntime.assemblePrompt →
      // strategy.assemble → assembleForChat (so the pipeline layer receives it).
      priorSummaries: [{ id: "prior_1", label: "Ch1", content: "earlier chapter" }],
    };
    await Reflect.apply(assemblePrompt, runtime, ["chat_1", "branch_1", options]);

    expect(received).toEqual(expect.objectContaining(options));
  });
});

function makeSummaryService() {
  const lifecycle = {
    assembleSummaryPrompt: async () => assembled(summaryPrompt),
    assembleRangedSummaryPrompt: async (input: { contextBudget?: number | null }) => {
      capturedAssembleRangedArgs = { contextBudget: input.contextBudget };
      return assembled(summaryPrompt);
    },
    updateChatSummary: async () => ({}),
  };
  const stores = {
    chatSummaries: {
      getById: async () => null,
      create: async (input: Record<string, unknown>) => ({ id: "summary_1", ...input }),
      update: async () => null,
    },
  } as unknown as StoreContainer;
  const profiles = {
    getProviderProfile: async () => ({
      id: "profile_1",
      providerPreset: "openai",
      apiKey: "test-key",
      defaultModel: "summary-model",
      bindPerModel: false,
    }),
    getProviderModelSettings: async () => null,
  };
  const runtime = {
    chatLifecycle: lifecycle,
    buildSummaryResponse: async () => ({}),
  } as unknown as SessionRuntime;
  const execute: typeof nonstreamingProviderExecute = async ({ prompt, overrideMaxTokens, overrideTemperature }) => {
    capturedPrompt = prompt;
    capturedExecuteArgs = { overrideMaxTokens, overrideTemperature };
    return { text: "A concise summary." } as Awaited<ReturnType<typeof nonstreamingProviderExecute>>;
  };
  return new ChatSummaryService(stores, runtime, profiles as never, null, execute);
}

describe("PromptAssemblyService summary preparation", () => {
  it("keeps the summary-only loading rules and pins compaction against excluded layers", async () => {
    const messages = [
      { id: "msg_1", position: 0, role: "user", content: "one two three", branchId: "branch_1" },
      { id: "msg_2", position: 1, role: "assistant", content: "four five six", branchId: "branch_1" },
      { id: "msg_3", position: 2, role: "user", content: "seven eight nine", branchId: "branch_1" },
      { id: "msg_4", position: 3, role: "assistant", content: "ten eleven twelve", branchId: "branch_1" },
    ];
    let summaryLoads = 0;
    let scriptCalled = false;
    const stores = {
      chats: {
        getById: async () => ({ id: "chat_1", characterId: "char_1", personaId: "persona_1", promptPresetId: "preset_1", activeBranchId: "branch_1", messageHistoryLimit: 0 }),
        getBranches: async () => [{ id: "branch_1" }],
      },
      messages: { getMessages: async () => messages },
      personas: { listAll: async () => [{ id: "persona_1", defaultForNewChats: true }] },
      chatSummaries: { listByChatBranch: async () => { summaryLoads += 1; return []; } },
      characterAssets: { listByCharacter: async () => [] },
      diceRolls: { getRollsForMessages: async () => new Map() },
      experiences: { getAttachmentsForMessages: async () => new Map() },
    } as unknown as StoreContainer;
    const resolver: PromptAssemblyResolver = {
      getCharacter: async () => ({ id: "char_1", name: "Nora", description: "character words that are excluded from the summary output", personality: null, scenario: null }),
      getPersona: async () => ({ id: "persona_1", name: "Alex", description: "persona words that are excluded from the summary output" }),
      getPromptPreset: async () => ({ id: "preset_1", name: "P", text: "preset words that are excluded from the summary output", summary: "Summarize this history.", jailbreak: "jailbreak words that are excluded from the summary output", tools: "", prefill: "", authorsNote: "", authorsNoteDepth: 0 }),
      listActiveLoreEntries: async () => [{ id: "lore_1", title: "Lore", content: "lore words that are excluded from the summary output", priority: 1 }],
      listRetrievedMemories: async () => [],
      executeScripts: async () => {
        scriptCalled = true;
        return { personality: "", scenario: "", injectedMessages: [], errors: [], scriptRuns: [] };
      },
      getToolInstructions: () => null,
    };
    const fileStore = { dataRoot: "/mock", resolvePath: () => "/mock", readJson: async <T>() => null as T, writeJson: async () => {}, asyncWriteJson: async () => {} };
    setTokenCountFn((text) => text.trim() ? text.trim().split(/\s+/).length : 0);
    try {
      const service = new PromptAssemblyService(stores, resolver, fileStore);
      const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "test-model", summary: true, contextBudget: 24 });
      const history = result.prompt.layers.find((layer) => layer.id === "recent_history");

      expect(summaryLoads).toBe(0);
      expect(scriptCalled).toBe(true);
      expect(history?.text).toBe("USER: seven eight nine\n\nASSISTANT: ten eleven twelve");
      expect(result.prompt.layers.map((layer) => layer.id)).toEqual([
        "persona",
        "character_base",
        "recent_history",
        "prompt_preset_summary",
      ]);
    } finally {
      setTokenCountFn(() => 0);
    }
  });
});

describe("ChatSummaryService summary prompt reshape", () => {
  it("sends the full-summary instruction as the final user message", async () => {
    capturedPrompt = null;
    const service = makeSummaryService();

    await service.summarizeChat({
      chatId: "chat_1",
      providerProfileId: "profile_1",
      maxMessages: 20,
    });

    expect(capturedPrompt?.finalPayload).toEqual({
      messages: [
        { role: "system", content: "Character context", layerId: "character_base" },
        { role: "user", content: "Summarize the case.", layerId: "prompt_preset_summary" },
      ],
    });
  });

  it("sends the ranged-summary instruction as the final user message", async () => {
    capturedPrompt = null;
    const service = makeSummaryService();

    await service.generateChatSummary({
      chatId: "chat_1",
      providerProfileId: "profile_1",
      summarizedFrom: 2,
      summarizedTo: 4,
    });

    expect(capturedPrompt?.finalPayload).toEqual({
      messages: [
        { role: "system", content: "Character context", layerId: "character_base" },
        { role: "user", content: "Summarize the case.", layerId: "prompt_preset_summary" },
      ],
    });
  });

  it("keeps the pure reshape contract", () => {
    expect(withSummaryPromptAsFinalUserMessage(summaryPrompt).finalPayload).toEqual({
      messages: [
        { role: "system", content: "Character context", layerId: "character_base" },
        { role: "user", content: "Summarize the case.", layerId: "prompt_preset_summary" },
      ],
    });
  });
});

// ─── SUMMARY_PRIOR_CONTEXT_PLAN W4 (SPC-4): default summary prompt ────
//
// resolveSummaryPrompt returns the trimmed preset text byte-for-byte when the
// preset carries one, and falls back to the bundled summary-ai-prompt.md asset
// otherwise — so an empty `preset.summary` no longer produces an instruction-less
// summary call.
describe("Summary prompt fallback (SPC-4)", () => {
  it("returns the trimmed preset text byte-for-byte when present", async () => {
    const out = await resolveSummaryPrompt("  my dream summary prompt  ");
    expect(out).toBe("my dream summary prompt");
  });

  it("falls back to the bundled default asset when preset is empty/whitespace", async () => {
    const out = await resolveSummaryPrompt("   ");
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain("continuity engine");
  });

  it("falls back to the bundled default asset when preset is null/undefined", async () => {
    const fromNull = await resolveSummaryPrompt(null);
    const fromUndefined = await resolveSummaryPrompt(undefined);
    expect(fromNull.trim().length).toBeGreaterThan(0);
    expect(fromNull).toBe(fromUndefined);
  });

  it("the default asset is authored for the prior-context strategy", async () => {
    const out = await resolveSummaryPrompt(null);
    // read-only continuity framing, no re-summarize, language-neutral.
    expect(out).toContain("Prior summaries");
    expect(out.toLowerCase()).toContain("do not repeat");
  });
});

// ─── SUM-2: per-call sampler overrides thread to the executor, and the
// hardcoded maxOutputTokens=16384 is gone (absent override = inherit profile).
// Pins the service → nonstreamingProviderExecute boundary for sampler args
// and the service → assembler boundary for contextBudget. ─────────────────
describe("ChatSummaryService sampler override threading (SUM-2)", () => {
  it("inherits the profile sampler when no override is given (no hardcoded 16384)", async () => {
    capturedExecuteArgs = null;
    const service = makeSummaryService();

    await service.generateChatSummary({
      chatId: "chat_1",
      providerProfileId: "profile_1",
      summarizedFrom: 2,
      summarizedTo: 4,
    });

    expect(capturedExecuteArgs).toEqual({ overrideMaxTokens: undefined, overrideTemperature: undefined });
  });

  it("forwards temperature + maxOutputTokens overrides to the executor", async () => {
    capturedExecuteArgs = null;
    const service = makeSummaryService();

    await service.generateChatSummary({
      chatId: "chat_1",
      providerProfileId: "profile_1",
      summarizedFrom: 2,
      summarizedTo: 4,
      temperature: 0.3,
      maxOutputTokens: 8192,
    });

    expect(capturedExecuteArgs).toEqual({ overrideMaxTokens: 8192, overrideTemperature: 0.3 });
  });

  it("forwards a contextBudget override to the ranged assembler", async () => {
    capturedAssembleRangedArgs = null;
    const service = makeSummaryService();

    await service.generateChatSummary({
      chatId: "chat_1",
      providerProfileId: "profile_1",
      summarizedFrom: 2,
      summarizedTo: 4,
      contextBudget: 32768,
    });

    expect(capturedAssembleRangedArgs).toEqual({ contextBudget: 32768 });
  });

  it("drops the hardcoded 16384 from the legacy full-summary path too", async () => {
    capturedExecuteArgs = null;
    const service = makeSummaryService();

    await service.summarizeChat({
      chatId: "chat_1",
      providerProfileId: "profile_1",
      maxMessages: 20,
    });

    expect(capturedExecuteArgs).toEqual({ overrideMaxTokens: undefined, overrideTemperature: undefined });
  });
});
