import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatId, ChatBranchId } from "@vibe-tavern/domain";
import { useSnapshotStore } from "./snapshot-store.js";
import type { AppCharacter, AppMessage, AppSnapshot } from "../app-client.js";

// Branded-id cast helpers (match the convention in bootstrap-actions.test.ts).
const asChatId = (id: string): ChatId => id as ChatId;
const asBranchId = (id: string): ChatBranchId => id as ChatBranchId;

/**
 * Phase 3.4.1 — absence pipeline behavioural spec.
 *
 * ingestSnapshot must treat an ABSENT field as "preserve whatever the store
 * already holds" and a PRESENT field (including empty `[]` or `null`) as
 * "replace". This is what makes endpoint-scoped partial responses (Phase
 * 3.4.2) safe: a swipe response can omit `messages` without wiping the chat,
 * while a delete-message response can send `messages: []` to clear it.
 */

function makeCharacter(id: string, name = `Char ${id}`): AppCharacter {
  return {
    id,
    name,
    avatarExt: null,
    avatarFullExt: null,
    description: "",
    scenario: "",
    systemPrompt: "",
    subtitle: "",
    firstMessage: null,
    mesExample: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: [],
    postHistoryInstructions: null,
    creatorNotes: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    tags: [],
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    personalitySummary: null,
    includeGalleryInPrompt: false,
    includeAvatarInPrompt: false,
    avatarDescription: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function makeMessage(id: string, content = `msg ${id}`): AppMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [],
    selectedVariantIndex: null,
    modelId: null,
  } as unknown as AppMessage;
}

/** A full snapshot seeding the store with a known character + messages. */
function fullSeed(): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", messageCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat 1", characterId: "c1" } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages: [makeMessage("m1"), makeMessage("m2")],
    summaries: [],
    promptTrace: null,
    promptTraceHistory: [],
    contextPreview: null,
    character: makeCharacter("c1"),
    persona: null,
  } as unknown as AppSnapshot;
}

beforeEach(() => {
  useSnapshotStore.getState().clear();
});

describe("ingestSnapshot — absence pipeline (Phase 3.4.1)", () => {
  test("a partial { character } response preserves messages, chats, persona, etc.", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const before = useSnapshotStore.getState();
    expect(before.messageOrder).toEqual(["m1", "m2"]);
    expect(before.character?.id).toBe("c1");
    expect(before.chatsById["chat-1"]?.title).toBe("Chat 1");

    // Endpoint returns only the character it mutated — nothing else.
    const partial = { character: makeCharacter("c1", "Updated name") } as AppSnapshot;
    useSnapshotStore.getState().ingestSnapshot(partial);

    const after = useSnapshotStore.getState();
    // character updated
    expect(after.character?.name).toBe("Updated name");
    // everything else preserved (the core TD-004 guarantee)
    expect(after.messageOrder).toEqual(["m1", "m2"]);
    expect(after.messagesById["m1"]?.content).toBe("msg m1");
    expect(after.chatsById["chat-1"]?.title).toBe("Chat 1");
    expect(after.activeChat?.id).toBe(asChatId("chat-1"));
    expect(after.activeBranch?.id).toBe(asBranchId("b1"));
  });

  test("a present `messages: []` REPLACES messages (clears the chat)", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    expect(useSnapshotStore.getState().messageOrder).toEqual(["m1", "m2"]);

    useSnapshotStore.getState().ingestSnapshot({ messages: [] } as AppSnapshot);

    const after = useSnapshotStore.getState();
    expect(after.messageOrder).toEqual([]);
    expect(after.messagesById).toEqual({});
    // absent fields preserved
    expect(after.character?.id).toBe("c1");
    expect(after.activeChat?.id).toBe(asChatId("chat-1"));
  });

  test("a response omitting `messages` preserves existing messages", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const originalOrder = useSnapshotStore.getState().messageOrder;

    // Add a new message via a partial that includes messages — replace semantics
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m1"), makeMessage("m2"), makeMessage("m3")],
    } as AppSnapshot);
    expect(useSnapshotStore.getState().messageOrder).toEqual(["m1", "m2", "m3"]);

    // A subsequent contextPreview-only response must NOT drop m3.
    useSnapshotStore.getState().ingestSnapshot({ contextPreview: null } as AppSnapshot);
    expect(useSnapshotStore.getState().messageOrder).toEqual(["m1", "m2", "m3"]);
    expect(originalOrder).toEqual(["m1", "m2"]);
  });

  test("clearMessages() wipes only messages, leaving character/chats intact", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    useSnapshotStore.getState().clearMessages();

    const after = useSnapshotStore.getState();
    expect(after.messageOrder).toEqual([]);
    expect(after.messagesById).toEqual({});
    expect(after.character?.id).toBe("c1");
    expect(after.chatsById["chat-1"]?.title).toBe("Chat 1");
  });
});

