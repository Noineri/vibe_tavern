import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { wireCharacter } from "../../test/wire-fixtures.js";
import type { Attachment, ChatId, ChatBranchId, MessageVariantId, Timestamp } from "@vibe-tavern/domain";
import { useSnapshotStore } from "./snapshot-store.js";
import type { AppCharacter, AppMessage, AppSnapshot, InsightsCompletionPatchResponse, SceneTargetResponse } from "../api/types.js";
import { countTokens, getTokenizer, resetTokenCountCacheForTests } from "../utils/tokenizer.js";
import { replaceUiMacros } from "../lib/macros.js";

// Branded-id cast helpers (match the convention in bootstrap-actions.test.ts).
const asChatId = (id: string): ChatId => id as ChatId;
const asBranchId = (id: string): ChatBranchId => id as ChatBranchId;
const asVariantId = (id: string): MessageVariantId => id as MessageVariantId;
const asTimestamp = (value: string): Timestamp => value as Timestamp;

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
    ...wireCharacter(),
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
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", mode: "rp", messageCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat 1", characterId: "c1" } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages: [makeMessage("m1"), makeMessage("m2")],
    summaries: [],
    promptTrace: null,
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

    // A subsequent promptTrace-only response must NOT drop m3.
    useSnapshotStore.getState().ingestSnapshot({ promptTrace: null } as AppSnapshot);
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
      subtitle: "", activeBranchLabel: "main", mode: "rp", messageCount: 2, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    useSnapshotStore.getState().ingestSnapshot({ chats: [sameChat] } as AppSnapshot);
    expect(useSnapshotStore.getState().chatsById["chat-1"]).toBe(chatBefore); // SAME ref

    const renamedChat = { ...sameChat, title: "Chat 1 (renamed)" };
    useSnapshotStore.getState().ingestSnapshot({ chats: [renamedChat] } as AppSnapshot);
    expect(useSnapshotStore.getState().chatsById["chat-1"]).not.toBe(chatBefore); // NEW ref
    expect(useSnapshotStore.getState().chatsById["chat-1"]?.title).toBe("Chat 1 (renamed)");
  });
});

/**
 * LC-3 — per-entry reference identity against the plain pre-ingest state.
 *
 * ingestSnapshot's dedup comparator reads the store's PRE-INGEST state
 * (`get()` captured before `set`), never the Immer draft — comparing
 * through a draft proxy-walks the whole stored subtree per entry (D3 in
 * LONG_CHAT_PERFORMANCE_REPORT: 600 messages × the full tree on every
 * delete/edit/swipe/send). The observable contract of that seam: within one
 * snapshot, exactly the entries whose content differs from the store get a
 * new reference; every sibling keeps its exact stored object — at any
 * snapshot size, not just Wave B2's single-sibling cases.
 */
