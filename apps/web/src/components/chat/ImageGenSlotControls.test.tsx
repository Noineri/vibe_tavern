/**
 * ImageGenSlotControls (IG-CF6, IMAGE_GENERATION_PLAN): the slot's action-row
 * controls — the IG-18/IG-18a tile's logic relocated (the tile became the
 * shared ImageBlock; the controls replaced the text action row). Boundary
 * pins carried over verbatim from ImageGenSlotTile.test.tsx: regenerate
 * payload at the store seam, promote at the API seam (success + normalized
 * failure), the include-in-prompt ladder (describe-first for prompt-less
 * slots; a CF6-stamped prompt satisfies the gate with zero AI calls, IG-CF9
 * flip with rollback), and the desktop/mobile shape split.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// ── Mock seams (tier T1, `...real` spread — the leak-safe pattern) ──────────

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const realImageGenApi = await import("../../api/image-gen-api.js");
const realChatApi = await import("../../api/chat-api.js");
const realSonner = await import("sonner");

const promoteCalls: Array<[string, string]> = [];
const describeCalls: Array<[string, string, string]> = [];
const includeCalls: Array<[string, string, string, boolean]> = [];
const runGenerationCalls: Array<[string, { profileId: string; mode: string; anchorMessageId?: string; targetMessageId?: string }]> = [];
const toastSuccess: string[] = [];
const toastError: string[] = [];
let describeShouldFail: Error | null = null;
let promoteShouldFail: Error | null = null;

const realChatStore = await import("../../stores/image-gen-chat-store.js");
// Spy the REAL store's runGeneration (the component reads runningByChat via
// the selector and fires runGeneration via getState — both hit this store).
realChatStore.useImageGenChatStore.setState({
  runGeneration: (chatId: string, input: { profileId: string; mode: string; anchorMessageId?: string; targetMessageId?: string }) => {
    runGenerationCalls.push([chatId, input]);
    return Promise.resolve();
  },
});
mock.module("../../stores/image-gen-chat-store.js", () => ({
  ...realChatStore,
}));

mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  promoteImageGenAttachmentToGallery: (assetId: string, characterId: string) => {
    if (promoteShouldFail) return Promise.reject(promoteShouldFail);
    promoteCalls.push([assetId, characterId]);
    return Promise.resolve({ assetRowId: "row1", characterId, ext: "png", mimeType: "image/png", order: 0 });
  },
}));

mock.module("../../api/chat-api.js", () => ({
  ...realChatApi,
  regenerateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string) => {
    describeCalls.push([chatId, messageId, attachmentId]);
    if (describeShouldFail) return Promise.reject(describeShouldFail);
    return Promise.resolve({ description: "A painted portrait." });
  },
  updateAttachmentIncludeInPrompt: (
    chatId: string,
    messageId: string,
    attachmentId: string,
    includePrompt: boolean,
  ) => {
    includeCalls.push([chatId, messageId, attachmentId, includePrompt]);
    return Promise.resolve({ ok: true });
  },
}));

mock.module("sonner", () => ({
  ...realSonner,
  toast: {
    success: (m: string) => {
      toastSuccess.push(m);
    },
    error: (m: string) => {
      toastError.push(m);
    },
  },
}));

const { ImageGenSlotControls } = await import("./ImageGenSlotControls.js");
const { render, fireEvent, waitFor, cleanup } = await import("@testing-library/react");
const { TooltipProvider } = await import("../shared/Tooltip.js");

/** CustomTooltip requires a TooltipProvider ancestor (the app mounts one at
 *  the shell level); isolated renders wrap themselves. */
function renderControls(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom }));
const { flushSync } = await import("react-dom");

import type { Attachment } from "@vibe-tavern/domain";

function slotAtt(overrides?: Partial<Attachment>): Attachment {
  return {
    id: "att-1",
    assetId: "asset-1",
    type: "image",
    name: "imagegen-asset-1",
    mimeType: "image/png",
    sizeBytes: 12,
    description: null,
    imageGen: { mode: "portrait", profileId: "p1", params: {} },
    ...overrides,
  };
}

