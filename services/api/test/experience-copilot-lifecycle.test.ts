import { describe, expect, it } from "bun:test";
import { brandId, type ExperienceCopilotThreadId } from "@vibe-tavern/domain";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ExperienceCopilotMessage,
  StoreContainer,
  AppDb,
  ChatAgentSettingsStore,
  ChatStore,
} from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { makeExperienceCopilotStore } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

// ─── Domain fixtures ─────────────────────────────────────────────────────────

function makeThread(overrides: Partial<ExperienceCopilotThread> = {}): ExperienceCopilotThread {
  return {
    id: "thread_1",
    scriptId: "script_1",
    draftSessionId: null,
    title: "Draft",
    archivedAt: null,
    contextMetrics: null,
    contextLinks: [],
    lastProviderProfileId: null,
    lastModel: null,
    autoCompact: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    todo: [],
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ExperienceCopilotMessage> = {}): ExperienceCopilotMessage {
  return {
    id: "msg_1",
    threadId: "thread_1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Fake store + adapter wiring ─────────────────────────────────────────────

type StoreOverrides = {
  getActive?: ExperienceCopilotStore["getActive"];
  listMessages?: ExperienceCopilotStore["listMessages"];
  startNewSession?: ExperienceCopilotStore["startNewSession"];
  renameSession?: ExperienceCopilotStore["renameSession"];
};

function makeStore(overrides: StoreOverrides = {}) {
  const calls: {
    startNewSession: Array<{ scriptId: string; title?: string; autoCompact?: boolean }>;
    renameSession: Array<{ sessionId: string; title: string }>;
  } = {
    startNewSession: [],
    renameSession: [],
  };
  const store = makeExperienceCopilotStore(
    {
      getActive: overrides.getActive ?? (async () => null),
      listMessages: overrides.listMessages ?? (async () => []),
      startNewSession:
        overrides.startNewSession ??
        (async (scriptId: string, title?: string, autoCompact?: boolean) => {
          calls.startNewSession.push({ scriptId, title, autoCompact });
          return makeThread({ scriptId, title: title ?? "" });
        }),
      renameSession:
        overrides.renameSession ??
        (async (sessionId: string, title: string) => {
          calls.renameSession.push({ sessionId, title });
          return makeThread({ id: brandId<ExperienceCopilotThreadId>(sessionId), title });
        }),
    },
    "ExperienceCopilotStore (lifecycle)",
  );
  return { store, calls };
}

function makeAdapter(store: ExperienceCopilotStore): ExperienceCopilotAdapter {
  // AP-20: the create path resolves the script's agent kind (scripts store)
  // and reads the kind's auto-compact default (agentKindSettings store)
  // before delegating — a missing script row resolves to the draft kind, and
  // the default-absent kind settings read ON, so the delegation below carries
  // `autoCompact: true` without this file growing a registry dependency.
  const scripts = {
    async getById(_scriptId: string) {
      return null;
    },
  };
  const agentKindSettings = {
    async get(kind: string) {
      return {
        agentKind: kind,
        providerProfileId: null,
        modelName: null,
        defaultProfileId: null,
        autoCompactDefault: true,
        updatedAt: null,
      };
    },
  };
  // The strict double keeps the provided store members compiler-checked; an
  // unprovided member throws a labeled miss. `chatAgentSettings`/`chats` are
  // the ctor's eager construction-reference reads (6a makeCopilotStores
  // precedent) — inert doubles; the exercised paths never call them.
  return new ExperienceCopilotAdapter(strictTestDouble<StoreContainer>(
    {
      experienceCopilot: store,
      scripts,
      agentKindSettings,
      chatAgentSettings: strictTestDouble<ChatAgentSettingsStore>({}, "chatAgentSettings (construction ref)"),
      db: strictTestDouble<AppDb>({}, "db (construction ref)"),
      chats: strictTestDouble<ChatStore>({}, "chats (construction ref)"),
    },
    "ExperienceCopilotAdapter stores (lifecycle)",
  ));
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("ExperienceCopilotAdapter lifecycle (ER-11a)", () => {
  it("getActive returns the wire-mapped active thread when the store has one", async () => {
    const thread = makeThread({ title: "Active draft" });
    const { store } = makeStore({ getActive: async () => thread });
    const adapter = makeAdapter(store);

    expect(await adapter.experienceCopilotGetActive("script_1")).toEqual({
      id: "thread_1",
      scriptId: "script_1",
      draftSessionId: null,
      title: "Active draft",
      archivedAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      metrics: null,
      contextLinks: [],
      todo: [],
    });
  });

  it("getActive returns null when the store has no active thread", async () => {
    const { store } = makeStore({ getActive: async () => null });
    const adapter = makeAdapter(store);

    expect(await adapter.experienceCopilotGetActive("script_1")).toBeNull();
  });

  it("maps the thread's todo checklist to the wire (TAG-6, restored PM-7)", async () => {
    const thread = makeThread({
      todo: [
        { title: "Write the rules buffer", status: "active" },
        { title: "Bind a visual", status: "pending" },
      ],
    });
    const { store } = makeStore({ getActive: async () => thread });
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotGetActive("script_1");
    expect(wire?.todo).toEqual([
      { title: "Write the rules buffer", status: "active" },
      { title: "Bind a visual", status: "pending" },
    ]);
  });

  it("listMessages returns wire-mapped messages in store order (oldest → newest)", async () => {
    const messages = [
      makeMessage({ id: "msg_1", role: "user", content: "first" }),
      makeMessage({ id: "msg_2", role: "assistant", content: "second" }),
    ];
    const { store } = makeStore({ listMessages: async () => messages });
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotListMessages("thread_1");
    expect(wire.map((m) => m.content)).toEqual(["first", "second"]);
    expect(wire[0]).toEqual({
      id: "msg_1",
      threadId: "thread_1",
      role: "user",
      content: "first",
      toolCallsJson: null,
      toolCallId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("startNewSession delegates the title and the kind's auto-compact default to the store and returns the wire-mapped thread", async () => {
    const { store, calls } = makeStore();
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotStartNewSession("script_1", "Renamed");
    // AP-20: the delegation carries the resolved default (the fake kind
    // settings read ON) beside the title.
    expect(calls.startNewSession).toEqual([{ scriptId: "script_1", title: "Renamed", autoCompact: true }]);
    expect(wire.title).toBe("Renamed");
    expect(wire.archivedAt).toBeNull();
  });

  it("maps nullable archivedAt/draftSessionId/scriptId to null, never undefined", async () => {
    const thread = makeThread({ scriptId: null, draftSessionId: null, archivedAt: null });
    const { store } = makeStore({ getActive: async () => thread });
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotGetActive("script_1");
    expect(wire?.scriptId).toBeNull();
    expect(wire?.draftSessionId).toBeNull();
    expect(wire?.archivedAt).toBeNull();
  });

  it("renameSession trims the title, delegates to the store, and maps to wire", async () => {
    const { store, calls } = makeStore();
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotRenameSession("thread_1", "  Дурак — визуал  ");

    expect(calls.renameSession).toEqual([{ sessionId: "thread_1", title: "Дурак — визуал" }]);
    expect(wire?.id).toBe("thread_1");
    expect(wire?.title).toBe("Дурак — визуал");
  });

  it("renameSession with a whitespace-only title clears to the empty fallback", async () => {
    const { store, calls } = makeStore();
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotRenameSession("thread_1", "   ");

    // Empty = "no custom title" → the UI falls back to the auto-numbered label.
    expect(calls.renameSession).toEqual([{ sessionId: "thread_1", title: "" }]);
    expect(wire?.title).toBe("");
  });

  it("renameSession maps a missing thread to null (not a throw)", async () => {
    const { store } = makeStore({
      renameSession: async () => null,
    });
    const adapter = makeAdapter(store);

    expect(await adapter.experienceCopilotRenameSession("gone", "x")).toBeNull();
  });
});
