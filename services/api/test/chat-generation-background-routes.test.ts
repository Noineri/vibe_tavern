/** BR-4a: real HTTP, adapter, orchestrator, mode assembly and SQLite. Only the
 * provider executor is injected; parked deltas make disconnect/stop deterministic. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer } from "@vibe-tavern/db";
import { EventBus, type AgentRunNotification } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createChatRoutes } from "../src/api/routes/chat.js";
import { createAgentRunEventsFeature } from "../src/domain/agent/agent-run-events-feature.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { getChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import type { ProviderExecutionInput, ExtractedToolResult } from "../src/infrastructure/ai/provider-execution-types.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { AgentRunActiveError } from "../src/domain/agent/agent-run-registry.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { guardModelDiscovery } from "./model-discovery-guard.js";

guardModelDiscovery("provider.invalid");

type Mode = "rp" | "coauthor";
type Operation = "send" | "regenerate" | "continue" | "generate";
const operations: Operation[] = ["send", "regenerate", "continue", "generate"];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Frame = { id: number; event: string; data: Record<string, unknown> };
function readSse(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    cancel: () => reader.cancel(),
    async next(): Promise<Frame | null> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = frame.split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (!event) continue;
          return { id: Number(lines.find((line) => line.startsWith("id:"))?.slice(3)), event,
            data: JSON.parse(lines.find((line) => line.startsWith("data:"))!.slice(5)) };
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}
async function all(response: Response): Promise<Frame[]> {
  const client = readSse(response);
  const frames: Frame[] = [];
  try { for (let frame = await client.next(); frame; frame = await client.next()) frames.push(frame); }
  finally { await client.cancel(); }
  return frames;
}

async function withEnv(mode: Mode, run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vt-chat-background-"));
  let h: Awaited<ReturnType<typeof setup>> | undefined;
  try { h = await setup(mode, dir); await run(h); }
  finally {
    if (h) {
      h.adapter.generationQueue.deactivate();
      h.release.resolve();
      for (const active of h.adapter.agentRuns.active()) {
        h.adapter.agentRuns.stop(active.threadId);
        const running = h.adapter.agentRuns.subscribe(active.threadId)!;
        for await (const _event of running) { /* Join every chat, including parallel-chat cases. */ }
      }
      const sub = h.adapter.subscribeChatGeneration(h.chat.id, 0);
      if (sub) for await (const _event of sub) { /* Join persistence before DB/filesystem cleanup. */ }
      await h.adapter.generationQueue.kick(h.chat.id);
      h.feature.deactivate?.();
    }
    await rm(dir, { recursive: true, force: true });
  }
}
async function setup(mode: Mode, dir: string) {
  const stores = await createStoreContainer(":memory:", dir);
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const profiles = createProviderProfileService(stores.providers, stores.proxies);
  const profile = await stores.providers.create({ name: "Background", providerPreset: "multiai", endpoint: "https://provider.invalid/v1", defaultModel: "test-model" });
  // These text-only fixture models include the explicit queue overrides below.
  await stores.providers.saveCachedModels(profile.id, ["test-model", "first", "second", "third", "one", "two", "cut", "next", "queued"].map((modelSlug) => ({
    modelSlug, modelName: modelSlug, contextLength: null, capabilities: { vision: false },
  })));
  await profiles.activateProviderProfile(profile.id);
  await stores.uiSettings.update({ coauthorProviderId: profile.id });
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: () => profiles.resolveActiveProviderProfile() });
  const created = await runtime.character.createFromScratch({ name: "Background character", description: "A probe", firstMessage: "Original reply" });
  const rp = (await stores.chats.getById(created.activeChatId))!;
  const chat = mode === "rp" ? rp : (await stores.chats.getById((await runtime.chatLifecycle.createChatForCharacter(rp.characterId, mode)).activeChat.id))!;
  const assistant = await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "assistant", authorType: "character", content: "Continue here" });
  const release = deferred();
  const entered = deferred();
  const inputs: ProviderExecutionInput[] = [];
  const provider = { fail: false, ask: false, parkNative: false, proposals: [] as ExtractedToolResult[] };
  const events = new EventBus();
  const lifecycle: AgentRunNotification[] = [];
  events.on("agent.run", (event) => { lifecycle.push(event); });
  const orchestrator = new LiveChatOrchestrator(runtime.chatRuntime, runtime.chatApp, new ProviderOrchestrator(profiles), events,
    async () => getChatModeStrategy(mode), undefined, undefined, {
      nonstreaming: async (input) => {
        inputs.push(input);
        if (provider.parkNative) { entered.resolve(); await release.promise; input.signal?.throwIfAborted(); }
        return { text: "Native reply", providerResponse: { mode: "nonstream", steps: [] },
          toolCalls: provider.proposals.map((result) => ({ toolCallId: result.toolCallId, toolName: result.toolName, args: result.args })),
          toolResults: provider.proposals };
      },
      stream: async (input) => {
        inputs.push(input);
        return {
          stream: (async function* () {
            yield { type: "reasoning-delta" as const, textDelta: "Thinking" };
            yield { type: "text-delta" as const, delta: "Partial reply" };
            for (const result of provider.proposals) {
              yield { type: "tool-call" as const, toolCallId: result.toolCallId, toolName: result.toolName, args: result.args };
              yield { type: "tool-result" as const, toolCallId: result.toolCallId, toolName: result.toolName, output: result.result, isError: result.isError };
            }
            // The registry is pulling after the first delta before we park.
            if (input.signal?.aborted) release.resolve();
            else input.signal?.addEventListener("abort", release.resolve, { once: true });
            entered.resolve();
            await release.promise;
            input.signal?.throwIfAborted();
            if (provider.fail) throw new Error("Provider cut");
            if (provider.ask) {
              yield { type: "tool-input-start" as const, toolCallId: "ask-1", toolName: "ask_user" };
              yield { type: "tool-input-delta" as const, toolCallId: "ask-1", inputTextDelta: '{"question":"Which?"}' };
              yield { type: "tool-call" as const, toolCallId: "ask-1", toolName: "ask_user", args: { question: "Which?" } };
              yield { type: "tool-result" as const, toolCallId: "ask-1", toolName: "ask_user", output: { status: "awaiting_answer", question: "Which?" } };
            }
            yield { type: "text-delta" as const, delta: " completed" };
          })(),
          text: Promise.resolve("Partial reply completed"), reasoning: Promise.resolve("Thinking"),
          finished: Promise.resolve({ finishReason: "stop" }), providerResponse: { mode: "stream", steps: [] },
        };
      },
    });
  const copilot = new ExperienceCopilotAdapter(stores);
  const adapter = new ChatAdapter(stores, runtime, orchestrator, new ChatSummaryService(stores, runtime, profiles), profiles,
    new AssetService(join(dir, "assets")), async () => null, undefined, copilot.agentRuns);
  const app = createChatRoutes(adapter);
  app.onError((error, c) => {
    if (error instanceof AgentRunActiveError) return c.json({ error: error.message, code: error.code }, 409);
    if (isDomainError(error)) return c.json(domainErrorToJson(error), httpStatusForDomainError(error) as ContentfulStatusCode);
    throw error;
  });
  const feature = createAgentRunEventsFeature({ registry: copilot.agentRuns });
  feature.activate({ events, router: app });
  await adapter.generationQueue.activate(events);
  const path = `/api/chats/${chat.id}`;
  const operationPath = (operation: Operation) => operation === "send" ? `${path}/messages/stream`
    : operation === "generate" ? `${path}/generate-reply/stream` : `${path}/messages/${assistant.id}/${operation}/stream`;
  const start = (operation: Operation, signal?: AbortSignal) => app.request(operationPath(operation), {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    ...(operation === "send" ? { body: JSON.stringify({ content: "User turn" }) } : operation === "regenerate" ? { body: "{}" } : {}),
  });
  return { stores, runtime, chat, assistant, inputs, provider, entered, release, adapter, copilot, orchestrator, app, feature, path, start, lifecycle };
}