describe("ingestSnapshot — one changed entry, all siblings stable (LC-3)", () => {
  test("a snapshot with ONE changed message replaces only that message's reference", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    // A full-branch refresh carrying four messages (delete/edit/swipe
    // responses re-send the whole list).
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m1"), makeMessage("m2"), makeMessage("m3"), makeMessage("m4")],
    } as AppSnapshot);
    const before = useSnapshotStore.getState().messagesById;
    expect(Object.keys(before).sort()).toEqual(["m1", "m2", "m3", "m4"]);

    // Same four re-sent, only m3's content differs.
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m1"), makeMessage("m2"), makeMessage("m3", "edited"), makeMessage("m4")],
    } as AppSnapshot);

    const after = useSnapshotStore.getState().messagesById;
    expect(after["m3"]).not.toBe(before["m3"]); // changed → NEW reference
    expect(after["m3"]?.content).toBe("edited");
    expect(after["m1"]).toBe(before["m1"]); // every sibling keeps its exact object
    expect(after["m2"]).toBe(before["m2"]);
    expect(after["m4"]).toBe(before["m4"]);
  });

  test("a snapshot with ONE changed chat replaces only that chat's reference", () => {
    const chat = (id: string, title: string) => ({
      id, title, characterId: "c1", characterName: "Char c1",
      subtitle: "", activeBranchLabel: "main", mode: "rp", messageCount: 1, updatedAt: "2026-01-01T00:00:00.000Z",
    });
    useSnapshotStore.getState().ingestSnapshot({
      chats: [chat("c-a", "A"), chat("c-b", "B"), chat("c-c", "C")],
    } as AppSnapshot);
    const before = useSnapshotStore.getState().chatsById;
    expect(Object.keys(before).sort()).toEqual(["c-a", "c-b", "c-c"]);

    // Same three re-sent, only c-b's title differs.
    useSnapshotStore.getState().ingestSnapshot({
      chats: [chat("c-a", "A"), chat("c-b", "B (renamed)"), chat("c-c", "C")],
    } as AppSnapshot);

    const after = useSnapshotStore.getState().chatsById;
    expect(after["c-b"]).not.toBe(before["c-b"]); // changed → NEW reference
    expect(after["c-b"]?.title).toBe("B (renamed)");
    expect(after["c-a"]).toBe(before["c-a"]); // every sibling keeps its exact object
    expect(after["c-c"]).toBe(before["c-c"]);
  });
});

// ── SCN-4: variant Scene projection + local selected-swap ────────────────

