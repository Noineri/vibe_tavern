import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { createStoreContainer, type StoreContainer, type Chat, type ProviderProfile } from "@vibe-tavern/db";
import { Hono } from "hono";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createAgentChatSettingsRoutes } from "../src/api/routes/agent-chat-settings.js";
import { CopilotProfileResolver } from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
import { streamExperienceCopilot } from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import type {
  ExperienceCopilotStreamDeps,
  ExperienceCopilotStreamEvent,
} from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";
import { registerAgentKind } from "../src/domain/agent/agent-kind-registry.js";
import type { AgentKind } from "../src/domain/agent/agent-kind.js";
// Side-effect imports: register the built-in kinds so the script-owned
// `experience` id resolves (the foreign-kind 400 pin needs it registered).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";

/**
 * SC-0f — per-(chat, agent-kind) profile choice over the REAL adapter, store
 * container (temp data dir) and route module:
 *
 * 1. Routes `GET/PATCH /api/agent/chats/:chatId/:kind/settings`: the no-row
 *    read (`profileId: null`, `updatedAt: null` — a chat row has no legacy
 *    fallback), partial-patch semantics (absent keeps, `null` clears, the
 *    body is `.strict()`), per-(chat, kind) isolation, and the write-time
 *    dangling policy (an unknown profile id is stored verbatim, never
 *    validated — the RESOLVER falls through at read time).
 * 2. Validation: an unregistered kind 400s `UNKNOWN_AGENT_KIND`; a registered
 *    but script-owned kind (`experience`) 400s `AGENT_KIND_NOT_CHAT_OWNED`
 *    and leaves no row; a missing chat 404s.
 * 3. Cascade: deleting the chat deletes its `chat_agent_settings` rows (the
 *    FK's ON DELETE cascade — the drizzle-kit remedy's proof).
 * 4. The chat-owned profile chain (CopilotProfileResolver.resolveForChat):
 *    the chat's own choice → the kind default (SC-0d's `default_profile_id`
 *    made a real consumer) → the kind's built-in; a dangling id at either
 *    stored hop falls through to the next step, never errors.
 * 5. The stream hop (experience-copilot-stream): a CHAT-OWNED thread's turn
 *    resolves its profile through the chat chain — the chat choice's base
 *    prompt is assembled, and clearing the chat choice falls the SAME thread
 *    to the kind default. Script/draft threads never consult the chain
 *    (pinned unchanged by the untouched sibling suites).
 *
 * The fake chat kinds are registered test-locally (beforeAll register /
 * afterAll unsubscribe — the registry has no reset).
 */

const KIND_A = "sc0f-kind-a";
const KIND_B = "sc0f-kind-b";
const KIND_C = "sc0f-kind-c";

/** A chat-owned fake kind — the settings routes and the chain need a
 *  registered chat-owned kind; its stream wiring is irrelevant here (the hop
 *  test drives the stream function directly). */
function makeFakeChatKind(id: string): AgentKind {
  return {
    id,
    owner: "chat",
    servesScriptKinds: [],
    basePromptServiceKey: `${id}_base`,
    skillRootId: id,
    toolSetSchema: z.object({ fake_tool: z.boolean().optional() }).strict(),
    defaultToolSet: { fake_tool: true },
    recencyAnchorText: "(fake kind pins no context)",
    renderContextPackage: () => "",
  };
}

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

interface ChatSettingsWire {
  chatId: string;
  agentKind: string;
  profileId: string | null;
  updatedAt: string | null;
}

let stores: StoreContainer;
let routes: Hono;
let resolver: CopilotProfileResolver;
let characterId: string;
const unregisterFakes: Array<() => void> = [];

/** A fresh chat (own main branch) — the isolation unit for the pair tests. */
async function newChat(title: string): Promise<Chat> {
  return stores.chats.createChat({ characterId, title, promptPresetId: null });
}

function settingsUrl(chatId: string, kind: string): string {
  return `/api/agent/chats/${chatId}/${kind}/settings`;
}

async function getSettings(chatId: string, kind: string): Promise<Response> {
  return routes.request(settingsUrl(chatId, kind));
}