/** Minimal seeded message for the optimistic-update seam. */
type SeededMessage = { id: string; attachments: Array<Attachment> };
function seedMessage(id: string, attachments: Array<Attachment>) {
  useSnapshotStore.setState({
    messagesById: {
      ...useSnapshotStore.getState().messagesById,
      [id]: { id, attachments } as SeededMessage as never,
    },
  });
}

afterEach(() => {
  cleanup();
  useSnapshotStore.setState({ messagesById: {} });
  promoteCalls.length = 0;
  describeCalls.length = 0;
  includeCalls.length = 0;
  runGenerationCalls.length = 0;
  toastSuccess.length = 0;
  toastError.length = 0;
  describeShouldFail = null;
  promoteShouldFail = null;
  realChatStore.useImageGenChatStore.setState({ runningByChat: {} });
});

describe("ImageGenSlotControls — regenerate-as-variant (IG-18a)", () => {
  it("fires runGeneration with the slot's provenance + targetMessageId (variant target = the slot itself)", async () => {
    const view = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" chatId="chat-1" />);
    const btn = await view.findByTestId("image-gen-slot-regenerate");
    fireEvent.click(btn);
    expect(runGenerationCalls).toEqual([
      ["chat-1", { profileId: "p1", mode: "portrait", anchorMessageId: "m1", targetMessageId: "m1" }],
    ]);
  });

  it("without a chatId the button is not rendered (tests mount row-less)", async () => {
    const view = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" />);
    await view.findByTestId("image-gen-slot-mode");
    expect(view.queryByTestId("image-gen-slot-regenerate")).toBeNull();
  });

  it("disabled while a generation is in-flight (one-per-chat guard)", async () => {
    realChatStore.useImageGenChatStore.setState({
      runningByChat: { "chat-1": { mode: "portrait", anchorMessageId: "m1", profileId: "p1", liveProgress: false } },
    });
    const view = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" chatId="chat-1" />);
    const btn = await view.findByTestId("image-gen-slot-regenerate");
    expect(btn.hasAttribute("disabled")).toBe(true);
    fireEvent.click(btn);
    expect(runGenerationCalls).toHaveLength(0);
  });
});

describe("ImageGenSlotControls — gallery promote (IG-18 slice C)", () => {
  it("calls the promote seam with the slot's assetId + the chat's character, toasts success", async () => {
    const view = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-promote"));
    await waitFor(() => expect(promoteCalls).toEqual([["asset-1", "char1"]]));
    await waitFor(() => expect(toastSuccess).toEqual(["image_gen_slot_promoted"]));
  });

  it("failure toasts the server's normalized message", async () => {
    promoteShouldFail = new Error("No gallery quota");
    const view = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-promote"));
    await waitFor(() => expect(toastError).toEqual(["No gallery quota"]));
  });

  it("without a character the promote button is hidden", () => {
    const view = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" />);
    expect(view.queryByTestId("image-gen-slot-promote")).toBeNull();
  });
});

