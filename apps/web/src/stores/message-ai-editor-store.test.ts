/**
 * Message AI editor store (MAE-43).
 *
 * Pins the ephemeral modal/star session state: per-message star isolation,
 * toggle set-semantics with stable insertion order, stale-ID pruning that can
 * never retarget a star after variant deletion/index compaction, the modal
 * open/close lifecycle (close keeps stars; edit open captures the selected
 * variant), and the successful-merge-save clearing path (`clearStars`).
 *
 * Cross-chat leakage is impossible BY KEY SHAPE: `messages.id` is a
 * single-column TEXT PRIMARY KEY (packages/db/src/db-schema.ts), globally
 * unique across chats — so the bare-messageId key needs no chat namespacing.
 * The tests assert the store-side half of that contract: operations on one
 * message's stars never touch another message's, even across chats.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { brandId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { useMessageAiEditorStore } from "./message-ai-editor-store.js";

const chat = (raw: string) => brandId<ChatId>(raw);
const msg = (raw: string) => brandId<MessageId>(raw);
const variant = (raw: string) => brandId<MessageVariantId>(raw);

const starsOf = (messageId: MessageId) =>
  useMessageAiEditorStore.getState().starredVariantIdsByMessage[messageId];

beforeEach(() => {
  useMessageAiEditorStore.setState({ target: null, starredVariantIdsByMessage: {} });
});

describe("per-message star isolation", () => {
  test("stars on different messages are independent lists", () => {
    const { toggleStar } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-2"), variant("v-b"));

    expect(starsOf(msg("m-1"))).toEqual([variant("v-a")]);
    expect(starsOf(msg("m-2"))).toEqual([variant("v-b")]);
  });

  test("clearStars removes only the targeted message's stars", () => {
    const { toggleStar, clearStars } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-2"), variant("v-b"));

    clearStars(msg("m-1"));

    expect(starsOf(msg("m-1"))).toBeUndefined();
    expect(starsOf(msg("m-2"))).toEqual([variant("v-b")]);
  });

  test("clearStars on a message with no stars is a no-op", () => {
    const before = useMessageAiEditorStore.getState().starredVariantIdsByMessage;
    useMessageAiEditorStore.getState().clearStars(msg("m-absent"));
    expect(useMessageAiEditorStore.getState().starredVariantIdsByMessage).toBe(before);
  });

  test("a message with its last star unstarred has NO key (not an empty list)", () => {
    const { toggleStar } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-a"));

    expect(starsOf(msg("m-1"))).toBeUndefined();
    expect("m-1" in useMessageAiEditorStore.getState().starredVariantIdsByMessage).toBe(false);
  });
});

describe("toggle ordering — set semantics, stable insertion order", () => {
  test("star list order is first-starred-first regardless of toggle sequence", () => {
    const { toggleStar } = useMessageAiEditorStore.getState();

    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    expect(starsOf(msg("m-1"))).toEqual([variant("v-a"), variant("v-b")]);

    useMessageAiEditorStore.setState({ starredVariantIdsByMessage: {} });
    toggleStar(msg("m-1"), variant("v-b"));
    toggleStar(msg("m-1"), variant("v-a"));
    expect(starsOf(msg("m-1"))).toEqual([variant("v-b"), variant("v-a")]);
  });

  test("toggle A,B vs B,A yields the same SET of members", () => {
    const { toggleStar } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    const ab = starsOf(msg("m-1"));

    useMessageAiEditorStore.setState({ starredVariantIdsByMessage: {} });
    toggleStar(msg("m-1"), variant("v-b"));
    toggleStar(msg("m-1"), variant("v-a"));
    const ba = starsOf(msg("m-1"));

    expect(new Set(ab)).toEqual(new Set(ba));
  });

  test("unstarring then re-starring a variant moves it to the end", () => {
    const { toggleStar } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    toggleStar(msg("m-1"), variant("v-a")); // unstar
    toggleStar(msg("m-1"), variant("v-a")); // re-star

    expect(starsOf(msg("m-1"))).toEqual([variant("v-b"), variant("v-a")]);
  });

  test("starring an already-starred variant removes it (toggle, not duplicate)", () => {
    const { toggleStar } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    toggleStar(msg("m-1"), variant("v-a"));

    expect(starsOf(msg("m-1"))).toEqual([variant("v-b")]);
  });
});

describe("stale-ID pruning after variant deletion / index compaction", () => {
  test("prune drops only IDs absent from the valid list, preserving survivor order", () => {
    const { toggleStar, pruneStaleStars } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    toggleStar(msg("m-1"), variant("v-c"));

    pruneStaleStars(msg("m-1"), [variant("v-c"), variant("v-a")]);

    expect(starsOf(msg("m-1"))).toEqual([variant("v-a"), variant("v-c")]);
  });

  test("prune NEVER adds or reassigns IDs — a deleted variant's star cannot retarget another variant", () => {
    const { toggleStar, pruneStaleStars } = useMessageAiEditorStore.getState();
    // v-b was starred, then its variant was deleted and the index compacted:
    // the variant formerly at index 2 (v-c) now sits at v-b's old index. The
    // star must die with v-b's immutable ID, not slide onto v-c.
    toggleStar(msg("m-1"), variant("v-b"));

    pruneStaleStars(msg("m-1"), [variant("v-a"), variant("v-c")]);

    expect(starsOf(msg("m-1"))).toBeUndefined();
    expect("m-1" in useMessageAiEditorStore.getState().starredVariantIdsByMessage).toBe(false);
  });

  test("prune with an empty valid list removes the message's star entry entirely", () => {
    const { toggleStar, pruneStaleStars } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));

    pruneStaleStars(msg("m-1"), []);

    expect(starsOf(msg("m-1"))).toBeUndefined();
  });

  test("prune on a message with no stars is a no-op and creates no key", () => {
    const before = useMessageAiEditorStore.getState().starredVariantIdsByMessage;
    useMessageAiEditorStore.getState().pruneStaleStars(msg("m-absent"), [variant("v-a")]);
    expect(useMessageAiEditorStore.getState().starredVariantIdsByMessage).toBe(before);
  });

  test("prune leaves other messages' stars untouched", () => {
    const { toggleStar, pruneStaleStars } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-2"), variant("v-b"));

    pruneStaleStars(msg("m-1"), []);

    expect(starsOf(msg("m-2"))).toEqual([variant("v-b")]);
  });
});

describe("modal open/close lifecycle", () => {
  test("starts closed", () => {
    expect(useMessageAiEditorStore.getState().target).toBeNull();
  });

  test("open edit captures the selected variant as the source", () => {
    useMessageAiEditorStore.getState().openEditor({
      requestedMode: "message_edit",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
      selectedVariantId: variant("v-sel"),
    });

    expect(useMessageAiEditorStore.getState().target).toEqual({
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
      requestedMode: "message_edit",
      selectedSourceVariantId: variant("v-sel"),
    });
  });

  test("open merge captures no selected variant — sources are the current stars", () => {
    useMessageAiEditorStore.getState().openEditor({
      requestedMode: "message_merge",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
    });

    expect(useMessageAiEditorStore.getState().target).toEqual({
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
      requestedMode: "message_merge",
      selectedSourceVariantId: null,
    });
  });

  test("opening replaces any previous target — only one editor can be open", () => {
    const { openEditor } = useMessageAiEditorStore.getState();
    openEditor({
      requestedMode: "message_edit",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
      selectedVariantId: variant("v-1"),
    });
    openEditor({
      requestedMode: "message_merge",
      targetChatId: chat("c-2"),
      targetMessageId: msg("m-2"),
    });

    const target = useMessageAiEditorStore.getState().target;
    expect(target?.targetMessageId).toBe(msg("m-2"));
    expect(target?.requestedMode).toBe("message_merge");
  });

  test("close clears the target but KEEPS every star (Virtuoso unmount/remount safe)", () => {
    const { toggleStar, openEditor, closeEditor } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    openEditor({
      requestedMode: "message_merge",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
    });

    closeEditor();

    expect(useMessageAiEditorStore.getState().target).toBeNull();
    expect(starsOf(msg("m-1"))).toEqual([variant("v-a"), variant("v-b")]);
  });

  test("stars persist across a full open → close → reopen cycle", () => {
    const { toggleStar, openEditor, closeEditor } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    openEditor({
      requestedMode: "message_merge",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
    });
    closeEditor();
    openEditor({
      requestedMode: "message_edit",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
      selectedVariantId: variant("v-a"),
    });

    expect(starsOf(msg("m-1"))).toEqual([variant("v-a")]);
  });
});

describe("clearStars action (explicit user clear)", () => {
  test("clearStars empties exactly the targeted message's stars", () => {
    // clearStars is an explicit user action only — the merge-save path no
    // longer calls it (stars persist so the user can generate several merged
    // variants from the same sources). Closing the modal never clears
    // implicitly.
    const { toggleStar, openEditor, closeEditor, clearStars } = useMessageAiEditorStore.getState();
    toggleStar(msg("m-1"), variant("v-a"));
    toggleStar(msg("m-1"), variant("v-b"));
    toggleStar(msg("m-2"), variant("v-c"));
    openEditor({
      requestedMode: "message_merge",
      targetChatId: chat("c-1"),
      targetMessageId: msg("m-1"),
    });

    // Explicit user clear → empties the targeted message's stars only.
    clearStars(msg("m-1"));
    closeEditor();

    expect(starsOf(msg("m-1"))).toBeUndefined();
    expect(starsOf(msg("m-2"))).toEqual([variant("v-c")]);
    expect(useMessageAiEditorStore.getState().target).toBeNull();
  });
});

describe("cross-chat isolation", () => {
  test("stars for messages in different chats never interfere (messageId is globally unique — single-column PK)", () => {
    const { toggleStar, clearStars } = useMessageAiEditorStore.getState();
    const msgChat1 = msg("m-chat-1");
    const msgChat2 = msg("m-chat-2");

    toggleStar(msgChat1, variant("v-a"));
    toggleStar(msgChat2, variant("v-b"));
    clearStars(msgChat1);

    expect(starsOf(msgChat2)).toEqual([variant("v-b")]);
  });

  test("the modal target carries its owning chatId alongside the messageId", () => {
    useMessageAiEditorStore.getState().openEditor({
      requestedMode: "message_edit",
      targetChatId: chat("c-9"),
      targetMessageId: msg("m-1"),
      selectedVariantId: variant("v-1"),
    });

    const target = useMessageAiEditorStore.getState().target;
    expect(target?.targetChatId).toBe(chat("c-9"));
    expect(target?.targetMessageId).toBe(msg("m-1"));
  });
});