async function patchSettings(
  chatId: string,
  kind: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return routes.request(settingsUrl(chatId, kind), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  unregisterFakes.push(
    registerAgentKind(makeFakeChatKind(KIND_A)),
    registerAgentKind(makeFakeChatKind(KIND_B)),
    registerAgentKind(makeFakeChatKind(KIND_C)),
  );
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-chat-settings-"));
  stores = await createStoreContainer(join(dataRoot, "agent-chat-settings.db"), dataRoot);
  const adapter = new ExperienceCopilotAdapter(stores);
  routes = mountDomainErrorMapping(createAgentChatSettingsRoutes(adapter));
  resolver = new CopilotProfileResolver(stores);
  const character = await stores.characters.create({ name: "Agent chat settings fixture" });
  characterId = character.id;
});

afterAll(() => {
  // No data-dir teardown here: the bunfig preload's global afterAll closes
  // every opened SQLite handle and sweeps the run's temp dirs (the sibling
  // route suites over createStoreContainer do the same).
  for (const unregister of unregisterFakes) unregister();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

describe("per-(chat, kind) settings routes (SC-0f)", () => {
  test("GET a pair with no row reads null/null — no legacy fallback for chat rows", async () => {
    const chat = await newChat("No row");
    const res = await getSettings(chat.id, KIND_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatSettingsWire;
    expect(body.chatId).toBe(chat.id);
    expect(body.agentKind).toBe(KIND_A);
    expect(body.profileId).toBeNull();
    expect(body.updatedAt).toBeNull();
  });

  test("PATCH writes the pair: absent keeps the stored value, null clears it", async () => {
    const chat = await newChat("Patch semantics");
    const first = (await (await patchSettings(chat.id, KIND_A, { profileId: "prof_sc0f_a" })).json()) as ChatSettingsWire;
    expect(first.profileId).toBe("prof_sc0f_a");
    expect(first.updatedAt).not.toBeNull();

    // An empty patch keeps the stored choice and still refreshes updated_at.
    const second = (await (await patchSettings(chat.id, KIND_A, {})).json()) as ChatSettingsWire;
    expect(second.profileId).toBe("prof_sc0f_a");

    // `null` clears exactly the choice (the row stays, timestamped).
    const third = (await (await patchSettings(chat.id, KIND_A, { profileId: null })).json()) as ChatSettingsWire;
    expect(third.profileId).toBeNull();
    expect(third.updatedAt).not.toBeNull();
  });

  test("the PATCH body is strict — an unknown key is a 400", async () => {
    const chat = await newChat("Strict body");
    const res = await patchSettings(chat.id, KIND_A, { profileId: "prof_x", bogus: true });
    expect(res.status).toBe(400);
  });

  test("a write stores an unknown profile id verbatim — dangling is resolved at read, never at write", async () => {
    const chat = await newChat("Dangling write");
    const res = await patchSettings(chat.id, KIND_A, { profileId: "prof_sc0f_never_created" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChatSettingsWire).profileId).toBe("prof_sc0f_never_created");
  });

  test("pairs are isolated — another chat or another kind reads null", async () => {
    const chat1 = await newChat("Isolation one");
    const chat2 = await newChat("Isolation two");
    await patchSettings(chat1.id, KIND_A, { profileId: "prof_sc0f_iso" });

    const otherChat = (await (await getSettings(chat2.id, KIND_A)).json()) as ChatSettingsWire;
    expect(otherChat.profileId).toBeNull();
    const otherKind = (await (await getSettings(chat1.id, KIND_B)).json()) as ChatSettingsWire;
    expect(otherKind.profileId).toBeNull();
  });

  test("an unregistered kind is a 400 UNKNOWN_AGENT_KIND on both routes", async () => {
    const chat = await newChat("Unknown kind");
    const getRes = await getSettings(chat.id, "no-such-kind");
    expect(getRes.status).toBe(400);
    expect(((await getRes.json()) as { code: string }).code).toBe("UNKNOWN_AGENT_KIND");

    const patchRes = await patchSettings(chat.id, "no-such-kind", { profileId: "prof_x" });
    expect(patchRes.status).toBe(400);
    expect(((await patchRes.json()) as { code: string }).code).toBe("UNKNOWN_AGENT_KIND");
  });

  test("a script-owned kind is a 400 AGENT_KIND_NOT_CHAT_OWNED and leaves no row", async () => {
    const chat = await newChat("Foreign kind");
    const getRes = await getSettings(chat.id, "experience");
    expect(getRes.status).toBe(400);
    expect(((await getRes.json()) as { code: string }).code).toBe("AGENT_KIND_NOT_CHAT_OWNED");

    const patchRes = await patchSettings(chat.id, "experience", { profileId: "prof_x" });
    expect(patchRes.status).toBe(400);
    // The rejected write left no row behind.
    const direct = await stores.chatAgentSettings.get(chat.id, "experience");
    expect(direct.profileId).toBeNull();
    expect(direct.updatedAt).toBeNull();
  });

  test("a missing chat is a 404 on both routes", async () => {
    const getRes = await getSettings("chat_does_not_exist", KIND_A);
    expect(getRes.status).toBe(404);

    const patchRes = await patchSettings("chat_does_not_exist", KIND_A, { profileId: "prof_x" });
    expect(patchRes.status).toBe(404);
  });

  test("PATCH stores the \"builtin\" sentinel verbatim — the modal's pin-here write (SC-0k)", async () => {
    const chat = await newChat("Builtin sentinel write");
    const res = await patchSettings(chat.id, KIND_A, { profileId: "builtin" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChatSettingsWire).profileId).toBe("builtin");
  });
});

// ─── Cascade (the FK remedy's proof) ──────────────────────────────────────────

describe("chat_agent_settings cascade on chat delete (SC-0f)", () => {
  test("deleting the chat deletes its rows — the pair reads back as no-row", async () => {
    const chat = await newChat("Cascade probe");
    await patchSettings(chat.id, KIND_A, { profileId: "prof_sc0f_cascade" });
    const before = await stores.chatAgentSettings.get(chat.id, KIND_A);
    expect(before.profileId).toBe("prof_sc0f_cascade");
    expect(before.updatedAt).not.toBeNull();

    await stores.chats.delete(chat.id);

    // A cascaded-away row reads as NO row (profileId null AND updatedAt
    // null — a live row with a cleared choice would keep its timestamp).
    const after = await stores.chatAgentSettings.get(chat.id, KIND_A);
    expect(after.profileId).toBeNull();
    expect(after.updatedAt).toBeNull();
  });
});

// ─── The chat-owned profile chain ─────────────────────────────────────────────

describe("CopilotProfileResolver.resolveForChat — chat choice → kind default → built-in (SC-0f)", () => {
  test("no rows anywhere → the kind's built-in seed", async () => {
    const chat = await newChat("Chain builtin");
    const profile = await resolver.resolveForChat(chat.id, KIND_C);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
    expect(profile.agentKind).toBe(KIND_C);
  });

  test("a kind default (SC-0d default_profile_id) resolves when the chat has no choice", async () => {
    const created = await stores.copilotProfiles.create({
      name: "Kind default B",
      basePrompt: "Kind default B base prompt.",
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_B, { defaultProfileId: created.id });
    const chat = await newChat("Chain kind default");

    const profile = await resolver.resolveForChat(chat.id, KIND_B);
    expect(profile.isBuiltIn).toBe(false);
    expect(profile.id).toBe(created.id);
    expect(profile.basePrompt).toBe("Kind default B base prompt.");
  });

  test("the chat's own choice wins over the kind default", async () => {
    const kindDefault = await stores.copilotProfiles.create({
      name: "Chain kind default",
      basePrompt: "Kind default base prompt.",
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_B, { defaultProfileId: kindDefault.id });
    const chatChoice = await stores.copilotProfiles.create({
      name: "Chain chat choice",
      basePrompt: "Chat choice base prompt.",
      toolSet: {},
    });
    const chat = await newChat("Chain chat choice");
    await stores.chatAgentSettings.patch(chat.id, KIND_B, { profileId: chatChoice.id });

    const profile = await resolver.resolveForChat(chat.id, KIND_B);
    expect(profile.id).toBe(chatChoice.id);
    expect(profile.basePrompt).toBe("Chat choice base prompt.");
  });

  test("a dangling chat choice falls through to the kind default", async () => {
    const kindDefault = await stores.copilotProfiles.create({
      name: "Dangling chat target default",
      basePrompt: "Kind default after dangling chat choice.",
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_B, { defaultProfileId: kindDefault.id });
    const doomed = await stores.copilotProfiles.create({
      name: "Doomed chat choice",
      basePrompt: "Will be deleted.",
      toolSet: {},
    });
    const chat = await newChat("Dangling chat choice");
    await stores.chatAgentSettings.patch(chat.id, KIND_B, { profileId: doomed.id });
    await stores.copilotProfiles.delete(doomed.id);

    const profile = await resolver.resolveForChat(chat.id, KIND_B);
    expect(profile.id).toBe(kindDefault.id);
  });

  test("a dangling kind default (and no chat choice) falls through to the built-in", async () => {
    const doomedDefault = await stores.copilotProfiles.create({
      name: "Doomed kind default",
      basePrompt: "Will be deleted.",
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_C, { defaultProfileId: doomedDefault.id });
    await stores.copilotProfiles.delete(doomedDefault.id);
    const chat = await newChat("Dangling kind default");

    const profile = await resolver.resolveForChat(chat.id, KIND_C);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
  });

  test("another chat's choice never leaks — its own no-row chat reads the kind default", async () => {
    const kindDefault = await stores.copilotProfiles.create({
      name: "Leak probe default",
      basePrompt: "Kind default for the leak probe.",
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_B, { defaultProfileId: kindDefault.id });
    const ownChoice = await stores.copilotProfiles.create({
      name: "Leak probe own choice",
      basePrompt: "Own choice for the leak probe.",
      toolSet: {},
    });
    const chatWithChoice = await newChat("Leak probe with choice");
    await stores.chatAgentSettings.patch(chatWithChoice.id, KIND_B, { profileId: ownChoice.id });
    const chatWithout = await newChat("Leak probe without choice");

    expect((await resolver.resolveForChat(chatWithChoice.id, KIND_B)).id).toBe(ownChoice.id);
    expect((await resolver.resolveForChat(chatWithout.id, KIND_B)).id).toBe(kindDefault.id);
  });
});

// ─── The "builtin" sentinel (SC-0k) ────────────────────────────────────────────

describe("CopilotProfileResolver.resolveForChat — the \"builtin\" sentinel (SC-0k)", () => {
  test("a chat choice of \"builtin\" resolves to the kind's built-in seed, never the kind default", async () => {
    const kindDefault = await stores.copilotProfiles.create({
      name: "SC0k kind default",
      basePrompt: "SC0k kind default base prompt.",
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_C, { defaultProfileId: kindDefault.id });
    const chat = await newChat("SC0k builtin pin");
    await stores.chatAgentSettings.patch(chat.id, KIND_C, { profileId: "builtin" });

    const profile = await resolver.resolveForChat(chat.id, KIND_C);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
    expect(profile.agentKind).toBe(KIND_C);
  });

  test("a kind default of \"builtin\" reads as null — the built-in seed", async () => {
    await stores.agentKindSettings.patch(KIND_C, { defaultProfileId: "builtin" });
    const chat = await newChat("SC0k builtin default");

    const profile = await resolver.resolveForChat(chat.id, KIND_C);
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.id).toBe("builtin");
  });
});

// ─── The stream hop (integration edge) ────────────────────────────────────────

describe("the stream resolves a chat-owned thread's profile through the chat chain (SC-0f)", () => {
  /** Minimal provider profile stub for the turn's provider/model resolution
   *  (taken from the REQUEST — the SC-0d pin; profile resolution is separate).
   *  Field-complete like the sibling suites' makeProfile(): the generic turn
   *  loop reads the proxy policy (`proxyMode`/`proxyId`) through
   *  resolveProviderFetchForProfile. */
  function providerProfileStub() {
    return {
      id: "prov_sc0f_hop",
      name: "Hop probe",
      providerPreset: "openai",
      coauthorTransport: "chatCompletions",
      endpoint: "http://test",
      apiKey: "key",
      defaultModel: "hop-model",
      contextBudget: null,
      pinContextBudget: false,
      bindPerModel: false,
      modelFreeOnly: false,
      modelGroupByOwner: false,
      maxTokens: 2000,
      temperature: 0.3,
      topP: 1,
      topK: 0,
      minP: 0,
      topA: 0,
      typicalP: 1,
      tfsZ: 1,
      repeatLastN: 0,
      mirostat: 0,
      mirostatTau: 5,
      mirostatEta: 0.1,
      dryMultiplier: 0,
      dryBase: 1.75,
      dryAllowedLength: 2,
      drySequenceBreakers: null,
      xtcThreshold: 0.1,
      xtcProbability: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      repetitionPenalty: 1,
      stopSequences: [],
      logitBias: null,
      seed: null,
      reasoningEffort: "auto",
      showReasoning: false,
      streamResponse: true,
      customSamplers: false,
      proxyMode: "inherit",
      proxyId: null,
      isActive: true,
      visionModel: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ProviderProfile;
  }

  /** One turn over the REAL thread row + REAL resolver chain, with a fake
   *  streamText capturing the opts it was called with. Returns the captured
   *  opts serialized (the assembled prompt lives in `messages`). */
  async function runChatThreadTurn(threadId: string): Promise<string> {
    let captured: unknown = null;
    const profile = providerProfileStub();
    const deps: ExperienceCopilotStreamDeps = {
      store: stores.experienceCopilot,
      agentPlans: {
        get: async () => null,
        save: async () => {},
      } as ExperienceCopilotStreamDeps["agentPlans"],
      getScript: async () => null,
      getBoundVisualIds: async () => [],
      getVisual: async () => null,
      getProviderProfile: async () => profile,
      getEffectiveProviderProfile: async () => profile,
      resolveModel: () => ({}) as LanguageModel,
      // BOTH seams over the REAL resolver: a chat-owned thread must route
      // through the chat chain, never the script path.
      resolveProfile: (scriptId) => resolver.resolveForScript(scriptId),
      resolveProfileForChat: (thread) =>
        resolver.resolveForChat(thread.chatId, thread.agentKind),
      streamText: ((opts: unknown) => {
        // Capture the OPTS the loop passed (the assembled messages live
        // here); feed one text delta back through a minimal result shape.
        captured = opts;
        async function* gen(): AsyncGenerator<unknown, void, unknown> {
          yield { type: "text-delta", text: "ok" };
        }
        return {
          stream: gen(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve(undefined),
        };
      }) as unknown as ExperienceCopilotStreamDeps["streamText"],
    };
    const events: ExperienceCopilotStreamEvent[] = [];
    for await (const chunk of streamExperienceCopilot(
      { threadId, content: "plot question", providerProfileId: "prov_sc0f_hop" },
      deps,
    )) {
      events.push(chunk);
    }
    // The turn completed (the fake stream fed one text delta).
    expect(events.some((e) => e.event === "finish")).toBe(true);
    return JSON.stringify(captured);
  }

  test("the chat choice's base prompt is assembled; clearing it falls the same thread to the kind default", async () => {
    const CHAT_MARKER = "SC0F-HOP-CHAT-CHOICE-BASE-PROMPT";
    const KIND_MARKER = "SC0F-HOP-KIND-DEFAULT-BASE-PROMPT";
    const chat = await newChat("Stream hop probe");
    const kindDefault = await stores.copilotProfiles.create({
      name: "Hop kind default",
      basePrompt: `${KIND_MARKER} — the kind default.`,
      toolSet: {},
    });
    const chatChoice = await stores.copilotProfiles.create({
      name: "Hop chat choice",
      basePrompt: `${CHAT_MARKER} — the chat's own choice.`,
      toolSet: {},
    });
    await stores.agentKindSettings.patch(KIND_A, { defaultProfileId: kindDefault.id });
    await stores.chatAgentSettings.patch(chat.id, KIND_A, { profileId: chatChoice.id });
    const thread = await stores.experienceCopilot.startNewChatSession(
      chat.id,
      chat.activeBranchId as string,
      KIND_A,
      "Stream hop probe",
    );

    // The chat-owned thread assembles the CHAT choice's prompt — the chain's
    // first hop won over the kind default.
    const firstTurn = await runChatThreadTurn(thread.id);
    expect(firstTurn).toContain(CHAT_MARKER);
    expect(firstTurn).not.toContain(KIND_MARKER);

    // Clearing the chat choice falls the SAME thread to the kind default
    // (the chain's second hop) — re-read live every turn, never persisted
    // into the thread.
    await stores.chatAgentSettings.patch(chat.id, KIND_A, { profileId: null });
    const secondTurn = await runChatThreadTurn(thread.id);
    expect(secondTurn).toContain(KIND_MARKER);
    expect(secondTurn).not.toContain(CHAT_MARKER);
  });
});
