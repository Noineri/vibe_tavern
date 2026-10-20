import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStoreContainer, type StoreContainer, type Chat } from "@vibe-tavern/db";
import { CHAT_MODE, type ChatMode } from "@vibe-tavern/domain";
import { Hono } from "hono";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createAgentChatSessionsRoutes } from "../src/api/routes/agent-chat-sessions.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";
import { registerAgentKind, AgentKindNotWiredError } from "../src/domain/agent/agent-kind-registry.js";
import type { AgentKind } from "../src/domain/agent/agent-kind.js";
// Side-effect imports: register the built-in kinds so the script-owned
// `experience`/`script` ids resolve (the foreign-kind 400 pin needs them).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";

/**
 * SC-0b — chat-owner agent-session lifecycle. The REAL adapter over a REAL
 * store container (temp data dir) behind the REAL route modules:
 *
 * 1. CRUD on `/api/agent/chats/:chatId/branches/:branchId/:kind/{active,
 *    sessions, session}` — create/list/active, one-active-per-triple, the
 *    optional title body, null before the first session.
 * 2. Kind validation through the registry: an unregistered kind 400s
 *    `UNKNOWN_AGENT_KIND`; a registered but script-owned kind 400s
 *    `AGENT_KIND_NOT_CHAT_OWNED` and leaves no row behind.
 * 3. Owner validation: a missing chat, a missing branch, and a branch of a
 *    DIFFERENT chat under this chat's path are 404s.
 * 4. The unchanged per-thread routes serve a chat-owned thread (activate /
 *    archive / title).
 * 5. A chat thread's STREAM dispatches to its stored `agent_kind` — the
 *    owner is read from the thread row, never from the body. A fake chat
 *    kind is registered test-locally (beforeAll register / afterAll
 *    unsubscribe — the registry has no reset); an UNWIRED kind proves the
 *    dispatch target by throwing inside it, and a thread whose stored kind
 *    is no longer registered proves the typed registry error.
 * 6. SC-7b chat-mode guard: the fake kind serves `rp` only — create on an
 *    rp chat works as before, create on a `coauthor` chat is the typed 400
 *    `AGENT_KIND_MODE_NOT_SERVED` naming the kind and the mode (no row
 *    born), and the READ routes on a coauthor chat answer empty (list →
 *    `[]`, active → `null`), never an error.
 *
 * Tests that COUNT sessions get a FRESH chat each (the store container is
 * shared per file) so counts pin this test's threads alone.
 */

const FAKE_CHAT_KIND_ID = "acs-fake-chat-kind";

/** A chat-owned fake kind (SC-0b's `owner: "chat"`) — no stream wiring in the
 *  adapter, which is exactly what the dispatch pins need: resolving to it is
 *  observable through `AgentKindNotWiredError`. */
function makeFakeChatKind(): AgentKind {
  return {
    id: FAKE_CHAT_KIND_ID,
    owner: "chat",
    servesScriptKinds: [],
    // SC-7b: the fake serves rp only — the real chat-owned kind's
    // declaration, so the mode-guard tests exercise the same value.
    servesChatModes: [CHAT_MODE.rp],
    basePromptServiceKey: `${FAKE_CHAT_KIND_ID}_base`,
    skillRootId: FAKE_CHAT_KIND_ID,
    toolSetSchema: z.object({ fake_tool: z.boolean().optional() }).strict(),
    defaultToolSet: { fake_tool: true },
    recencyAnchorText: "(fake kind pins no context)",
    // Post-split fake: no legacy copilot-pair inheritance (SC-7).
    inheritsLegacyCopilotPair: false,
    renderContextPackage: () => "",
  };
}

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 404s are observable at the route — the
 *  same pattern as copilot-profile-kind.test.ts. */
function mountDomainErrorMapping(app: Hono): Hono {
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  return app;
}

let dataRoot: string;
let stores: StoreContainer;
let chatRoutes: Hono;
let threadRoutes: Hono;
let characterId: string;
let unregisterFakeKind: () => void;