test("queue routes execute ordered overrides without a browser and expose replay/409 while running", async () => {
  await withEnv("rp", async (h) => {
    const preset = await h.stores.presets.create({ name: "Queued preset", systemPrompt: "Queue-specific system instructions" });
    const post = (model: string, promptPresetId: string | null = null) => h.app.request(`${h.path}/queue`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: h.assistant.id, model, promptPresetId }) });
    const first = await post("first");
    expect(first.status).toBe(201);
    await h.entered.promise;
    await post("second", preset.id); await post("third");
    const pending = await (await h.app.request(`${h.path}/queue`)).json();
    expect(pending.map((job: { status: string }) => job.status)).toEqual(["running", "pending", "pending"]);
    for (const operation of operations) {
      const conflict = await h.start(operation);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: "AGENT_RUN_ACTIVE" });
    }
    const conflict = await h.app.request(`${h.path}/messages/${h.assistant.id}/regenerate`, { method: "POST" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "AGENT_RUN_ACTIVE" });
    const reader = readSse(await h.app.request(`${h.path}/generation`));
    expect((await reader.next())?.data).toMatchObject({ messageId: h.assistant.id, operation: "regenerate" });
    await reader.cancel();
    h.release.resolve();
    await h.adapter.generationQueue.kick(h.chat.id);
    expect(h.inputs.map((input) => input.model)).toEqual(["first", "second", "third"]);
    expect(JSON.stringify(h.inputs[1]?.prompt)).toContain("Queue-specific system instructions");
    expect((await h.stores.messages.getVariants(h.assistant.id))[2]?.presetName).toBe("Queued preset");
    expect((await h.stores.chats.getById(h.chat.id))?.promptPresetId).toBe(h.chat.promptPresetId);
    const settled = await (await h.app.request(`${h.path}/queue`)).json();
    expect(settled.map((job: { status: string; variantIndex: number }) => [job.status, job.variantIndex])).toEqual([["done", 1], ["done", 2], ["done", 3]]);
    expect(h.lifecycle.map((event) => event.state)).toEqual(["started", "finished", "started", "finished", "started", "finished"]);
  });
});