describe("ImageGenSlotControls — include-in-prompt toggle (IG-18 slice D)", () => {
  it("defaults OFF (aria-pressed false); with a description present, enabling flips the flag without describing", async () => {
    const att = slotAtt({ description: "Existing description." });
    seedMessage("m1", [att]);
    const view = renderControls(<ImageGenSlotControls attachments={[att]} messageId="m1" characterId="char1" />);
    const btn = view.getByTestId("image-gen-slot-include");
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(btn);
    await waitFor(() => expect(includeCalls).toEqual([["_", "m1", "att-1", true]]));
    expect(describeCalls.length).toBe(0);
    const stored = useSnapshotStore.getState().messagesById["m1"];
    flushSync(() => {});
    expect(stored?.attachments?.[0]?.includeInPrompt).toBe(true);
  });

  it("prompt-stamped slot (IG-CF9): enabling skips vision-describe entirely — zero AI calls, straight include", async () => {
    const att = slotAtt({ imageGen: { mode: "portrait", profileId: "p1", params: {}, prompt: "a painted knight portrait, oil on canvas" } });
    seedMessage("m1", [att]);
    const view = renderControls(<ImageGenSlotControls attachments={[att]} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-include"));

    await waitFor(() => expect(includeCalls).toEqual([["_", "m1", "att-1", true]]));
    expect(describeCalls.length).toBe(0);
    const stored = useSnapshotStore.getState().messagesById["m1"];
    flushSync(() => {});
    expect(stored?.attachments?.[0]?.includeInPrompt).toBe(true);
    // The stamped prompt is NOT written into the description client-side —
    // the assembly-time fallback (withImageGenPromptFallback) owns that.
    expect(stored?.attachments?.[0]?.description).toBeNull();
  });

  it("enabling without a description runs vision-describe first, persists the description, then flips", async () => {
    const att = slotAtt();
    seedMessage("m1", [att]);
    const view = renderControls(<ImageGenSlotControls attachments={[att]} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-include"));

    await waitFor(() => expect(describeCalls).toEqual([["_", "m1", "att-1"]]));
    await waitFor(() => expect(includeCalls).toEqual([["_", "m1", "att-1", true]]));
    const stored = useSnapshotStore.getState().messagesById["m1"];
    expect(stored?.attachments?.[0]?.description).toBe("A painted portrait.");
    expect(stored?.attachments?.[0]?.includeInPrompt).toBe(true);
  });

  it("describe failure keeps the flag off and toasts the error", async () => {
    describeShouldFail = new Error("No vision model configured");
    const att = slotAtt();
    seedMessage("m1", [att]);
    const view = renderControls(<ImageGenSlotControls attachments={[att]} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-include"));

    await waitFor(() => expect(toastError).toEqual(["No vision model configured"]));
    expect(includeCalls.length).toBe(0);
    const stored = useSnapshotStore.getState().messagesById["m1"];
    expect(stored?.attachments?.[0]?.includeInPrompt).toBeUndefined();
  });

  it("disabling flips the flag off without describing", async () => {
    const att = slotAtt({ description: "d", includeInPrompt: true });
    seedMessage("m1", [att]);
    const view = renderControls(<ImageGenSlotControls attachments={[att]} messageId="m1" characterId="char1" />);
    expect(view.getByTestId("image-gen-slot-include").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByTestId("image-gen-slot-include"));
    await waitFor(() => expect(includeCalls).toEqual([["_", "m1", "att-1", false]]));
    expect(describeCalls.length).toBe(0);
  });
});

describe("ImageGenSlotControls — desktop/mobile shape (IG-CF6)", () => {
  it("desktop renders the provenance mode label; mobile omits it (row-width budget, AD-022)", async () => {
    // NOTE: two live renders in one test — this RTL setup binds the returned
    // queries to document.body (NOT the per-render container), so negatives
    // and positives here query through `container` explicitly.
    const desktop = renderControls(<ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" chatId="chat-1" />);
    expect(desktop.container.querySelector('[data-testid="image-gen-slot-mode"]')?.textContent).toBe("image_gen_mode_portrait");

    const mobile = renderControls(
      <ImageGenSlotControls attachments={[slotAtt()]} messageId="m1" chatId="chat-1" mobile />,
    );
    expect(mobile.container.querySelector('[data-testid="image-gen-slot-mode"]')).toBeNull();
    // 44px touch targets in the mobile action row (compact h-6 on desktop).
    expect(mobile.container.querySelector('[data-testid="image-gen-slot-regenerate"]')?.className).toContain("h-11");
    expect(desktop.container.querySelector('[data-testid="image-gen-slot-regenerate"]')?.className).toContain("h-6");
  });
});