/** A fresh chat (own main branch) — the isolation unit for session counts.
 *  `mode` defaults to the store's `rp` (every pre-SC-7b test's chat). */
async function newChat(title: string, mode?: ChatMode): Promise<Chat> {
  return stores.chats.createChat({ characterId, title, promptPresetId: null, ...(mode !== undefined ? { mode } : {}) });
}

function chatUrl(chat: Chat, kind: string, branchId = chat.activeBranchId as string): string {
  return `/api/agent/chats/${chat.id}/branches/${branchId}/${kind}`;
}

/** POST a session start. A body-less POST sends NO content-type — Hono's
 *  json validator treats a typed-but-empty body as malformed, while an
 *  untyped request validates as `{}` (title stays undefined), the same
 *  contract the script-owner twin has. */
async function postSession(chat: Chat, kind: string, body?: Record<string, unknown>): Promise<Response> {
  return chatRoutes.request(`${chatUrl(chat, kind)}/session`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

interface WireThread {
  id: string;
  title: string;
  archivedAt: string | null;
}

beforeAll(async () => {
  unregisterFakeKind = registerAgentKind(makeFakeChatKind());
  dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-chat-sessions-"));
  stores = await createStoreContainer(join(dataRoot, "agent-chat.db"), dataRoot);
  const adapter = new ExperienceCopilotAdapter(stores);
  chatRoutes = mountDomainErrorMapping(createAgentChatSessionsRoutes(adapter));
  threadRoutes = mountDomainErrorMapping(createExperienceCopilotRoutes(adapter));
  const character = await stores.characters.create({ name: "Agent chat sessions fixture" });
  characterId = character.id;
});

afterAll(() => {
  // No data-dir teardown here: the bunfig preload's global afterAll closes
  // every opened SQLite handle and sweeps the run's temp dirs (the sibling
  // route suites over createStoreContainer do the same — an rm from inside
  // the file races the still-open WAL handle and EBUSY-fails the run).
  unregisterFakeKind();
});

describe("chat-owner lifecycle routes (SC-0b)", () => {
  test("GET active with no session yet returns null", async () => {
    const chat = await newChat("Empty triple");
    const res = await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/active`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("POST session creates the first active session; GET active and GET sessions return it", async () => {
    const chat = await newChat("First session");
    const res = await postSession(chat, FAKE_CHAT_KIND_ID, { title: "Plot talk" });
    expect(res.status).toBe(200);
    const thread = (await res.json()) as WireThread;
    expect(thread.title).toBe("Plot talk");
    expect(thread.archivedAt).toBeNull();

    const activeRes = await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/active`);
    expect(activeRes.status).toBe(200);
    expect(((await activeRes.json()) as WireThread).id).toBe(thread.id);

    const sessionsRes = await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/sessions`);
    expect(sessionsRes.status).toBe(200);
    const sessions = (await sessionsRes.json()) as WireThread[];
    expect(sessions.map((s) => s.id)).toEqual([thread.id]);
  });

  test("POST a second session archives the first — one active per (chat, branch, kind)", async () => {
    const chat = await newChat("Second session");
    const first = (await (await postSession(chat, FAKE_CHAT_KIND_ID, { title: "First" })).json()) as WireThread;
    const second = (await (await postSession(chat, FAKE_CHAT_KIND_ID, { title: "Second" })).json()) as WireThread;

    const active = (await (await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/active`)).json()) as WireThread;
    expect(active.id).toBe(second.id);

    const sessions = (await (await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/sessions`)).json()) as WireThread[];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.archivedAt === null)).toHaveLength(1);
    expect(sessions.find((s) => s.id === first.id)?.archivedAt).not.toBeNull();
  });

  test("a body-less POST starts an untitled session", async () => {
    const chat = await newChat("Untitled session");
    const res = await postSession(chat, FAKE_CHAT_KIND_ID);
    expect(res.status).toBe(200);
    expect(((await res.json()) as WireThread).title).toBe("");
  });

  test("an unregistered kind is a 400 UNKNOWN_AGENT_KIND on every lifecycle route", async () => {
    const chat = await newChat("Unknown kind");
    const requests: Array<() => Promise<Response>> = [
      () => chatRoutes.request(`${chatUrl(chat, "no-such-kind")}/active`),
      () => chatRoutes.request(`${chatUrl(chat, "no-such-kind")}/sessions`),
      () => postSession(chat, "no-such-kind"),
    ];
    for (const request of requests) {
      const res = await request();
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("UNKNOWN_AGENT_KIND");
      expect(body.error).toContain("no-such-kind");
    }
  });

  test("a registered but script-owned kind is a 400 AGENT_KIND_NOT_CHAT_OWNED that leaves no row", async () => {
    const chat = await newChat("Foreign kind");
    for (const kind of ["script", "experience"]) {
      const res = await postSession(chat, kind);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("AGENT_KIND_NOT_CHAT_OWNED");
      expect(body.error).toContain(kind);
      // The rejection left nothing behind (the store, not the route, proves it).
      expect(
        await stores.experienceCopilot.getActiveForChat(chat.id, chat.activeBranchId as string, kind),
      ).toBeNull();
    }
  });

  test("a missing chat, a missing branch, and a foreign chat's branch are 404s", async () => {
    const chat = await newChat("Owner lookups");
    const other = await newChat("Foreign branch owner");
    const branchId = chat.activeBranchId as string;

    const missingChat = await chatRoutes.request(`/api/agent/chats/chat_missing/branches/${branchId}/${FAKE_CHAT_KIND_ID}/active`);
    expect(missingChat.status).toBe(404);

    const missingBranch = await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID, "brnch_missing")}/active`);
    expect(missingBranch.status).toBe(404);

    // The branch EXISTS — but under the other chat: not this chat's branch.
    const foreignBranch = await chatRoutes.request(
      `${chatUrl(chat, FAKE_CHAT_KIND_ID, other.activeBranchId as string)}/active`,
    );
    expect(foreignBranch.status).toBe(404);

    // The create route refuses the same pair — no orphan thread row is born.
    const foreignCreate = await chatRoutes.request(
      `/api/agent/chats/${chat.id}/branches/${other.activeBranchId}/${FAKE_CHAT_KIND_ID}/session`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
    );
    expect(foreignCreate.status).toBe(404);
  });
});