test("queue DELETE stops with a saved partial on the original branch and next pending job continues there", async () => {
  await withEnv("rp", async (h) => {
    const first = await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "first", promptPresetId: null });
    await h.entered.promise;
    await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "second", promptPresetId: null });
    const fork = await h.runtime.chatRuntime.forkBranch(h.chat.id, h.assistant.id);
    const response = await h.app.request(`${h.path}/queue/${first.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    await h.adapter.generationQueue.kick(h.chat.id);
    const jobs = await h.adapter.getGenerationQueue(h.chat.id);
    expect(jobs.map((job) => [job.status, job.variantIndex])).toEqual([["cancelled", 1], ["done", 2]]);
    expect((await h.stores.messages.getVariants(h.assistant.id)).map((variant) => variant.content)).toEqual(["Continue here", "Partial reply", "Partial reply completed"]);
    expect((await h.stores.chats.getById(h.chat.id))?.activeBranchId).toBe(fork.activeBranch.id);
    const replay = await all(await h.app.request(`${h.path}/generation`));
    expect(replay[0]?.data.branchId).toBe(h.chat.activeBranchId);
    expect(h.lifecycle.map((event) => event.state)).toEqual(["started", "stopped", "started", "finished"]);
  });
});

test("queue routes reject malformed/foreign targets, cancel only pending, and Clear preserves the ordinary regenerate", async () => {
  await withEnv("rp", async (h) => {
    const ordinary = await h.start("regenerate");
    const watch = all(ordinary);
    await h.entered.promise;
    expect(await h.adapter.getGenerationQueue(h.chat.id)).toEqual([]); // D4: first regenerate is not queued.
    const one = await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "one", promptPresetId: null });
    await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "two", promptPresetId: null });
    expect((await h.app.request(`${h.path}/queue/${one.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await h.app.request(`${h.path}/queue/clear`, { method: "POST" })).status).toBe(200);
    expect((await h.adapter.getGenerationQueue(h.chat.id)).map((job) => job.status)).toEqual(["cancelled"]);
    expect(h.adapter.agentRuns.active()).toHaveLength(1);
    const invalid = await h.app.request(`${h.path}/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"messageId":"foreign","model":""}' });
    expect(invalid.status).toBe(400);
    const missing = await h.app.request(`${h.path}/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"messageId":"foreign","model":"one","promptPresetId":null}' });
    expect(missing.status).toBe(404);
    expect((await h.app.request("/api/chats/missing/queue")).status).toBe(404);
    h.release.resolve(); await watch; await h.adapter.generationQueue.kick(h.chat.id);
    expect(h.inputs).toHaveLength(1);
  });
});

test("a queued provider cut retains its partial variant and a later job still succeeds", async () => {
  await withEnv("rp", async (h) => {
    h.provider.fail = true;
    h.adapter.agentRuns.onLifecycle((event) => { if (event.state === "failed") h.provider.fail = false; });
    await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "cut", promptPresetId: null });
    await h.entered.promise;
    await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "next", promptPresetId: null });
    h.release.resolve(); await h.adapter.generationQueue.kick(h.chat.id);
    expect(await h.adapter.getGenerationQueue(h.chat.id)).toMatchObject([{ status: "failed", error: "Provider cut", variantIndex: 1 }, { status: "done", variantIndex: 2 }]);
    expect((await h.stores.messages.getVariants(h.assistant.id)).map((variant) => variant.content)).toEqual(["Continue here", "Partial reply", "Partial reply completed"]);
  });
});