describe("selectVariant — Scene swap (SCN-4)", () => {
  test("selecting a variant swaps the active Scene record locally without a fetch", () => {
    const sceneA: NonNullable<AppMessage["sceneTracker"]> = { variantId: asVariantId("var_0"), schemaHash: "h0", configRevision: 1, sourceHash: "s0", sceneState: { mood: "calm" }, modelId: null, generatedAt: asTimestamp("2026-01-01T00:00:00.000Z") };
    const sceneB: NonNullable<AppMessage["sceneTracker"]> = { variantId: asVariantId("var_1"), schemaHash: "h1", configRevision: 1, sourceHash: "s1", sceneState: { mood: "tense" }, modelId: null, generatedAt: asTimestamp("2026-01-01T00:00:00.000Z") };
    const message = {
      id: "m1",
      role: "assistant",
      content: "Reply A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      variants: [
        { id: "var_0", messageId: "m1", variantIndex: 0, content: "Reply A", isSelected: true, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", sceneTracker: sceneA },
        { id: "var_1", messageId: "m1", variantIndex: 1, content: "Reply B", isSelected: false, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", sceneTracker: sceneB },
      ],
      selectedVariantIndex: 0,
      modelId: null,
      sceneTracker: sceneA,
    } as unknown as AppMessage;

    useSnapshotStore.getState().ingestSnapshot({ messages: [message] } as AppSnapshot);

    // After ingest, the active record mirrors the selected variant (var_0).
    const afterIngest = useSnapshotStore.getState().messagesById["m1"]!;
    expect(afterIngest.selectedVariantIndex).toBe(0);
    expect(afterIngest.sceneTracker).toEqual(sceneA);

    // Select variant 1 locally — the active record swaps to var_1, no fetch.
    useSnapshotStore.getState().selectVariant("m1", 1, 1);
    const afterSelect = useSnapshotStore.getState().messagesById["m1"]!;
    expect(afterSelect.selectedVariantIndex).toBe(1);
    expect(afterSelect.sceneTracker).toEqual(sceneB);
    // Both per-variant records remain on their own variants.
    expect(afterSelect.variants[0]!.sceneTracker).toEqual(sceneA);
    expect(afterSelect.variants[1]!.sceneTracker).toEqual(sceneB);
  });
});

// ── IG-CF10: swipe swaps slot attachments ───────────────────────────────
//
// Fixture idiom mirrors the SCN-4 block above: a slot message whose ROW
// carries the original image (variant 0 is null-carrying, so the server DTO
// merge falls through to the message-level set) and whose variant 1 carries
// its own regenerated image via attachmentsJson.

function slotAttachment(id: string, assetId: string): Attachment {
  return {
    id,
    assetId,
    type: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1234,
    imageGen: { mode: "portrait", profileId: "p1", params: {} },
  };
}

const ROW_ATTS: Attachment[] = [slotAttachment("att-row", "asset-row")];
const V1_ATTS: Attachment[] = [slotAttachment("att-v1", "asset-v1")];

function makeSlotMessage(): AppMessage {
  return {
    id: "slot-1",
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachments: ROW_ATTS,
    variants: [
      { id: "var_0", messageId: "slot-1", variantIndex: 0, content: "", isSelected: true, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: null },
      { id: "var_1", messageId: "slot-1", variantIndex: 1, content: "", isSelected: false, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: JSON.stringify(V1_ATTS) },
    ],
    selectedVariantIndex: 0,
    modelId: null,
    sceneTracker: null,
  } as unknown as AppMessage;
}

describe("selectVariant — slot attachment swap (IG-CF10)", () => {
  test("selecting a variant carrying attachmentsJson swaps msg.attachments to its parsed set", () => {
    useSnapshotStore.getState().ingestSnapshot({ messages: [makeSlotMessage()] } as AppSnapshot);
    useSnapshotStore.getState().selectVariant("slot-1", 1, 1);
    const after = useSnapshotStore.getState().messagesById["slot-1"]!;
    expect(after.selectedVariantIndex).toBe(1);
    expect(after.attachments).toEqual(V1_ATTS);
    // The swap never rewrites the variant records themselves.
    expect(after.variants[0]!.attachmentsJson).toBeNull();
    expect(after.variants[1]!.attachmentsJson).toBe(JSON.stringify(V1_ATTS));
  });

  test("switching to a null (legacy) variant falls back to the message-level attachments", () => {
    useSnapshotStore.getState().ingestSnapshot({ messages: [makeSlotMessage()] } as AppSnapshot);
    useSnapshotStore.getState().selectVariant("slot-1", 1, 1);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(V1_ATTS);
    useSnapshotStore.getState().selectVariant("slot-1", 0, -1);
    const after = useSnapshotStore.getState().messagesById["slot-1"]!;
    expect(after.selectedVariantIndex).toBe(0);
    // Not the previously selected variant's stale set — the row set.
    expect(after.attachments).toEqual(ROW_ATTS);
  });

  test("the message-level fallback survives swipe round-trips and a post-regen re-ingest", () => {
    useSnapshotStore.getState().ingestSnapshot({ messages: [makeSlotMessage()] } as AppSnapshot);
    // Swipe round-trip: v0 -> v1 -> v0 resolves the row set every time.
    useSnapshotStore.getState().selectVariant("slot-1", 1, 1);
    useSnapshotStore.getState().selectVariant("slot-1", 0, -1);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(ROW_ATTS);

    // Post-regen refresh: the server lands with the new variant selected, so
    // the wire merge shows ITS set and the row set is unknowable from this
    // snapshot — the previously captured shadow must survive the wholesale
    // replacement.
    const postRegen = {
      ...makeSlotMessage(),
      attachments: V1_ATTS,
      selectedVariantIndex: 1,
      variants: [
        { id: "var_0", messageId: "slot-1", variantIndex: 0, content: "", isSelected: false, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: null },
        { id: "var_1", messageId: "slot-1", variantIndex: 1, content: "", isSelected: true, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: JSON.stringify(V1_ATTS) },
      ],
    } as unknown as AppMessage;
    useSnapshotStore.getState().ingestSnapshot({ messages: [postRegen] } as AppSnapshot);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(V1_ATTS);
    // Swiping back to the legacy variant still resolves the original row set.
    useSnapshotStore.getState().selectVariant("slot-1", 0, -1);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(ROW_ATTS);
  });

  test("fresh ingest landing on an attachment-carrying variant keeps the current set for null targets (legacy payload)", () => {
    // Legacy server payload (pre-CF10b): the row set never appeared on the
    // wire (no explicit field, no prior shadow): the client cannot invent
    // it, so swiping to the null variant keeps the current set instead of
    // overwriting it with a guess.
    const landedOnV1 = {
      ...makeSlotMessage(),
      attachments: V1_ATTS,
      selectedVariantIndex: 1,
      variants: [
        { id: "var_0", messageId: "slot-1", variantIndex: 0, content: "", isSelected: false, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: null },
        { id: "var_1", messageId: "slot-1", variantIndex: 1, content: "", isSelected: true, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: JSON.stringify(V1_ATTS) },
      ],
    } as unknown as AppMessage;
    useSnapshotStore.getState().ingestSnapshot({ messages: [landedOnV1] } as AppSnapshot);
    useSnapshotStore.getState().selectVariant("slot-1", 0, -1);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(V1_ATTS);
  });

  test("CF10b: an explicit messageLevelAttachments field resolves the row set on swipe (owner defect 2026-09-29)", () => {
    // The fixed wire shape: a chat loaded with a variant-level set selected
    // carries the hidden row set as an explicit field (IG-CF10b). Swiping
    // back to the base variant must show the ROW image — previously this
    // corner kept the previous variant's image on screen, which read as
    // "identical content on swipes 1 and 2".
    const withExplicitRowSet = {
      ...makeSlotMessage(),
      attachments: V1_ATTS,
      messageLevelAttachments: ROW_ATTS,
      selectedVariantIndex: 1,
      variants: [
        { id: "var_0", messageId: "slot-1", variantIndex: 0, content: "", isSelected: false, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: null },
        { id: "var_1", messageId: "slot-1", variantIndex: 1, content: "", isSelected: true, finishReason: null, createdAt: "2026-01-01T00:00:00.000Z", attachmentsJson: JSON.stringify(V1_ATTS) },
      ],
    } as unknown as AppMessage;
    useSnapshotStore.getState().ingestSnapshot({ messages: [withExplicitRowSet] } as AppSnapshot);
    // Loaded state: the selected variant's set.
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(V1_ATTS);
    useSnapshotStore.getState().selectVariant("slot-1", 0, -1);
    // Base variant: the row set, in the same session, no reload.
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(ROW_ATTS);
    // And the explicit field survives wholesale replacement (later snapshots
    // keep carrying it while a variant-level set is selected).
    useSnapshotStore.getState().selectVariant("slot-1", 1, 1);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(V1_ATTS);
    useSnapshotStore.getState().selectVariant("slot-1", 0, -1);
    expect(useSnapshotStore.getState().messagesById["slot-1"]!.attachments).toEqual(ROW_ATTS);
  });
});

// ── TC-5: known token counts seeded from server DTOs ──────────────────────

/**
 * TOKEN_COUNT_ONCE_PLAN Wave 3: the server's token counts (riding the wire
 * on every message and variant DTO since TC-4, computed by the SAME cl100k
 * ladder the browser uses) seed a known-count map in front of the LC-5 LRU.
 * The browser must encode NO text the server already counted; local-only
 * mutations never seed. Pins use the LC-5 encode-spy idiom (own-property
 * shadow on the shared encoder singleton, removed in afterAll — the real
 * BPE still runs, so fixture numbers are real server numbers).
 */
describe("ingestSnapshot — known token counts from server DTOs (TC-5)", () => {
  const tokenizer = getTokenizer();
  const realEncode = tokenizer.encode.bind(tokenizer);
  const encodedTexts: string[] = [];
  tokenizer.encode = mock((text: string) => {
    encodedTexts.push(text);
    return realEncode(text);
  });
  afterAll(() => {
    delete (tokenizer as { encode?: unknown }).encode;
  });
  beforeEach(() => {
    encodedTexts.length = 0;
    resetTokenCountCacheForTests();
  });

  /** Server-shaped row: content + every variant carry their wire tokenCount. */
  function makeServerMessage(id: string, content: string, variantContents: string[] = []): AppMessage {
    const variants = variantContents.map((variantContent, index) => ({
      id: `${id}_v${index}`,
      messageId: id,
      variantIndex: index,
      content: variantContent,
      isSelected: index === 0,
      finishReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      tokenCount: realEncode(variantContent).length,
    }));
    return {
      id,
      chatId: "chat-tc5",
      branchId: "branch-tc5",
      role: "assistant",
      authorType: "assistant",
      position: 1,
      content,
      state: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tokenCount: realEncode(content).length,
      variants,
      selectedVariantIndex: variants.length > 0 ? 0 : null,
      modelId: null,
      sceneTracker: null,
    } as unknown as AppMessage;
  }

  test("a 600-message snapshot with variants: full pass over every message and variant encodes 0 times", () => {
    const messages = Array.from({ length: 600 }, (_, i) =>
      makeServerMessage(`long-${i}`, `long chat message body ${i} — stable text`, [
        `long chat message body ${i} — stable text`,
        `alternate reply variant ${i} of the long chat`,
      ]),
    );
    // Fixture building encodes for real (honest server numbers) — start the
    // count AFTER it, so the assertion covers only the consumer pass.
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({ messages } as AppSnapshot);

    // SummaryTab-style pass (countedMessages): every message's content.
    const state = useSnapshotStore.getState();
    for (const id of state.messageOrder) {
      countTokens(state.messagesById[id]!.content);
    }
    // Variant-level reads (swipes, co-author parts): every variant's content.
    for (const msg of Object.values(useSnapshotStore.getState().messagesById)) {
      for (const variant of msg.variants) countTokens(variant.content);
    }
    expect(encodedTexts).toEqual([]);
    // The served numbers are the server's (spot-check across the range).
    expect(countTokens(messages[0]!.content)).toBe(messages[0]!.tokenCount);
    expect(countTokens(messages[599]!.variants[1]!.content)).toBe(messages[599]!.variants[1]!.tokenCount);
    expect(encodedTexts).toEqual([]);
  });

  test("mounting the feed path (useDisplayMessage-style per-message count) encodes 0 times", () => {
    const messages = Array.from({ length: 50 }, (_, i) => makeServerMessage(`feed-${i}`, `feed message ${i} body text`));
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({ messages } as AppSnapshot);

    // useDisplayMessage's derivation with no macro context: displayContent
    // IS the stored content — every per-message label is a known hit.
    const macroCtx = null;
    for (const id of useSnapshotStore.getState().messageOrder) {
      const msg = useSnapshotStore.getState().messagesById[id]!;
      const displayContent = macroCtx ? replaceUiMacros(msg.content, macroCtx) : msg.content;
      expect(countTokens(displayContent)).toBe(msg.tokenCount);
    }
    expect(encodedTexts).toEqual([]);
  });

  test("a variant switch surfaces that variant's count with 0 encodes", () => {
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeServerMessage("swipe-1", "selected body", ["selected body", "variant one body"])],
    } as AppSnapshot);
    expect(countTokens("selected body")).toBe(realEncode("selected body").length);
    expect(encodedTexts).toEqual([]);

    // Optimistic swipe: selectVariant writes the variant's content into the
    // row LOCALLY (never seeds) — the count still comes from the map entry
    // the variant's DTO seeded at ingest.
    useSnapshotStore.getState().selectVariant("swipe-1", 1, 1);
    const switched = useSnapshotStore.getState().messagesById["swipe-1"]!;
    expect(switched.content).toBe("variant one body");
    expect(countTokens(switched.content)).toBe(realEncode("variant one body").length);
    expect(encodedTexts).toEqual([]);
  });

  test("ingesting chat B's snapshot drops chat A's entries — A's text encodes again", () => {
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeServerMessage("a1", "chat A text one"), makeServerMessage("a2", "chat A text two")],
    } as AppSnapshot);
    // A's texts are served by the known map — no encode.
    expect(countTokens("chat A text one")).toBe(realEncode("chat A text one").length);
    expect(encodedTexts).toEqual([]);

    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeServerMessage("b1", "chat B text one")],
    } as AppSnapshot);
    expect(countTokens("chat B text one")).toBe(realEncode("chat B text one").length);
    expect(encodedTexts).toEqual([]); // B served by its own snapshot's counts
    // A's dropped entry now encodes again — the spy count goes up.
    expect(countTokens("chat A text one")).toBe(realEncode("chat A text one").length);
    expect(encodedTexts).toEqual(["chat A text one"]);
  });

  test("a macro-substituted display text is a miss by design — encoded, today's value", () => {
    encodedTexts.length = 0;
    const content = "Hi {{user}}, the dice show 42!";
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeServerMessage("macro-1", content)],
    } as AppSnapshot);
    // The raw content is known — served, not encoded.
    expect(countTokens(content)).toBe(realEncode(content).length);
    expect(encodedTexts).toEqual([]);

    // useDisplayMessage's derivation with a macro context: the substituted
    // text differs from `content`, misses by design, and is counted locally
    // exactly as before TC-5 (same value the label showed today).
    const displayContent = replaceUiMacros(content, { characterName: "Nekomata", personaName: "Player" });
    expect(displayContent).not.toBe(content);
    expect(countTokens(displayContent)).toBe(realEncode(displayContent).length);
    expect(encodedTexts).toEqual([displayContent]);
  });

  test("applyInsightsCompletionPatch seeds the patched server message's counts", () => {
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: "chat-tc5", mode: "rp" } as unknown as AppSnapshot["activeChat"],
      messages: [makeServerMessage("insights-1", "original insights body")],
    } as AppSnapshot);
    const patched = makeServerMessage("insights-1", "regenerated insights body");
    const applied = useSnapshotStore.getState().applyInsightsCompletionPatch({
      target: { chatId: "chat-tc5", branchId: "branch-tc5", messageId: "insights-1", variantId: null },
      patch: { message: patched },
    } as unknown as InsightsCompletionPatchResponse);
    expect(applied).toBe(true);
    expect(useSnapshotStore.getState().messagesById["insights-1"]?.content).toBe("regenerated insights body");
    expect(countTokens("regenerated insights body")).toBe(realEncode("regenerated insights body").length);
    expect(encodedTexts).toEqual([]);
  });

  test("applySceneTargetPatch seeds the patched server message's counts", () => {
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: "chat-tc5", mode: "rp" } as unknown as AppSnapshot["activeChat"],
      messages: [makeServerMessage("scene-1", "scene body v0", ["scene body v0", "scene body v1"])],
    } as AppSnapshot);
    const regenerated = makeServerMessage("scene-1", "regenerated scene body", ["scene body v0", "regenerated scene body"]);
    const applied = useSnapshotStore.getState().applySceneTargetPatch({
      target: { chatId: "chat-tc5", branchId: "branch-tc5", messageId: "scene-1", variantId: "scene-1_v1" },
      message: regenerated,
    } as unknown as SceneTargetResponse);
    expect(applied).toBe(true);
    expect(countTokens("regenerated scene body")).toBe(realEncode("regenerated scene body").length);
    expect(encodedTexts).toEqual([]);
  });

  test("a local optimistic edit never seeds — the edited text encodes", () => {
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeServerMessage("edit-1", "original server body")],
    } as AppSnapshot);
    useSnapshotStore.getState().updateMessage("edit-1", { content: "locally edited body" });
    expect(countTokens("locally edited body")).toBe(realEncode("locally edited body").length);
    expect(encodedTexts).toEqual(["locally edited body"]);
  });

  test("clearMessages drops the known map (chat switch with no follow-up ingest)", () => {
    encodedTexts.length = 0;
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeServerMessage("clear-1", "cleared chat text")],
    } as AppSnapshot);
    expect(countTokens("cleared chat text")).toBe(realEncode("cleared chat text").length);
    expect(encodedTexts).toEqual([]);
    useSnapshotStore.getState().clearMessages();
    expect(countTokens("cleared chat text")).toBe(realEncode("cleared chat text").length);
    expect(encodedTexts).toEqual(["cleared chat text"]);
  });
});
