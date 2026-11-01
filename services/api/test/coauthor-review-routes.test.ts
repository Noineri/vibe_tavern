/** Real routes/adapter/service/SQLite, no doubles or global state. */
import { expect, test } from "bun:test";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { createStoreContainer } from "@vibe-tavern/db";
import type { CoauthorReviewEnvelope } from "@vibe-tavern/api-contracts";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { createChatRoutes } from "../src/api/routes/chat.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";

function envelope(proposed = "New profile"): CoauthorReviewEnvelope {
  return { _v: 1, activities: [{ toolCallId: "write", toolName: "write_profile", status: "done", target: "profile", proposed, args: { profileMd: proposed }, summary: "Updated" }] };
}
async function setup() {
  const stores = await createStoreContainer(":memory:");
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores);
  const created = await runtime.character.createFromScratch({ name: "Review owner", firstMessage: "Hello" });
  const rp = (await stores.chats.getById(created.activeChatId))!;
  const coauthor = await runtime.chatLifecycle.createChatForCharacter(rp.characterId, "coauthor");
  // Only lifecycle/review methods are used; constructor dependencies stay local.
  const adapter = new ChatAdapter(stores, runtime, {} as ConstructorParameters<typeof ChatAdapter>[2], {} as ConstructorParameters<typeof ChatAdapter>[3], {} as ConstructorParameters<typeof ChatAdapter>[4], {} as ConstructorParameters<typeof ChatAdapter>[5], async () => null);
  const app = createChatRoutes(adapter);
  app.onError((error, c) => error instanceof HTTPException ? error.getResponse()
    : isDomainError(error) ? c.json(domainErrorToJson(error), httpStatusForDomainError(error) as ContentfulStatusCode) : c.json({ error: error.message }, 500));
  const chatId = coauthor.activeChat.id;
  const path = `/api/chats/${chatId}/coauthor/review`;
  const put = (body: unknown, url = path) => app.request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { stores, runtime, rp, chatId, app, path, put };
}

test("GET/PUT/replacement/DELETE preserve the CA-15 envelope and never apply it", async () => {
  const h = await setup();
  expect(await (await h.app.request(h.path)).json()).toBeNull();
  const before = await h.stores.characters.getById(h.rp.characterId);
  const saved = await h.put(envelope());
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual(envelope());
  expect(await (await h.app.request(h.path)).json()).toEqual(envelope());
  await h.put(envelope("Revised"));
  expect(JSON.parse((await h.stores.agentReviewRounds.getChat(h.chatId))!.envelopeJson)).toEqual(envelope("Revised"));
  expect(await h.stores.characters.getById(h.rp.characterId)).toEqual(before);
  for (let i = 0; i < 2; i++) expect(await (await h.app.request(h.path, { method: "DELETE" })).json()).toEqual({ ok: true });
  expect(await (await h.app.request(h.path)).json()).toBeNull();
  expect(await h.stores.chats.getById(h.chatId)).not.toBeNull();
});

test("malformed/version-skewed/transient/read-only envelopes cannot overwrite a saved proposal", async () => {
  const h = await setup();
  await h.put(envelope());
  for (const bad of [{}, { ...envelope(), _v: 2 }, { _v: 1, activities: [] }, { ...envelope(), activities: [{ ...envelope().activities[0], status: "streaming" }] },
    { _v: 1, activities: [{ toolCallId: "read", toolName: "read_skill_file", status: "done" }] }]) expect((await h.put(bad)).status).toBe(400);
  expect((await h.app.request(h.path, { method: "PUT", headers: { "content-type": "application/json" }, body: "{broken" })).status).toBe(400);
  expect(await (await h.app.request(h.path)).json()).toEqual(envelope());
});

test("missing and RP chats cannot read/write/delete Co-Author reviews", async () => {
  const h = await setup();
  for (const id of ["missing", h.rp.id]) {
    const path = `/api/chats/${id}/coauthor/review`;
    for (const method of ["GET", "DELETE"]) expect((await h.app.request(path, { method })).status).toBe(404);
    expect((await h.put(envelope(), path)).status).toBe(404);
    expect(await h.stores.agentReviewRounds.getChat(id)).toBeNull();
  }
});

test("chat deletion cascades only its review, retaining other chats and agent-thread bytes", async () => {
  const h = await setup();
  const other = await h.runtime.chatLifecycle.createChatForCharacter(h.rp.characterId, "coauthor");
  const thread = await h.stores.experienceCopilot.startNewSession("script", "Thread");
  await h.stores.agentReviewRounds.put(thread.id, "opaque legacy thread bytes");
  await h.put(envelope());
  await h.put(envelope("Other"), `/api/chats/${other.activeChat.id}/coauthor/review`);
  await h.stores.chats.delete(h.chatId);
  expect(await h.stores.agentReviewRounds.getChat(h.chatId)).toBeNull();
  expect((await h.stores.agentReviewRounds.get(thread.id))!.envelopeJson).toBe("opaque legacy thread bytes");
  expect(JSON.parse((await h.stores.agentReviewRounds.getChat(other.activeChat.id))!.envelopeJson)).toEqual(envelope("Other"));
});

test("corrupt JSON is reported without deleting it, and a valid PUT repairs the review", async () => {
  const h = await setup();
  await h.stores.agentReviewRounds.putChat(h.chatId, "broken JSON");
  expect((await h.app.request(h.path)).status).toBe(500);
  expect((await h.stores.agentReviewRounds.getChat(h.chatId))!.envelopeJson).toBe("broken JSON");
  expect((await h.put(envelope())).status).toBe(200);
  expect(await (await h.app.request(h.path)).json()).toEqual(envelope());
});