test("a standalone native regenerate owns the chat slot before queued work and is never itself a queue job", async () => {
  await withEnv("rp", async (h) => {
    h.provider.parkNative = true;
    const native = h.app.request(`${h.path}/messages/${h.assistant.id}/regenerate`, { method: "POST" });
    await h.entered.promise;
    await h.adapter.enqueueGenerationJob(h.chat.id, { messageId: h.assistant.id, model: "queued", promptPresetId: null });
    await h.adapter.generationQueue.kick(h.chat.id);
    expect((await h.adapter.getGenerationQueue(h.chat.id)).map((job) => job.status)).toEqual(["pending"]);
    expect(h.inputs).toHaveLength(1);
    expect((await h.start("send")).status).toBe(409);
    h.release.resolve();
    expect((await native).status).toBe(200);
    await h.adapter.generationQueue.kick(h.chat.id);
    expect(h.inputs.map((input) => input.model)).toEqual(["test-model", "queued"]);
    expect(await h.adapter.getGenerationQueue(h.chat.id)).toMatchObject([{ status: "done", variantIndex: 2 }]);
    expect((await h.stores.messages.getVariants(h.assistant.id)).map((variant) => variant.content)).toEqual(["Continue here", "Native reply", "Partial reply completed"]);
  });
});

for (const mode of ["rp", "coauthor"] as const) {
  for (const operation of operations) {
    test(`${mode} ${operation}: watched event order, numbered payloads and persisted output stay unchanged`, async () => {
      await withEnv(mode, async (h) => {
        const response = await h.start(operation);
        expect(response.status).toBe(200);
        const watching = all(response);
        await h.entered.promise;
        h.release.resolve();
        const frames = await watching;
        expect(frames.map(({ event }) => event)).toEqual([
          "generation-context", ...(operation === "send" ? ["user-message-saved"] : []), "generation-metadata",
          ...(mode === "coauthor" && operation !== "continue" ? ["coauthor-module"] : []),
          "reasoning-delta", "text-delta", "text-delta", "reasoning-done", "finish",
        ]);
        expect(frames.map(({ id }) => id)).toEqual(frames.map((_, index) => index + 1));
        expect(frames[0]!.data).toMatchObject({ chatId: h.chat.id, branchId: h.chat.activeBranchId, operation,
          messageId: operation === "regenerate" || operation === "continue" ? h.assistant.id : null });
        expect(typeof frames[0]!.data.runId).toBe("string");
        expect(frames.find(({ event }) => event === "text-delta")!.data).toEqual({ delta: "Partial reply" });
        expect(frames.find(({ event }) => event === "reasoning-delta")!.data).toEqual({ delta: "Thinking" });
        expect(frames.at(-1)!.data.finishReason).toBe("stop");
        expect("messageCount" in frames.at(-1)!.data).toBe(operation === "send" || operation === "generate");
        const messages = await h.stores.messages.getMessages(h.chat.activeBranchId);
        const target = operation === "regenerate" || operation === "continue" ? await h.stores.messages.getMessageById(h.assistant.id) : messages.at(-1)!;
        expect(target!.content).toBe(`${operation === "continue" ? "Continue here" : ""}Partial reply completed`);
        expect((await h.stores.messages.getSelectedVariant(target!.id))!.reasoning).toBe("Thinking");
        expect(h.lifecycle.map(({ state }) => state)).toEqual(["started", "finished"]);
        expect(h.lifecycle[0]).toMatchObject({ title: "Background character", kind: mode, owner: { kind: "chat", chatId: h.chat.id, mode } });
      });
    });

    test(`${mode} ${operation}: disconnect persists; replay/live cursor and all competing stream routes return 409`, async () => {
      await withEnv(mode, async (h) => {
        const abort = new AbortController();
        const response = await h.start(operation, abort.signal);
        const client = readSse(response);
        const seen: Frame[] = [];
        try {
          while (seen.at(-1)?.event !== "text-delta") seen.push((await client.next())!);
          await h.entered.promise;
          abort.abort();
          await client.cancel();
          expect(h.inputs[0]!.signal!.aborted).toBe(false);
          expect(h.adapter.agentRuns).toBe(h.copilot.agentRuns);
          expect(await (await h.app.request("/api/agent-runs")).json()).toHaveLength(1);
          for (const competing of operations) {
            const duplicate = await h.start(competing);
            expect(duplicate.status).toBe(409);
            expect(await duplicate.json()).toMatchObject({ code: "AGENT_RUN_ACTIVE" });
          }
          const replaying = all(await h.app.request(`${h.path}/generation?after=${seen.at(-1)!.id}`));
          h.release.resolve();
          const rest = await replaying;
          expect(rest.map(({ event }) => event)).toEqual(["text-delta", "reasoning-done", "finish"]);
          const replay = await all(await h.app.request(`${h.path}/generation?after=0`));
          expect(replay.slice(0, seen.length)).toEqual(seen);
          expect(replay.slice(seen.length)).toEqual(rest);
          expect(await all(await h.app.request(`${h.path}/generation?after=${replay.at(-1)!.id}`))).toEqual([]);
          const messages = await h.stores.messages.getMessages(h.chat.activeBranchId);
          const target = operation === "regenerate" || operation === "continue" ? await h.stores.messages.getMessageById(h.assistant.id) : messages.at(-1)!;
          expect(target!.content).toBe(`${operation === "continue" ? "Continue here" : ""}Partial reply completed`);
          expect(h.lifecycle.at(-1)!.state).toBe("finished");
          expect(await (await h.app.request("/api/agent-runs")).json()).toEqual([]);
        } finally { h.release.resolve(); await client.cancel(); }
      });
    });

    test(`${mode} ${operation}: explicit stop persists the existing partial variant and releases only after finalization`, async () => {
      await withEnv(mode, async (h) => {
        const response = await h.start(operation);
        const watching = all(response);
        await h.entered.promise;
        const stopped = await h.app.request(`${h.path}/generation/stop`, { method: "POST" });
        expect(await stopped.json()).toEqual({ stopped: true });
        const frames = await watching;
        expect(frames.at(-1)).toMatchObject({ event: "abort", data: { partialLength: "Partial reply".length } });
        expect(frames.some(({ event }) => event === "error" || event === "finish")).toBe(false);
        const messages = await h.stores.messages.getMessages(h.chat.activeBranchId);
        const target = operation === "regenerate" || operation === "continue" ? await h.stores.messages.getMessageById(h.assistant.id) : messages.at(-1)!;
        // The established stop contract saves streamed text, NOT echoed prefill.
        expect(target!.content).toBe("Partial reply");
        expect((await h.stores.messages.getSelectedVariant(target!.id))!.reasoning).toBe("Thinking");
        expect(h.lifecycle.at(-1)!.state).toBe("stopped");
        expect(await (await h.app.request(`${h.path}/generation/stop`, { method: "POST" })).json()).toEqual({ stopped: false });
      });
    });
  }
}

