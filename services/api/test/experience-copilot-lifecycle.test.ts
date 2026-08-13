import { describe, expect, it } from "bun:test";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ExperienceCopilotMessage,
  StoreContainer,
} from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";

// ─── Domain fixtures ─────────────────────────────────────────────────────────

function makeThread(overrides: Partial<ExperienceCopilotThread> = {}): ExperienceCopilotThread {
  return {
    id: "thread_1",
    scriptId: "script_1",
    draftSessionId: null,
    title: "Draft",
    archivedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
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
};

function makeStore(overrides: StoreOverrides = {}) {
  const calls: { startNewSession: Array<{ scriptId: string; title?: string }> } = {
    startNewSession: [],
  };
  const store = {
    getActive: overrides.getActive ?? (async () => null),
    listMessages: overrides.listMessages ?? (async () => []),
    startNewSession:
      overrides.startNewSession ??
      (async (scriptId: string, title?: string) => {
        calls.startNewSession.push({ scriptId, title });
        return makeThread({ scriptId, title: title ?? "" });
      }),
  } as unknown as ExperienceCopilotStore;
  return { store, calls };
}

function makeAdapter(store: ExperienceCopilotStore): ExperienceCopilotAdapter {
  return new ExperienceCopilotAdapter({ experienceCopilot: store } as unknown as StoreContainer);
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
    });
  });

  it("getActive returns null when the store has no active thread", async () => {
    const { store } = makeStore({ getActive: async () => null });
    const adapter = makeAdapter(store);

    expect(await adapter.experienceCopilotGetActive("script_1")).toBeNull();
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

  it("startNewSession delegates the title to the store and returns the wire-mapped thread", async () => {
    const { store, calls } = makeStore();
    const adapter = makeAdapter(store);

    const wire = await adapter.experienceCopilotStartNewSession("script_1", "Renamed");
    expect(calls.startNewSession).toEqual([{ scriptId: "script_1", title: "Renamed" }]);
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
});
