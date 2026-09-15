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
const realGalleryViewer = await import("../build/editors/GalleryViewer.js");

const promoteCalls: Array<[string, string]> = [];
const describeCalls: Array<[string, string, string]> = [];
const includeCalls: Array<[string, string, string, boolean]> = [];
const toastSuccess: string[] = [];
const toastError: string[] = [];
let describeShouldFail: Error | null = null;
let promoteShouldFail: Error | null = null;

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
    includeInPrompt: boolean,
  ) => {
    includeCalls.push([chatId, messageId, attachmentId, includeInPrompt]);
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

// The viewer is the gallery's tested surface; for the tile we pin the SEAM:
// FloatingImageViewer opens with the slot's src. Mocking keeps the tile test
// deterministic (no zoom/pan window machinery).
mock.module("../build/editors/GalleryViewer.js", () => ({
  ...realGalleryViewer,
  FloatingImageViewer: ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
    <div data-testid="floating-viewer" data-src={src} data-alt={alt} onClick={onClose} />
  ),
}));

const { ImageGenSlotTile } = await import("./ImageGenSlotTile.js");
const { AttachmentGrid } = await import("./AttachmentGrid.js");
const { render, fireEvent, waitFor, cleanup } = await import("@testing-library/react");
const { TooltipProvider } = await import("../shared/Tooltip.js");

/** CustomTooltip requires a TooltipProvider ancestor (the app mounts one at
 *  the shell level); isolated tile renders wrap themselves. */
function renderTile(ui: React.ReactElement) {
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

function plainAtt(): Attachment {
  return {
    id: "att-plain",
    assetId: "asset-plain",
    type: "image",
    name: "upload.png",
    mimeType: "image/png",
    sizeBytes: 12,
    description: null,
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
  toastSuccess.length = 0;
  toastError.length = 0;
  describeShouldFail = null;
  promoteShouldFail = null;
});

describe("ImageGenSlotTile — rendering + viewer seam", () => {
  it("renders the thumbnail with the provenance mode label; clicking opens the shared floating viewer", () => {
    const view = renderTile(<ImageGenSlotTile attachment={slotAtt()} messageId="m1" characterId="char1" />);
    expect(view.getByTestId("image-gen-slot-mode").textContent).toBe("image_gen_mode_portrait");
    const img = view.container.querySelector('img[src*="/api/assets/asset-1"]');
    expect(img).toBeTruthy();

    expect(view.queryByTestId("floating-viewer")).toBeNull();
    fireEvent.click(view.getByTestId("image-gen-slot-thumb"));
    const viewer = view.getByTestId("floating-viewer");
    expect(viewer.getAttribute("data-src")).toContain("/api/assets/asset-1");
    fireEvent.click(viewer);
    expect(view.queryByTestId("floating-viewer")).toBeNull();
  });
});

describe("ImageGenSlotTile — gallery promote (slice C)", () => {
  it("calls the promote seam with the slot's assetId + the chat's character, toasts success", async () => {
    const view = renderTile(<ImageGenSlotTile attachment={slotAtt()} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-promote"));
    await waitFor(() => expect(promoteCalls).toEqual([["asset-1", "char1"]]));
    await waitFor(() => expect(toastSuccess).toEqual(["image_gen_slot_promoted"]));
  });

  it("failure toasts the server's normalized message", async () => {
    promoteShouldFail = new Error("No gallery quota");
    const view = renderTile(<ImageGenSlotTile attachment={slotAtt()} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-promote"));
    await waitFor(() => expect(toastError).toEqual(["No gallery quota"]));
  });
});

describe("ImageGenSlotTile — include-in-prompt toggle (slice D)", () => {
  it("defaults OFF (aria-pressed false); with a description present, enabling flips the flag without describing", async () => {
    const att = slotAtt({ description: "Existing description." });
    seedMessage("m1", [att]);
    const view = renderTile(<ImageGenSlotTile attachment={att} messageId="m1" characterId="char1" />);
    const btn = view.getByTestId("image-gen-slot-include");
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(btn);
    await waitFor(() => expect(includeCalls).toEqual([["_", "m1", "att-1", true]]));
    expect(describeCalls.length).toBe(0);
    const stored = useSnapshotStore.getState().messagesById["m1"];
    flushSync(() => {});
    expect(stored?.attachments?.[0]?.includeInPrompt).toBe(true);
  });

  it("enabling without a description runs vision-describe first, persists the description, then flips", async () => {
    const att = slotAtt();
    seedMessage("m1", [att]);
    const view = renderTile(<ImageGenSlotTile attachment={att} messageId="m1" characterId="char1" />);
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
    const view = renderTile(<ImageGenSlotTile attachment={att} messageId="m1" characterId="char1" />);
    fireEvent.click(view.getByTestId("image-gen-slot-include"));

    await waitFor(() => expect(toastError).toEqual(["No vision model configured"]));
    expect(includeCalls.length).toBe(0);
    const stored = useSnapshotStore.getState().messagesById["m1"];
    expect(stored?.attachments?.[0]?.includeInPrompt).toBeUndefined();
  });

  it("disabling flips the flag off without describing", async () => {
    const att = slotAtt({ description: "d", includeInPrompt: true });
    seedMessage("m1", [att]);
    const view = renderTile(<ImageGenSlotTile attachment={att} messageId="m1" characterId="char1" />);
    expect(view.getByTestId("image-gen-slot-include").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByTestId("image-gen-slot-include"));
    await waitFor(() => expect(includeCalls).toEqual([["_", "m1", "att-1", false]]));
    expect(describeCalls.length).toBe(0);
  });
});

describe("AttachmentGrid — slot routing parity", () => {
  it("imageGen attachments render the slot tile; ordinary images keep the lightbox", () => {
    seedMessage("m1", [slotAtt(), plainAtt()]);
    const view = renderTile(<AttachmentGrid attachments={[slotAtt(), plainAtt()]} messageId="m1" characterId="char1" />);
    expect(view.container.querySelectorAll('[data-testid="image-gen-slot"]').length).toBe(1);

    // The ordinary upload still opens the plain lightbox, not the slot viewer.
    const plainImg = view.container.querySelector('img[src*="asset-plain"]');
    expect(plainImg).toBeTruthy();
    const plainButton = plainImg!.closest("button");
    expect(plainButton).toBeTruthy();
    fireEvent.click(plainButton!);
    expect(view.queryByTestId("floating-viewer")).toBeNull();
    // The lightbox full view (the AttachmentGrid's own viewer) appears for
    // the plain upload — keyed by its name in the full-view alt slot.
    expect(view.baseElement.querySelector('img[alt="upload.png"]')).toBeTruthy();
  });
});