test("generation discovery is empty until start and rejects malformed or unsafe replay cursors", async () => {
  await withEnv("rp", async (h) => {
    expect((await h.app.request(`${h.path}/generation`)).status).toBe(204);
    for (const cursor of ["-1", "1.5", "NaN", "9007199254740992", "Infinity"]) {
      expect((await h.app.request(`${h.path}/generation?after=${cursor}`)).status).toBe(400);
    }
    expect(await (await h.app.request(`${h.path}/generation/stop`, { method: "POST" })).json()).toEqual({ stopped: false });
  });
});

for (const mode of ["rp", "coauthor"] as const) for (const operation of operations) {
  test(`${mode} ${operation}: switching branches keeps result and trace on the starting branch`, async () => {
    await withEnv(mode, async (h) => {
      const originalBranch = h.chat.activeBranchId;
      const response = await h.start(operation);
      const watching = all(response);
      await h.entered.promise;
      const fork = await h.adapter.forkBranch(h.chat.id, h.assistant.id);
      expect(fork.activeBranch!.id).not.toBe(originalBranch);
      h.release.resolve();
      const frames = await watching;
      expect(frames[0]!.data).toMatchObject({ branchId: originalBranch, operation,
        messageId: operation === "regenerate" || operation === "continue" ? h.assistant.id : null });
      expect((await all(await h.app.request(`${h.path}/generation`)))[0]).toEqual(frames[0]!);
      const oldMessages = await h.stores.messages.getMessages(originalBranch);
      const newMessages = await h.stores.messages.getMessages(fork.activeBranch!.id);
      const target = operation === "regenerate" || operation === "continue" ? (await h.stores.messages.getMessageById(h.assistant.id))! : oldMessages.at(-1)!;
      const expected = `${operation === "continue" ? "Continue here" : ""}Partial reply completed`;
      expect(target.content).toBe(expected);
      expect(newMessages.some(({ content }) => content === expected)).toBe(false);
      const variant = (await h.stores.messages.getSelectedVariant(target.id))!;
      expect(await h.stores.traces.getTraceByVariant(h.chat.id, originalBranch, variant.id))
        .toMatchObject({ branchId: originalBranch, model: "test-model" });
    });
  });
}

