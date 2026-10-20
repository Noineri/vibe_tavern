import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer, type Chat } from "@vibe-tavern/db";
import { Hono } from "hono";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createAgentChatDefaultModelRoutes } from "../src/api/routes/agent-chat-default-model.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";

/**
 * SC-7 — `GET /api/agent/chats/:chatId/default-model` over the REAL adapter,
 * store container (temp data dir) and route module:
 *
 * 1. Returns the RP chat's active provider profile + its selected model —
 *    the pair the RP send itself resolves (the same `providers.getActive()`
 *    store read `resolveActiveProviderProfile` wraps; the send's model is
 *    the profile's `defaultModel`).
 * 2. Nulls, never an error, when no profile is active or the active profile
 *    has no default model (a picker default, not a send).
 * 3. A missing chat is a 404 (the adapter's `NotFound` DomainError, mapped
 *    by the shared app-level handler helpers mounted per-file).
 * 4. Read-only: repeated GETs return the identical pair and leave the
 *    active-profile pointer where it was.
 */

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 404s are observable at the route — the
 *  same per-file wiring as agent-chat-sessions.test.ts. */
function mountDomainErrorMapping(app: Hono): Hono {
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  return app;
}

interface DefaultModelWire {
  providerProfileId: string | null;
  modelName: string | null;
}

let stores: StoreContainer;
let routes: Hono;
let characterId: string;

/** A fresh chat (own main branch) — the route's only path segment. */
async function newChat(title: string): Promise<Chat> {
  return stores.chats.createChat({ characterId, title, promptPresetId: null });
}

async function getDefaultModel(chatId: string): Promise<Response> {
  return routes.request(`/api/agent/chats/${chatId}/default-model`);
}

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-chat-default-model-"));
  stores = await createStoreContainer(join(dataRoot, "agent-chat-default-model.db"), dataRoot);
  const adapter = new ExperienceCopilotAdapter(stores);
  routes = mountDomainErrorMapping(createAgentChatDefaultModelRoutes(adapter));
  const character = await stores.characters.create({ name: "Default-model route fixture" });
  characterId = character.id;
});

afterAll(() => {
  // No data-dir teardown here: the bunfig preload's global afterAll closes
  // every opened SQLite handle and sweeps the run's temp dirs (the sibling
  // route suites over createStoreContainer do the same).
});

describe("the chat's RP default-model route (SC-7)", () => {
  test("no active provider profile → nulls, never an error", async () => {
    const chat = await newChat("No active profile");
    const res = await getDefaultModel(chat.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DefaultModelWire;
    expect(body.providerProfileId).toBeNull();
    expect(body.modelName).toBeNull();
  });

  test("returns the active profile's pair — the RP send's own resolution", async () => {
    const chat = await newChat("Active profile");
    const profile = await stores.providers.create({
      name: "Default-model fixture profile",
      providerPreset: "openai-compatible",
      endpoint: "https://example.invalid/v1",
      defaultModel: "model_rp_selected",
    });
    await stores.providers.activate(profile.id);
    const res = await getDefaultModel(chat.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DefaultModelWire;
    expect(body.providerProfileId).toBe(profile.id);
    expect(body.modelName).toBe("model_rp_selected");
  });

  test("an active profile with no default model → modelName null", async () => {
    const chat = await newChat("No default model");
    const profile = await stores.providers.create({
      name: "Default-model-less fixture profile",
      providerPreset: "openai-compatible",
      endpoint: "https://example.invalid/v1",
    });
    await stores.providers.activate(profile.id);
    const res = await getDefaultModel(chat.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DefaultModelWire;
    expect(body.providerProfileId).toBe(profile.id);
    expect(body.modelName).toBeNull();
  });

  test("a missing chat is a 404", async () => {
    const res = await getDefaultModel("chat_does_not_exist");
    expect(res.status).toBe(404);
  });

  test("read-only: repeated GETs are identical and the active pointer never moves", async () => {
    const chat = await newChat("Read-only probe");
    const firstBody = (await (await getDefaultModel(chat.id)).json()) as DefaultModelWire;
    const secondBody = (await (await getDefaultModel(chat.id)).json()) as DefaultModelWire;
    expect(firstBody).toEqual(secondBody);
    const active = await stores.providers.getActive();
    expect(active?.defaultModel ?? null).toBe(secondBody.modelName);
  });
});
