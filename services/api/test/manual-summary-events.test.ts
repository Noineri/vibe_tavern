/** BR-0b1: summary lifecycle around real assembly/persistence; only the provider is doubled. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStoreContainer } from "@vibe-tavern/db";
import { EventBus, type ChatNotification } from "@vibe-tavern/domain";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";

type Execute = typeof nonstreamingProviderExecute;
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function result(text = "Memory summary."): Awaited<ReturnType<Execute>> {
  return { text } as Awaited<ReturnType<Execute>>;
}

async function setup(execute: Execute = async () => result()) {
  const dir = await mkdtemp(join(tmpdir(), "vt-manual-summary-events-"));
  scratch.push(dir);
  const stores = await createStoreContainer(":memory:", dir);
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({ name: "Summary probe", firstMessage: "Hello" });
  const chat = await stores.chats.getById(created.activeChatId);
  if (!chat) throw new Error("Missing seed chat");
  await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "user", authorType: "user", content: "Remember this." });
  await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "assistant", authorType: "character", content: "I will." });
  const events = new EventBus();
  const notifications: ChatNotification[] = [];
  events.on("chat.notification", (notification) => { notifications.push(notification); });
  const profiles = {
    getProviderProfile: async () => ({ id: "profile", providerPreset: "openai", defaultModel: "summary-model", bindPerModel: false }),
    getProviderModelSettings: async () => null,
  } as unknown as ProviderProfileService;
  const service = new ChatSummaryService(stores, runtime, profiles, events, execute);
  const input = { chatId: chat.id, providerProfileId: "profile", summarizedFrom: 1, summarizedTo: 2, label: "Manual memory" };
  return { service, stores, chat, input, notifications };
}

describe("manual ranged summary notifications", () => {
  test("started precedes the model call; generated identifies the saved summary", async () => {
    const entered = deferred<void>();
    const provider = deferred<Awaited<ReturnType<Execute>>>();
    const env = await setup(async () => { entered.resolve(); return provider.promise; });
    const pending = env.service.generateChatSummary(env.input);
    await entered.promise;
    const notificationsBeforeResult = [...env.notifications];
    provider.resolve(result());
    const generated = await pending;
    expect(notificationsBeforeResult).toEqual([{ chatId: env.chat.id, kind: "summary.started", source: "manual" }]);
    expect(env.notifications).toEqual([
      { chatId: env.chat.id, kind: "summary.started", source: "manual" },
      { chatId: env.chat.id, kind: "summary.generated", source: "manual", summaryId: generated.chatSummary.id, label: "Manual memory" },
    ]);
    expect((await env.stores.chatSummaries.getById(generated.chatSummary.id))?.content).toBe("Memory summary.\n");
    expect(generated.summary).toBe("Memory summary.");
    expect(generated.snapshot.summaries).toHaveLength(1);
  });

  test("a provider failure emits failed, preserves the error and stores nothing", async () => {
    const error = new Error("Provider unavailable");
    const env = await setup(async () => { throw error; });
    await expect(env.service.generateChatSummary(env.input)).rejects.toBe(error);
    expect(env.notifications).toEqual([
      { chatId: env.chat.id, kind: "summary.started", source: "manual" },
      { chatId: env.chat.id, kind: "summary.failed", source: "manual" },
    ]);
    expect(await env.stores.chatSummaries.listByChatBranch(env.chat.id, env.chat.activeBranchId)).toEqual([]);
  });

  test("a user abort emits cancelled instead of failed and stores nothing", async () => {
    const entered = deferred<void>();
    const env = await setup(({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered.resolve();
    }));
    const controller = new AbortController();
    const pending = env.service.generateChatSummary({ ...env.input, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(env.notifications).toEqual([
      { chatId: env.chat.id, kind: "summary.started", source: "manual" },
      { chatId: env.chat.id, kind: "summary.cancelled", source: "manual" },
    ]);
    expect(await env.stores.chatSummaries.listByChatBranch(env.chat.id, env.chat.activeBranchId)).toEqual([]);
  });

  test("an executor that ignores cancellation cannot persist its late result", async () => {
    const entered = deferred<void>();
    const provider = deferred<Awaited<ReturnType<Execute>>>();
    const env = await setup(async () => { entered.resolve(); return provider.promise; });
    const controller = new AbortController();
    const pending = env.service.generateChatSummary({ ...env.input, signal: controller.signal });
    await entered.promise;
    controller.abort();
    provider.resolve(result());
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(env.notifications.map((notification) => notification.kind)).toEqual(["summary.started", "summary.cancelled"]);
    expect(await env.stores.chatSummaries.listByChatBranch(env.chat.id, env.chat.activeBranchId)).toEqual([]);
  });

  test("validation failures also settle the manual indicator", async () => {
    const env = await setup();
    await expect(env.service.generateChatSummary({ ...env.input, providerProfileId: "" })).rejects.toThrow("Provider profile is required");
    expect(env.notifications.map((notification) => notification.kind)).toEqual(["summary.started", "summary.failed"]);
  });

  test("automatic generation emits its original payloads exactly once", async () => {
    const env = await setup();
    await env.stores.chats.updateMemorySettings(env.chat.id, {
      autoSummaryConfig: { ...env.chat.autoSummaryConfig, enabled: true, everyN: 1, useChatModel: false, providerProfileId: "profile" },
    });
    await env.service.triggerAutoSummary(env.chat.id);
    const saved = await env.stores.chatSummaries.listByChatBranch(env.chat.id, env.chat.activeBranchId);
    expect(saved).toHaveLength(1);
    expect(env.notifications).toEqual([
      { chatId: env.chat.id, kind: "summary.started" },
      { chatId: env.chat.id, kind: "summary.generated", summaryId: saved[0]!.id, label: saved[0]!.label },
    ]);
  });

  test("automatic failures keep their original notification and swallowed-error boundary", async () => {
    const env = await setup(async () => { throw new Error("Provider unavailable"); });
    await env.stores.chats.updateMemorySettings(env.chat.id, {
      autoSummaryConfig: { ...env.chat.autoSummaryConfig, enabled: true, everyN: 1, useChatModel: false, providerProfileId: "profile" },
    });
    await env.service.triggerAutoSummary(env.chat.id);
    expect(env.notifications).toEqual([
      { chatId: env.chat.id, kind: "summary.started" },
      { chatId: env.chat.id, kind: "summary.failed" },
    ]);
  });
});