test("a detached send retains validated dice/experience/editor/attachment/prefill inputs at the orchestrator seam", async () => {
  await withEnv("coauthor", async (h) => {
    const entered = deferred();
    let captured: Parameters<LiveChatOrchestrator["sendMessageStream"]>[0] | undefined;
    h.orchestrator.sendMessageStream = async function* (input) {
      captured = input;
      entered.resolve();
      await h.release.promise;
      yield { event: "finish", data: '{"finishReason":"stop"}' };
    };
    const body = {
      content: "One turn", diceMode: "immersive", pendingRevision: 7,
      experienceAttachmentId: "queued", experienceQueueRevision: 8, experienceSessionRevision: 9,
      prefill: "Once ", coauthorEditorState: { card: { name: "Draft", body: "Unsaved body", greetings: ["Hi"], cardClean: false }, review: { targets: [] } },
      attachments: [{ id: "att", assetId: "asset", name: "notes.txt", mimeType: "text/plain", type: "file", sizeBytes: 4 }],
    };
    const abort = new AbortController();
    const response = await h.app.request(`${h.path}/messages/stream`, {
      method: "POST", signal: abort.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      expect(response.status).toBe(200);
      await entered.promise;
      abort.abort();
      await response.body!.cancel();
      expect(captured).toMatchObject({
        chatId: h.chat.id, content: body.content, prefill: body.prefill, attachments: body.attachments,
        coauthorEditorState: body.coauthorEditorState, diceCommit: { mode: "immersive", pendingRevision: 7 },
        experienceCommit: { attachmentId: "queued", queueRevision: 8, sessionRevision: 9 },
      });
      expect(captured!.signal!.aborted).toBe(false);
      h.release.resolve();
      expect((await all(await h.app.request(`${h.path}/generation`))).at(-1)!.event).toBe("finish");
    } finally { h.release.resolve(); }
  });
});

for (const mode of ["rp", "coauthor"] as const) {
  test(`${mode}: cancelling only the response reader also preserves producer execution`, async () => {
    await withEnv(mode, async (h) => {
      const response = await h.start("generate");
      const client = readSse(response);
      while ((await client.next())!.event !== "text-delta") { /* Await the first persisted-on-stop boundary. */ }
      await h.entered.promise;
      await client.cancel();
      expect(h.inputs[0]!.signal!.aborted).toBe(false);
      // A replay subscriber can leave independently too.
      const replay = await h.app.request(`${h.path}/generation`);
      await replay.body!.cancel();
      expect(h.inputs[0]!.signal!.aborted).toBe(false);
      h.release.resolve();
      expect((await all(await h.app.request(`${h.path}/generation`))).at(-1)!.event).toBe("finish");
      expect(h.lifecycle.at(-1)!.state).toBe("finished");
    });
  });

  test(`${mode}: an unwatched provider failure retains partial text and a numbered replayable error`, async () => {
    await withEnv(mode, async (h) => {
      h.provider.fail = true;
      const response = await h.start("generate");
      await h.entered.promise;
      await response.body!.cancel();
      h.release.resolve();
      const frames = await all(await h.app.request(`${h.path}/generation`));
      expect(frames.at(-1)).toMatchObject({ event: "error", data: { message: "Provider cut", category: "unknown", partialSaved: true } });
      expect(frames.at(-1)!.id).toBe(frames.length);
      expect((await h.stores.messages.getMessages(h.chat.activeBranchId)).at(-1)!.content).toBe("Partial reply");
      expect(h.lifecycle.at(-1)!.state).toBe("failed");
    });
  });
}

test("Co-Author tools keep their ordered payloads and an unwatched ask publishes asking after persistence", async () => {
  await withEnv("coauthor", async (h) => {
    h.provider.ask = true;
    const response = await h.start("generate");
    await h.entered.promise;
    await response.body!.cancel();
    h.release.resolve();
    const frames = await all(await h.app.request(`${h.path}/generation`));
    expect(frames.filter(({ event }) => event.startsWith("tool-")).map(({ event, data }) => ({ event, data }))).toEqual([
      { event: "tool-input-start", data: { toolCallId: "ask-1", toolName: "ask_user" } },
      { event: "tool-input-delta", data: { toolCallId: "ask-1", delta: '{"question":"Which?"}' } },
      { event: "tool-call", data: { toolCallId: "ask-1", toolName: "ask_user", args: { question: "Which?" } } },
      { event: "tool-result", data: { toolCallId: "ask-1", toolName: "ask_user", output: { status: "awaiting_answer", question: "Which?" }, isError: false } },
    ]);
    const messages = await h.stores.messages.getMessages(h.chat.activeBranchId);
    expect(messages.find(({ role }) => role === "tool")!.content).toBe('{"status":"awaiting_answer","question":"Which?"}');
    expect(h.lifecycle.map(({ state }) => state)).toEqual(["started", "asking"]);
  });
});

test("a one-shot prefill still reaches the executor and is stitched into the saved detached send", async () => {
  await withEnv("rp", async (h) => {
    const response = await h.app.request(`${h.path}/messages/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "User turn", prefill: "Once " }),
    });
    await h.entered.promise;
    await response.body!.cancel();
    expect(h.inputs[0]!.prefill).toBe("Once ");
    h.release.resolve();
    await all(await h.app.request(`${h.path}/generation`));
    expect((await h.stores.messages.getMessages(h.chat.activeBranchId)).at(-1)!.content).toBe("Once Partial reply completed");
  });
});

test("different chats execute together; stopping one cannot stop the other", async () => {
  await withEnv("rp", async (h) => {
    const other = await h.adapter.createChatForCharacter(h.chat.characterId, "rp");
    const otherId = other.activeChat.id;
    const response = await h.start("generate");
    await h.entered.promise;
    await response.body!.cancel();
    const second = readSse(await h.app.request(`/api/chats/${otherId}/generate-reply/stream`, { method: "POST" }));
    try {
      while ((await second.next())!.event !== "text-delta") { /* Both producers have reached their parked deltas. */ }
      expect(h.adapter.agentRuns.active()).toHaveLength(2);
      expect(await (await h.app.request(`/api/chats/${otherId}/generation/stop`, { method: "POST" })).json()).toEqual({ stopped: true });
      expect(h.inputs[0]!.signal!.aborted).toBe(false);
      expect(h.inputs[1]!.signal!.aborted).toBe(true);
      // The provider's abort releases its parked read; the other turn completes.
      await all(await h.app.request(`/api/chats/${otherId}/generation`));
      await all(await h.app.request(`${h.path}/generation`));
      expect((await h.stores.messages.getMessages(h.chat.activeBranchId)).at(-1)!.content).toBe("Partial reply completed");
      expect((await h.stores.messages.getMessages(other.activeBranch.id)).at(-1)!.content).toBe("Partial reply");
    } finally { h.release.resolve(); await second.cancel(); }
  });
});

const proposalResult = (): ExtractedToolResult => ({ toolCallId: "profile", toolName: "write_profile", args: { profileMd: "Proposed card" }, result: { target: "profile", proposed: "Proposed card", summary: "Changed" }, isError: false });
const expectedReview = () => ({ _v: 1, activities: [{ toolCallId: "profile", toolName: "write_profile", status: "done", args: { profileMd: "Proposed card" }, target: "profile", proposed: "Proposed card", summary: "Changed" }] });

for (const operation of operations) {
  test(`Co-Author ${operation}: completed proposals persist before the detached finish, without applying the card`, async () => {
    await withEnv("coauthor", async (h) => {
      h.provider.proposals = [proposalResult()];
      const before = await h.stores.characters.getById(h.chat.characterId);
      const response = await h.start(operation);
      await h.entered.promise;
      await response.body!.cancel();
      h.release.resolve();
      const frames = await all(await h.app.request(`${h.path}/generation`));
      expect(frames.at(-1)!.event).toBe("finish");
      expect(await h.adapter.getCoauthorReview(h.chat.id)).toEqual(expectedReview());
      expect(h.lifecycle.at(-1)!.state).toBe("finished");
      expect(await h.stores.characters.getById(h.chat.characterId)).toEqual(before);
    });
  });

  test(`Co-Author ${operation}: completed proposals survive a later explicit stop`, async () => {
    await withEnv("coauthor", async (h) => {
      h.provider.proposals = [proposalResult()];
      const response = await h.start(operation);
      await h.entered.promise;
      await response.body!.cancel();
      await h.app.request(`${h.path}/generation/stop`, { method: "POST" });
      expect((await all(await h.app.request(`${h.path}/generation`))).at(-1)!.event).toBe("abort");
      expect(await h.adapter.getCoauthorReview(h.chat.id)).toEqual(expectedReview());
    });
  });

  test(`Co-Author ${operation}: native non-streaming tool results also persist review proposals`, async () => {
    await withEnv("coauthor", async (h) => {
      h.provider.proposals = [proposalResult()];
      const path = operation === "send" ? `${h.path}/messages` : operation === "generate" ? `${h.path}/generate-reply` : `${h.path}/messages/${h.assistant.id}/${operation}`;
      const response = await h.app.request(path, { method: "POST", headers: { "content-type": "application/json" },
        ...(operation === "send" ? { body: '{"content":"Native send"}' } : operation === "regenerate" ? { body: "{}" } : {}) });
      expect(response.status).toBe(200);
      await response.json();
      expect(await h.adapter.getCoauthorReview(h.chat.id)).toEqual(expectedReview());
    });
  });
}

test("no-proposal/error/read-only turns preserve existing Co-Author review bytes and timestamp", async () => {
  await withEnv("coauthor", async (h) => {
    await h.adapter.putCoauthorReview(h.chat.id, { _v: 1, activities: [{ toolCallId: "old", toolName: "write_profile", status: "done", target: "profile", proposed: "Keep" }] });
    const before = await h.stores.agentReviewRounds.getChat(h.chat.id);
    h.provider.proposals = [{ ...proposalResult(), isError: true }, { toolCallId: "read", toolName: "read_skill_file", args: {}, result: { path: "skill.md", content: "Read" }, isError: false }];
    const watching = all(await h.start("generate"));
    await h.entered.promise;
    h.release.resolve();
    await watching;
    expect(await h.stores.agentReviewRounds.getChat(h.chat.id)).toEqual(before);
    h.provider.proposals = [];
    await h.adapter.generateReply(h.chat.id);
    expect(await h.stores.agentReviewRounds.getChat(h.chat.id)).toEqual(before);
  });
});

test("a provider error after a successful tool result still stores its proposal before the error frame", async () => {
  await withEnv("coauthor", async (h) => {
    h.provider.proposals = [proposalResult()]; h.provider.fail = true;
    const watching = all(await h.start("generate"));
    await h.entered.promise;
    h.release.resolve();
    expect((await watching).at(-1)!.event).toBe("error");
    expect(await h.adapter.getCoauthorReview(h.chat.id)).toEqual(expectedReview());
    expect(h.lifecycle.at(-1)!.state).toBe("failed");
  });
});

test("RP tool-shaped output never creates a Co-Author review", async () => {
  await withEnv("rp", async (h) => {
    h.provider.proposals = [proposalResult()];
    const watching = all(await h.start("generate"));
    await h.entered.promise; h.release.resolve(); await watching;
    expect(await h.stores.agentReviewRounds.getChat(h.chat.id)).toBeNull();
  });
});

for (const stream of [true, false]) {
  test(`Co-Author ${stream ? "stream" : "native"}: greeting, lore and tracker proposals retain their typed review data`, async () => {
    await withEnv("coauthor", async (h) => {
      h.provider.proposals = [
        { toolCallId: "greeting", toolName: "edit_greeting", args: { index: 0, content: "Hi" }, result: { target: "greeting", proposed: "Hi", summary: "Greeting", greetingIndex: 0, isAdd: false }, isError: false },
        { toolCallId: "lore", toolName: "edit_lore", args: {}, result: { target: "lore_bundle", summary: "Lore", bundle: { revision: 3, lorebooks: [], entries: [] } }, isError: false },
        { toolCallId: "tracker", toolName: "set_tracker_template", args: {}, result: { summary: "Tracker", trackerTemplate: { version: 1, scene: { enabled: true, config: { schema: { mood: { $type: "string" } } } } } }, isError: false },
      ];
      if (stream) {
        const watching = all(await h.start("generate"));
        await h.entered.promise; h.release.resolve(); await watching;
      } else await h.adapter.generateReply(h.chat.id);
      const review = await h.adapter.getCoauthorReview(h.chat.id);
      expect(review!.activities.map(({ toolCallId }) => toolCallId)).toEqual(["greeting", "lore", "tracker"]);
      expect(review!.activities[0]).toMatchObject({ target: "greeting", proposed: "Hi", greetingIndex: 0, isAdd: false, args: { index: 0, content: "Hi" } });
      expect(review!.activities[1]!.loreBundle).toEqual({ revision: 3, lorebooks: [], entries: [] });
      expect(review!.activities[2]!.trackerTemplate).toMatchObject({ version: 1, scene: { enabled: true, config: { schema: { mood: { $type: "string" } } } } });
    });
  });
}

test("a producer review-write failure cannot announce successful completion", async () => {
  await withEnv("coauthor", async (h) => {
    h.provider.proposals = [proposalResult()];
    h.stores.agentReviewRounds.putChat = async () => { throw new Error("Review write failed"); };
    const watching = all(await h.start("generate"));
    await h.entered.promise; h.release.resolve();
    const frames = await watching;
    expect(frames.some(({ event }) => event === "finish")).toBe(false);
    expect(frames.at(-1)).toMatchObject({ event: "error", data: { message: "Review write failed" } });
    expect(h.lifecycle.at(-1)!.state).toBe("failed");
  });
});