describe("the chat-mode guard (SC-7b)", () => {
  test("create on an rp chat works — the kind serves rp, byte-identical to the pre-guard flow", async () => {
    const chat = await newChat("RP mode served", CHAT_MODE.rp);
    const res = await postSession(chat, FAKE_CHAT_KIND_ID, { title: "RP talk" });
    expect(res.status).toBe(200);
    const thread = (await res.json()) as WireThread;
    expect(thread.title).toBe("RP talk");
    // The created session IS listable — the read path ran the store read.
    const sessions = (await (await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/sessions`)).json()) as WireThread[];
    expect(sessions.map((s) => s.id)).toEqual([thread.id]);
  });

  test("create on a coauthor chat is a 400 AGENT_KIND_MODE_NOT_SERVED naming the kind and the mode, leaving no row", async () => {
    const chat = await newChat("Coauthor mode refused", CHAT_MODE.coauthor);
    const res = await postSession(chat, FAKE_CHAT_KIND_ID);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("AGENT_KIND_MODE_NOT_SERVED");
    // The error names BOTH halves of the refused pair.
    expect(body.error).toContain(FAKE_CHAT_KIND_ID);
    expect(body.error).toContain("coauthor");
    // The refusal left nothing behind (the store, not the route, proves it).
    expect(
      await stores.experienceCopilot.getActiveForChat(chat.id, chat.activeBranchId as string, FAKE_CHAT_KIND_ID),
    ).toBeNull();
  });

  test("list on a coauthor chat returns an empty list, not an error", async () => {
    const chat = await newChat("Coauthor list empty", CHAT_MODE.coauthor);
    const res = await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("active on a coauthor chat reads null — the read twin of the empty list", async () => {
    const chat = await newChat("Coauthor active null", CHAT_MODE.coauthor);
    const res = await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/active`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe("the unchanged per-thread routes serve a chat-owned thread (SC-0b)", () => {
  test("activate, rename and archive work through /api/experience-copilot/:threadId/...", async () => {
    const chat = await newChat("Per-thread routes");
    const first = (await (await postSession(chat, FAKE_CHAT_KIND_ID, { title: "To reactivate" })).json()) as WireThread;
    const second = (await (await postSession(chat, FAKE_CHAT_KIND_ID, { title: "Current" })).json()) as WireThread;

    // Reactivating the archived sibling archives the current one — chat
    // siblings only (SC-0a's activate serves both owners).
    const activateRes = await threadRoutes.request(`/api/experience-copilot/${first.id}/activate`, { method: "POST" });
    expect(activateRes.status).toBe(200);
    const active = (await (await chatRoutes.request(`${chatUrl(chat, FAKE_CHAT_KIND_ID)}/active`)).json()) as WireThread;
    expect(active.id).toBe(first.id);

    const renameRes = await threadRoutes.request(`/api/experience-copilot/${first.id}/title`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed chat session" }),
    });
    expect(renameRes.status).toBe(200);
    expect(((await renameRes.json()) as WireThread).title).toBe("Renamed chat session");

    const archiveRes = await threadRoutes.request(`/api/experience-copilot/${second.id}/archive`, { method: "POST" });
    expect(archiveRes.status).toBe(200);
    expect(((await archiveRes.json()) as WireThread).archivedAt).not.toBeNull();
  });
});

describe("a chat thread's stream dispatches to its agent_kind (SC-0b)", () => {
  test("the assert step resolves the STORED kind through the registry — an unwired chat kind throws in ITS table entry", async () => {
    const chat = await newChat("Dispatch pin");
    const thread = (await (await postSession(chat, FAKE_CHAT_KIND_ID, { title: "Dispatch pin" })).json()) as WireThread;
    const adapter = new ExperienceCopilotAdapter(stores);
    let caught: unknown;
    try {
      await adapter.experienceCopilotAssertStreamKind(thread.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentKindNotWiredError);
    const error = caught as AgentKindNotWiredError;
    // The dispatch target is the thread's OWN agent_kind, not the script path.
    expect(error.kindId).toBe(FAKE_CHAT_KIND_ID);
    expect(error.table).toBe("stream");
    expect(error.code).toBe("AGENT_KIND_NOT_WIRED");
  });

  test("the stream route maps the unwired chat kind to a 400 before any SSE headers", async () => {
    const chat = await newChat("Stream 400");
    const thread = (await (await postSession(chat, FAKE_CHAT_KIND_ID)).json()) as WireThread;
    const res = await threadRoutes.request(`/api/experience-copilot/${thread.id}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", providerProfileId: "prov_1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("AGENT_KIND_NOT_WIRED");
    expect(body.error).toContain(FAKE_CHAT_KIND_ID);
  });

  test("a thread whose stored kind is no longer registered 400s UNKNOWN_AGENT_KIND (the typed registry error)", async () => {
    const chat = await newChat("Orphan kind");
    // Born straight through the store with a kind no module registers — the
    // row a removed/disabled kind module leaves behind.
    const thread = await stores.experienceCopilot.startNewChatSession(
      chat.id,
      chat.activeBranchId as string,
      "acs-unregistered-kind",
      "Orphan kind",
    );
    const res = await threadRoutes.request(`/api/experience-copilot/${thread.id}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", providerProfileId: "prov_1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("UNKNOWN_AGENT_KIND");
    expect(body.error).toContain("acs-unregistered-kind");
  });
});
