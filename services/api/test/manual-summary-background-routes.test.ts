/** BR-1d: real routes/adapter/service/SQLite; only the provider executor is injected. */
import { afterEach, describe, expect, test } from "bun:test";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { manualSummaryRunStateSchema, manualSummaryStopResponseSchema } from "@vibe-tavern/api-contracts";
import { createStoreContainer } from "@vibe-tavern/db";
import { EventBus, type ChatNotification } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { createChatRoutes } from "../src/api/routes/chat.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { AssetService } from "../src/domain/asset/asset-service.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError, providerError } from "../src/shared/errors.js";
import { makeProviderProfilesFixture, makeProviderProfileRow } from "./copilot-test-builders.js";

type Execute = typeof nonstreamingProviderExecute;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function result(text = "Saved memory."): Awaited<ReturnType<Execute>> {
  return { text } as Awaited<ReturnType<Execute>>;
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function gate() {
  const entered = deferred<void>();
  const release = deferred<Awaited<ReturnType<Execute>>>();
  cleanups.push(() => release.resolve(result()));
  let signal: AbortSignal | undefined;
  const execute: Execute = async (input) => { signal = input.signal; entered.resolve(); return release.promise; };
  return { entered, release, execute, signal: () => signal };
}

async function setup(execute: Execute = async () => result()) {
  const stores = await createStoreContainer(":memory:");
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  async function createChat(name: string) {
    const created = await runtime.character.createFromScratch({ name, firstMessage: "Hello" });
    const chat = await stores.chats.getById(created.activeChatId);
    if (!chat) throw new Error("Missing seed chat");
    await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "user", authorType: "user", content: "Remember this." });
    await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "assistant", authorType: "character", content: "I will." });
    return chat;
  }
  const chat = await createChat("Background memory");
  const events = new EventBus();
  const notifications: ChatNotification[] = [];
  events.on("chat.notification", (notification) => { notifications.push(notification); });
  const profiles = makeProviderProfilesFixture(
    {
      getProviderProfile: async (id: string) =>
        id === "profile"
          ? makeProviderProfileRow({ id, providerPreset: "openai", defaultModel: "summary-model", bindPerModel: false })
          : null,
      getProviderModelSettings: async () => null,
    },
    "ProviderProfileService (manual-summary-background-routes)",
  );
  const service = new ChatSummaryService(stores, runtime, profiles, events, execute);
  const adapter = new ChatAdapter(stores, runtime, {} as LiveChatOrchestrator, service, profiles, {} as AssetService, async () => null);
  const app = createChatRoutes(adapter);
  app.onError((error, c) => isDomainError(error)
    ? c.json(domainErrorToJson(error), httpStatusForDomainError(error) as ContentfulStatusCode)
    : c.json({ error: error.message }, 500));
  const input = { providerProfileId: "profile", summarizedFrom: 1, summarizedTo: 2, label: "Manual memory" };
  const path = `/api/chats/${chat.id}/summaries/generate`;
  function start(signal?: AbortSignal, body = input, chatId = chat.id) {
    return app.request(`/api/chats/${chatId}/summaries/generate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
  }
  return { stores, runtime, chat, events, notifications, service, adapter, app, input, path, start, createChat };
}

describe("manual summary routes", () => {
  test("a watched ranged summary retains its existing response and saved fields", async () => {
    const h = await setup();
    const response = await h.start();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["chatSummary", "snapshot", "summary"]);
    expect(body.summary).toBe("Saved memory.");
    expect(body.chatSummary).toMatchObject({ label: "Manual memory", summarizedFrom: 1, summarizedTo: 2, source: "manual", content: "Saved memory.\n" });
    expect(body.snapshot.summaries).toHaveLength(1);
    expect((await h.stores.chatSummaries.getById(body.chatSummary.id))?.content).toBe(body.chatSummary.content);
    expect(h.notifications.map(({ kind }) => kind)).toEqual(["summary.started", "summary.generated"]);
  });

  test("the legacy summary route still forwards its request signal and uses its old response", async () => {
    let signal: AbortSignal | undefined;
    const h = await setup(async (input) => { signal = input.signal; return result(); });
    const client = new AbortController();
    const response = await h.app.request(`/api/chats/${h.chat.id}/summary`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerProfileId: "profile", maxMessages: 3 }), signal: client.signal,
    });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(["snapshot", "summary"]);
    client.abort();
    expect(signal?.aborted).toBe(true);
    expect(h.notifications).toEqual([]);
  });

  test("disconnect during generation does not abort the job; the summary is saved and generated fires", async () => {
    const provider = gate();
    const h = await setup(provider.execute);
    const generated = deferred<void>();
    h.events.on("chat.notification", (event) => { if (event.kind === "summary.generated") generated.resolve(); });
    const client = new AbortController();
    const pending = h.start(client.signal);
    await provider.entered.promise;
    client.abort();
    expect(provider.signal()?.aborted).toBe(false);
    provider.release.resolve(result());
    await generated.promise;
    const saved = await h.stores.chatSummaries.listByChatBranch(h.chat.id, h.chat.activeBranchId);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe("Saved memory.\n");
    expect(h.notifications).toEqual([
      { chatId: h.chat.id, kind: "summary.started", source: "manual" },
      { chatId: h.chat.id, kind: "summary.generated", source: "manual", summaryId: saved[0]!.id, label: "Manual memory" },
    ]);
    expect((await pending).status).toBe(200);
    expect(await (await h.app.request(h.path)).json()).toBeNull();
  });

  test("GET returns only this chat's running range/label/time and clears after completion", async () => {
    const provider = gate();
    const h = await setup(provider.execute);
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    const pending = h.start(undefined, { ...h.input, label: "" });
    await provider.entered.promise;
    const response = await h.app.request(h.path);
    expect(response.status).toBe(200);
    const state = manualSummaryRunStateSchema.parse(await response.json());
    expect(state).toMatchObject({ from: 1, to: 2, label: "T1–T2" });
    expect(Number.isSafeInteger(state?.startedAt)).toBe(true);
    expect(await (await h.app.request("/api/chats/other/summaries/generate")).json()).toBeNull();
    provider.release.resolve(result());
    const body = await (await pending).json();
    expect(body.chatSummary.label).toBe(state?.label);
    expect(manualSummaryRunStateSchema.parse(await (await h.app.request(h.path)).json())).toBeNull();
  });

  test("explicit stop aborts the provider, emits cancelled, saves nothing, and settles a waiting POST as 499", async () => {
    const entered = deferred<void>();
    let providerSignal: AbortSignal | undefined;
    const h = await setup((input) => new Promise((_resolve, reject) => {
      providerSignal = input.signal;
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      entered.resolve();
    }));
    const pending = h.start();
    await entered.promise;
    const response = await h.app.request(`${h.path}/stop`, { method: "POST" });
    expect(manualSummaryStopResponseSchema.parse(await response.json())).toEqual({ stopped: true });
    expect(providerSignal?.aborted).toBe(true);
    expect((await pending).status).toBe(499);
    expect(h.notifications.map(({ kind }) => kind)).toEqual(["summary.started", "summary.cancelled"]);
    expect(await h.stores.chatSummaries.listByChatBranch(h.chat.id, h.chat.activeBranchId)).toEqual([]);
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    expect(await (await h.app.request(`${h.path}/stop`, { method: "POST" })).json()).toEqual({ stopped: false });
  });

  test("an executor ignoring stop cannot save a late result or release its slot before settlement", async () => {
    const provider = gate();
    const h = await setup(provider.execute);
    const pending = h.start();
    await provider.entered.promise;
    await h.app.request(`${h.path}/stop`, { method: "POST" });
    expect(provider.signal()?.aborted).toBe(true);
    expect(await (await h.app.request(h.path)).json()).not.toBeNull();
    expect((await h.start()).status).toBe(409);
    provider.release.resolve(result("Too late"));
    expect((await pending).status).toBe(499);
    expect(await h.stores.chatSummaries.listByChatBranch(h.chat.id, h.chat.activeBranchId)).toEqual([]);
    expect(h.notifications.map(({ kind }) => kind)).toEqual(["summary.started", "summary.cancelled"]);
    expect((await h.start()).status).toBe(200);
  });

  test("concurrent duplicate sends return JSON 409 and do not start another provider or notification", async () => {
    const provider = gate();
    let calls = 0;
    const h = await setup(async (input) => { calls++; return provider.execute(input); });
    const pending = h.start();
    await provider.entered.promise;
    const duplicates = await Promise.all([h.start(), h.start()]);
    for (const duplicate of duplicates) {
      expect(duplicate.status).toBe(409);
      expect(duplicate.headers.get("content-type")).toContain("application/json");
      expect(await duplicate.json()).toMatchObject({ code: "AGENT_RUN_ACTIVE" });
    }
    expect(calls).toBe(1);
    expect(h.notifications.map(({ kind }) => kind)).toEqual(["summary.started"]);
    provider.release.resolve(result());
    expect((await pending).status).toBe(200);
  });

  test("different chats run independently; stopping one cannot cancel the other", async () => {
    const a = gate();
    const b = gate();
    let calls = 0;
    const h = await setup((input) => (++calls === 1 ? a : b).execute(input));
    const other = await h.createChat("Other memory");
    const pendingA = h.start();
    await a.entered.promise;
    const pendingB = h.start(undefined, h.input, other.id);
    await b.entered.promise;
    await h.app.request(`${h.path}/stop`, { method: "POST" });
    expect(a.signal()?.aborted).toBe(true);
    expect(b.signal()?.aborted).toBe(false);
    a.release.resolve(result());
    b.release.resolve(result("Other saved memory."));
    expect((await pendingA).status).toBe(499);
    expect((await pendingB).status).toBe(200);
    expect(await h.stores.chatSummaries.listByChatBranch(h.chat.id, h.chat.activeBranchId)).toHaveLength(0);
    expect((await h.stores.chatSummaries.listByChatBranch(other.id, other.activeBranchId))[0]?.content).toBe("Other saved memory.\n");
  });

  test("provider failures preserve the HTTP error family and release the run for retry", async () => {
    let calls = 0;
    const h = await setup(async () => {
      if (++calls === 1) throw providerError("Provider unavailable");
      return result();
    });
    expect((await h.start(undefined, { ...h.input, providerProfileId: "missing" })).status).toBe(404);
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    const failed = await h.start();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { kind: "Provider", message: "Provider unavailable" } });
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    expect((await h.start()).status).toBe(200);
    expect(h.notifications.map(({ kind }) => kind)).toEqual(["summary.started", "summary.failed", "summary.started", "summary.failed", "summary.started", "summary.generated"]);
  });

  test("invalid JSON input is rejected before a run; missing runs stop quietly", async () => {
    const h = await setup();
    const response = await h.app.request(h.path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...h.input, summarizedFrom: 0 }),
    });
    expect(response.status).toBe(400);
    expect(h.notifications).toEqual([]);
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    expect(await (await h.app.request(`${h.path}/stop`, { method: "POST" })).json()).toEqual({ stopped: false });
  });

  test("automatic summaries retain their original events and are not blocked or stopped by a manual run", async () => {
    const manual = gate();
    let calls = 0;
    const h = await setup((input) => ++calls === 1 ? manual.execute(input) : Promise.resolve(result("Automatic memory.")));
    await h.stores.chats.updateMemorySettings(h.chat.id, {
      autoSummaryConfig: { ...h.chat.autoSummaryConfig, enabled: true, everyN: 1, useChatModel: false, providerProfileId: "profile" },
    });
    const pending = h.start();
    await manual.entered.promise;
    await h.service.triggerAutoSummary(h.chat.id);
    expect(await (await h.app.request(h.path)).json()).not.toBeNull();
    const automatic = await h.stores.chatSummaries.listByChatBranch(h.chat.id, h.chat.activeBranchId);
    expect(automatic).toHaveLength(1);
    expect(h.notifications.filter((event) => event.source !== "manual")).toEqual([
      { chatId: h.chat.id, kind: "summary.started" },
      { chatId: h.chat.id, kind: "summary.generated", summaryId: automatic[0]!.id, label: automatic[0]!.label },
    ]);
    manual.release.resolve(result());
    expect((await pending).status).toBe(200);
    expect(await h.stores.chatSummaries.listByChatBranch(h.chat.id, h.chat.activeBranchId)).toHaveLength(2);
  });
});