/**
 * Wave B2 — dedup / reference-stability spec.
 *
 * ingestSnapshot must keep the SAME store object reference when re-ingesting
 * an unchanged wire object (so MessageBlock / chat-list subscribers don't
 * re-render — the Wave A isolation invariant leans on this), and yield a NEW
 * reference when content actually changed. The dedup comparator must
 * reproduce `JSON.stringify(a) === JSON.stringify(b)` decisions exactly for
 * JSON-compatible data, but WITHOUT the double string allocation that
 * sameJson does today (the B2 optimization). These cases must be green
 * BEFORE the comparator change AND after — they are its characterization
 * guard.
 */
describe("ingestSnapshot — dedup / reference stability (Wave B2)", () => {
  test("re-ingesting identical messages keeps the same store references", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const m1Before = useSnapshotStore.getState().messagesById["m1"];
    const m2Before = useSnapshotStore.getState().messagesById["m2"];
    expect(m1Before).toBeDefined();

    // Simulate a full-snapshot re-send (another mutation returned all
    // messages): fresh parsed objects, identical content.
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m1"), makeMessage("m2")],
    } as AppSnapshot);

    const s = useSnapshotStore.getState();
    expect(s.messagesById["m1"]).toBe(m1Before); // SAME ref → no re-render
    expect(s.messagesById["m2"]).toBe(m2Before);
  });

  test("a changed message yields a new reference; an unchanged sibling keeps its ref", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const m1Before = useSnapshotStore.getState().messagesById["m1"];
    const m2Before = useSnapshotStore.getState().messagesById["m2"];

    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m1", "edited content"), makeMessage("m2")],
    } as AppSnapshot);

    const s = useSnapshotStore.getState();
    expect(s.messagesById["m1"]).not.toBe(m1Before); // changed → NEW ref
    expect(s.messagesById["m1"]?.content).toBe("edited content");
    expect(s.messagesById["m2"]).toBe(m2Before); // unchanged → SAME ref
  });

  test("reordered messages update order but keep per-message references", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed()); // [m1, m2]
    const m1Before = useSnapshotStore.getState().messagesById["m1"];
    const m2Before = useSnapshotStore.getState().messagesById["m2"];

    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m2"), makeMessage("m1")], // reversed
    } as AppSnapshot);

    const s = useSnapshotStore.getState();
    expect(s.messageOrder).toEqual(["m2", "m1"]);
    expect(s.messagesById["m1"]).toBe(m1Before); // content unchanged → same ref
    expect(s.messagesById["m2"]).toBe(m2Before);
  });

  test("a nested change (object field + array content) yields a new reference", () => {
    type Rich = AppMessage & { meta: { note: string; tags: string[] } };
    const rich = (note: string, tags: string[]): Rich =>
      ({ ...makeMessage("r1"), content: "same", meta: { note, tags } }) as unknown as Rich;

    useSnapshotStore.getState().ingestSnapshot({ messages: [rich("a", ["x"])] } as AppSnapshot);
    const before = useSnapshotStore.getState().messagesById["r1"];

    // change a nested primitive
    useSnapshotStore.getState().ingestSnapshot({ messages: [rich("b", ["x"])] } as AppSnapshot);
    expect(useSnapshotStore.getState().messagesById["r1"]).not.toBe(before);

    // change a nested array (same length, different content)
    const ref2 = useSnapshotStore.getState().messagesById["r1"];
    useSnapshotStore.getState().ingestSnapshot({ messages: [rich("b", ["x", "y"])] } as AppSnapshot);
    expect(useSnapshotStore.getState().messagesById["r1"]).not.toBe(ref2);

    // truly identical nested → SAME ref (the regression guard)
    const ref3 = useSnapshotStore.getState().messagesById["r1"];
    useSnapshotStore.getState().ingestSnapshot({ messages: [rich("b", ["x", "y"])] } as AppSnapshot);
    expect(useSnapshotStore.getState().messagesById["r1"]).toBe(ref3);
  });

  test("re-ingesting identical chats keeps the same store reference; a renamed chat yields a new one", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const chatBefore = useSnapshotStore.getState().chatsById["chat-1"];

    const sameChat = {
      id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1",
      subtitle: "", activeBranchLabel: "main", messageCount: 2, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    useSnapshotStore.getState().ingestSnapshot({ chats: [sameChat] } as AppSnapshot);
    expect(useSnapshotStore.getState().chatsById["chat-1"]).toBe(chatBefore); // SAME ref

    const renamedChat = { ...sameChat, title: "Chat 1 (renamed)" };
    useSnapshotStore.getState().ingestSnapshot({ chats: [renamedChat] } as AppSnapshot);
    expect(useSnapshotStore.getState().chatsById["chat-1"]).not.toBe(chatBefore); // NEW ref
    expect(useSnapshotStore.getState().chatsById["chat-1"]?.title).toBe("Chat 1 (renamed)");
  });
});
