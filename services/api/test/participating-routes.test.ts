// «Текущие» participating-query routes (LOREBOOK_LIST_FILTERS_REPORT step 2):
// GET /api/lorebooks/participating?chatId=… and GET /api/scripts/participating?chatId=…
// Mirrors the coauthor-settings-routes pattern: mock-runtime tests pin
// routing + zod wiring via app.request(); adapter tests pin the fail-closed
// NotFound for an unknown chat and the chat-row → store delegation
// (characterId/personaId come from the chat, never the query).
import { describe, expect, test } from "bun:test";
import { createLorebookRoutes } from "../src/api/routes/lorebook.js";
import { createScriptRoutes } from "../src/api/routes/script.js";
import type { LorebookRuntimeApi, ScriptRuntimeApi } from "../src/api/contract/runtime-api.js";
import { LorebookAdapter } from "../src/api/adapters/lorebook-adapter.js";
import { ScriptAdapter } from "../src/api/adapters/script-adapter.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";

function mockLorebookRuntime(overrides: Partial<LorebookRuntimeApi> = {}): LorebookRuntimeApi {
  return { ...overrides } as unknown as LorebookRuntimeApi;
}

function mockScriptRuntime(overrides: Partial<ScriptRuntimeApi> = {}): ScriptRuntimeApi {
  return { ...overrides } as unknown as ScriptRuntimeApi;
}

/** StoreContainer stub carrying only the members the participating adapters
 * touch — the adapter seam (constructor DI) keeps this test-local and visible. */
function stubStores(chats: { getById: (id: string) => Promise<unknown> }, lorebooks?: unknown, scripts?: unknown) {
  return {
    chats,
    lorebooks,
    scripts,
  } as unknown as StoreContainer;
}

const BOOK = { id: "lb_1", name: "book", enabled: true };
const SCRIPT = { id: "s_1", name: "script", enabled: true, scriptKind: "prompt" };

describe("GET /api/lorebooks/participating (mock runtime)", () => {
  test("200 + the runtime's list, chatId carried from the query", async () => {
    let captured: string | null = null;
    const app = createLorebookRoutes(mockLorebookRuntime({
      listParticipatingLorebooks: async (chatId) => {
        captured = chatId;
        return [BOOK];
      },
    }));
    const res = await app.request("/api/lorebooks/participating?chatId=chat_X");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([BOOK]);
    expect(captured).toBe("chat_X");
  });

  test("missing or empty chatId → 400 (fail-closed query validation)", async () => {
    const app = createLorebookRoutes(mockLorebookRuntime());
    expect((await app.request("/api/lorebooks/participating")).status).toBe(400);
    expect((await app.request("/api/lorebooks/participating?chatId=")).status).toBe(400);
  });
});

describe("GET /api/scripts/participating (mock runtime)", () => {
  test("200 + the runtime's list; the literal route wins over :scriptId", async () => {
    let captured: string | null = null;
    const app = createScriptRoutes(mockScriptRuntime({
      listParticipatingScripts: async (chatId) => {
        captured = chatId;
        return [SCRIPT];
      },
    }));
    const res = await app.request("/api/scripts/participating?chatId=chat_X");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([SCRIPT]);
    expect(captured).toBe("chat_X");
  });

  test("missing or empty chatId → 400 (fail-closed query validation)", async () => {
    const app = createScriptRoutes(mockScriptRuntime());
    expect((await app.request("/api/scripts/participating")).status).toBe(400);
    expect((await app.request("/api/scripts/participating?chatId=")).status).toBe(400);
  });
});

describe("participating adapters (fail-closed delegation)", () => {
  test("lorebook adapter: unknown chat → DomainError NotFound (404)", async () => {
    const adapter = new LorebookAdapter(stubStores({ getById: async () => null }));
    const err = await adapter.listParticipatingLorebooks("chat_missing").catch((e: unknown) => e);
    if (!isDomainError(err)) throw new Error("expected a DomainError");
    expect(httpStatusForDomainError(err)).toBe(404);
  });

  test("script adapter: unknown chat → DomainError NotFound (404)", async () => {
    const adapter = new ScriptAdapter(stubStores({ getById: async () => null }));
    const err = await adapter.listParticipatingScripts("chat_missing").catch((e: unknown) => e);
    if (!isDomainError(err)) throw new Error("expected a DomainError");
    expect(httpStatusForDomainError(err)).toBe(404);
  });

  test("lorebook adapter passes the CHAT's character/persona pairing to the store, not the raw query", async () => {
    let captured: { characterId: string; personaId: string | null; chatId: string } | null = null;
    const lorebooks = {
      listParticipatingForChat: async (characterId: string, personaId: string | null, chatId: string) => {
        captured = { characterId, personaId, chatId };
        return [BOOK];
      },
    };
    const chatRow = { id: "chat_X", characterId: "char_1", personaId: "persona_9" };
    const adapter = new LorebookAdapter(stubStores({ getById: async () => chatRow }, lorebooks));
    const result = await adapter.listParticipatingLorebooks("chat_X");
    expect(result).toEqual([BOOK]);
    expect(captured).toEqual({ characterId: "char_1", personaId: "persona_9", chatId: "chat_X" });
  });

  test("script adapter passes the CHAT's character/persona pairing to the store", async () => {
    let captured: { characterId: string; personaId: string | null; chatId: string } | null = null;
    const scripts = {
      listParticipatingForChat: async (characterId: string, personaId: string | null, chatId: string) => {
        captured = { characterId, personaId, chatId };
        return [SCRIPT];
      },
    };
    const chatRow = { id: "chat_X", characterId: "char_1", personaId: null };
    const adapter = new ScriptAdapter(stubStores({ getById: async () => chatRow }, undefined, scripts));
    const result = await adapter.listParticipatingScripts("chat_X");
    expect(result).toEqual([SCRIPT]);
    expect(captured).toEqual({ characterId: "char_1", personaId: null, chatId: "chat_X" });
  });
});
