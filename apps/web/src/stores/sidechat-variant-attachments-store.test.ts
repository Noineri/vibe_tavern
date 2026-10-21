/**
 * SC-18 — the sidechat's pending RP-variant attachments store.
 *
 * Pins the chat+branch keying (never per thread), exact-duplicate dedupe,
 * per-chip removal and the full clear. Pure zustand, no DOM.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  readPendingVariantAttachments,
  useSidechatVariantAttachmentsStore,
  variantAttachmentsKey,
  type PendingVariantAttachment,
} from "./sidechat-variant-attachments-store.js";

function chip(messageId: string, variantId: string, variantNumber: number, selected = false): PendingVariantAttachment {
  return { messageId, variantId, variantNumber, selected };
}

beforeEach(() => {
  useSidechatVariantAttachmentsStore.setState({ pendingByChatBranch: {} });
});

describe("sidechat-variant-attachments-store (SC-18)", () => {
  test("the key spells chat + branch (never the thread)", () => {
    expect(variantAttachmentsKey("chat-1", "b1")).toBe("chat-1\nb1");
    expect(variantAttachmentsKey("chat-1", "b1")).not.toBe(variantAttachmentsKey("chat-1", "b2"));
    expect(variantAttachmentsKey("chat-1", "b1")).not.toBe(variantAttachmentsKey("chat-2", "b1"));
  });

  test("attach parks chips readable outside React (buildSendOptions)", () => {
    useSidechatVariantAttachmentsStore.getState().attachVariants("chat-1", "b1", [
      chip("m1", "v1", 1, false),
      chip("m1", "v2", 2, true),
    ]);
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([
      chip("m1", "v1", 1, false),
      chip("m1", "v2", 2, true),
    ]);
  });

  test("pending lists are isolated by chat and by branch", () => {
    const state = useSidechatVariantAttachmentsStore.getState();
    state.attachVariants("chat-1", "b1", [chip("m1", "v1", 1)]);
    state.attachVariants("chat-1", "b2", [chip("m2", "v2", 1)]);
    state.attachVariants("chat-2", "b1", [chip("m3", "v3", 1)]);
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([chip("m1", "v1", 1)]);
    expect(readPendingVariantAttachments("chat-1", "b2")).toEqual([chip("m2", "v2", 1)]);
    expect(readPendingVariantAttachments("chat-2", "b1")).toEqual([chip("m3", "v3", 1)]);
    expect(readPendingVariantAttachments("chat-9", "b9")).toEqual([]);
  });

  test("exact-duplicate pairs are skipped, order preserved", () => {
    const state = useSidechatVariantAttachmentsStore.getState();
    state.attachVariants("chat-1", "b1", [chip("m1", "v1", 1), chip("m1", "v2", 2, true)]);
    state.attachVariants("chat-1", "b1", [chip("m1", "v2", 2, true), chip("m1", "v3", 3)]);
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([
      chip("m1", "v1", 1),
      chip("m1", "v2", 2, true),
      chip("m1", "v3", 3),
    ]);
  });

  test("an empty attach is a no-op (no key created)", () => {
    useSidechatVariantAttachmentsStore.getState().attachVariants("chat-1", "b1", []);
    expect(useSidechatVariantAttachmentsStore.getState().pendingByChatBranch).toEqual({});
  });

  test("remove drops one chip (the per-chip ×) and prunes the emptied key", () => {
    const state = useSidechatVariantAttachmentsStore.getState();
    state.attachVariants("chat-1", "b1", [chip("m1", "v1", 1), chip("m1", "v2", 2, true)]);
    state.removeVariantAttachment("chat-1", "b1", "m1", "v1");
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([chip("m1", "v2", 2, true)]);
    state.removeVariantAttachment("chat-1", "b1", "m1", "v2");
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([]);
    expect(useSidechatVariantAttachmentsStore.getState().pendingByChatBranch).toEqual({});
  });

  test("remove of a missing pair is a no-op", () => {
    const state = useSidechatVariantAttachmentsStore.getState();
    state.attachVariants("chat-1", "b1", [chip("m1", "v1", 1)]);
    state.removeVariantAttachment("chat-1", "b1", "m1", "nope");
    state.removeVariantAttachment("chat-9", "b9", "m1", "v1");
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([chip("m1", "v1", 1)]);
  });

  test("clear drops the whole list (a successful send), other keys survive", () => {
    const state = useSidechatVariantAttachmentsStore.getState();
    state.attachVariants("chat-1", "b1", [chip("m1", "v1", 1)]);
    state.attachVariants("chat-1", "b2", [chip("m2", "v2", 1)]);
    state.clearVariantAttachments("chat-1", "b1");
    expect(readPendingVariantAttachments("chat-1", "b1")).toEqual([]);
    expect(readPendingVariantAttachments("chat-1", "b2")).toEqual([chip("m2", "v2", 1)]);
  });
});
