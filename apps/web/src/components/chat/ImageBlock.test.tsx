/**
 * ImageBlock (IG-CF6, IMAGE_GENERATION_PLAN): the shared justified image row.
 * Pins the gallery-pattern budget the plan locks: fixed image height from the
 * gallery's OWN constants (imported, never re-declared), tile width derived
 * from the image's aspect ratio, panorama cap, object-cover + cursor-zoom-in,
 * click → the shared FloatingImageViewer, and the prompt accordion (MR-8:
 * collapsed row = label + chevron, no text; click opens the full pre-wrap
 * text). Also pins AttachmentGrid's slot routing
 * parity: imageGen attachments render the ImageBlock; ordinary uploads keep
 * the plain lightbox.
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

const realGalleryViewer = await import("../build/editors/GalleryViewer.js");
// The viewer is the gallery's tested surface; here we pin the SEAM — the
// block opens FloatingImageViewer with the clicked image's src/alt. Mocking
// keeps the test deterministic (no zoom/pan window machinery).
mock.module("../build/editors/GalleryViewer.js", () => ({
  ...realGalleryViewer,
  FloatingImageViewer: ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
    <div data-testid="floating-viewer" data-src={src} data-alt={alt} onClick={onClose} />
  ),
}));

const realChatApi = await import("../../api/chat-api.js");
// MR-9 wiring seam: AttachmentGrid's prompt SAVER persists through the
// prompt-write API client — here we pin the call (the ...real spread keeps
// every other export live for co-located files in this worker).
const promptSaveCalls: Array<{ messageId: string; attachmentId: string; prompt: string }> = [];
mock.module("../../api/chat-api.js", () => ({
  ...realChatApi,
  updateAttachmentPrompt: async (_chatId: string, messageId: string, attachmentId: string, prompt: string) => {
    promptSaveCalls.push({ messageId, attachmentId, prompt });
    return { ok: true };
  },
}));

const { ImageBlock } = await import("./ImageBlock.js");
const { AttachmentGrid } = await import("./AttachmentGrid.js");
const { fireEvent, render, cleanup } = await import("@testing-library/react");

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
    imageGen: { mode: "portrait", profileId: "p1", params: {}, prompt: "A painted portrait of the tavern keeper." },
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

/** Simulate the browser decoding a bitmap: stamp natural dimensions and fire
 *  load — the block adopts the real aspect ratio (the onLoad path). */
function loadWithSize(container: HTMLElement, width: number, height: number) {
  const img = container.querySelector('[data-testid="image-block-img"]');
  if (!(img instanceof HTMLImageElement)) throw new Error("image-block-img missing");
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(img);
  return img;
}

afterEach(() => {
  cleanup();
});

describe("ImageBlock — orientation-driven message sizing (MR-7)", () => {
  it("landscape gets the full-width bucket class; the img is ratio-true (CSS aspect-ratio, no fixed height)", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/landscape", alt: "gen" }]} />);
    loadWithSize(view.container, 1344, 768); // 16:9 = 1.75 exact
    const tile = view.getByTestId("image-block-img").closest("div.flex.shrink-0")!;
    // The width formula (min(bucket, 70vh × ratio)) lives in the stylesheet
    // bucket class — nested min() is authored CSS, not an inline style
    // (inline min() is unparseable for DOM consumers like happy-dom).
    expect(tile.className).toContain("image-tile-landscape");
    expect(tile.getAttribute("style")).toContain("--tile-ratio: 1.75");
    const img = view.getByTestId("image-block-img");
    expect(img.getAttribute("style")).toContain("aspect-ratio");
    // No fixed-height budget anywhere — the ratio drives the height.
    const area = img.parentElement!;
    expect(area.getAttribute("style")).toBeNull();
    expect(img.className).toContain("object-cover");
    expect(img.className).toContain("cursor-zoom-in");
  });

  it("portrait gets the half-width bucket class (two tiles share a row through the flex gap)", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/portrait", alt: "gen" }]} />);
    loadWithSize(view.container, 1024, 1280); // 4:5 = 0.8 exact
    const tile = view.getByTestId("image-block-img").closest("div.flex.shrink-0")!;
    expect(tile.className).toContain("image-tile-portrait");
    expect(tile.getAttribute("style")).toContain("--tile-ratio: 0.8");
  });

  it("square follows the portrait bucket (owner-confirmed MR-7 spec)", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/square", alt: "gen" }]} />);
    loadWithSize(view.container, 1024, 1024); // ratio 1 exact
    const tile = view.getByTestId("image-block-img").closest("div.flex.shrink-0")!;
    expect(tile.className).toContain("image-tile-portrait");
    expect(tile.className).not.toContain("image-tile-landscape");
    expect(tile.getAttribute("style")).toContain("--tile-ratio: 1");
  });

  it("an ultra-tall image keeps the portrait bucket — the 70vh cap binds inside the class (width shrinks, never crops)", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/tall", alt: "gen" }]} />);
    loadWithSize(view.container, 490, 2450); // 1:5 = 0.2 exact — the cap arm wins
    const tile = view.getByTestId("image-block-img").closest("div.flex.shrink-0")!;
    expect(tile.className).toContain("image-tile-portrait");
    expect(tile.getAttribute("style")).toContain("--tile-ratio: 0.2");
  });

  it("unknown ratio reserves the portrait bucket with a square footprint (ratio 1) until load", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/unknown-ratio", alt: "gen" }]} />);
    const tile = view.getByTestId("image-block-img").closest("div.flex.shrink-0")!;
    expect(tile.className).toContain("image-tile-portrait");
    expect(tile.getAttribute("style")).toContain("--tile-ratio: 1");
    expect(view.getByTestId("image-block-img").getAttribute("style")).toContain("aspect-ratio: 1");
  });
});

describe("ImageBlock — viewer seam", () => {
  it("click opens the shared FloatingImageViewer with the image's src/alt; close dismisses", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/a1", alt: "Generated image" }]} />);
    expect(view.queryByTestId("floating-viewer")).toBeNull();
    fireEvent.click(view.getByTestId("image-block-img"));
    const viewer = view.getByTestId("floating-viewer");
    expect(viewer.getAttribute("data-src")).toBe("/api/assets/a1");
    expect(viewer.getAttribute("data-alt")).toBe("Generated image");
    fireEvent.click(viewer);
    expect(view.queryByTestId("floating-viewer")).toBeNull();
  });
});

describe("ImageBlock — prompt accordion (MR-8)", () => {
  it("collapsed: the row shows the Prompt label + chevron ONLY — no prompt text at rest", () => {
    const prompt = "First line of the assembled prompt\nand a second line that would never fit one line";
    const view = render(<ImageBlock images={[{ src: "/api/assets/a1", alt: "gen", caption: prompt }]} />);
    const caption = view.getByTestId("image-block-caption");
    expect(caption.getAttribute("aria-expanded")).toBe("false");
    // The label row (useT is mocked identity → the key IS the label here).
    expect(caption.textContent).toContain("image_block_prompt_row");
    // The wall is gone: NO prompt text renders anywhere at rest.
    expect(caption.textContent).not.toContain("First line of the assembled prompt");
    expect(view.container.textContent).not.toContain("First line of the assembled prompt");
    expect(view.queryByTestId("image-block-caption-text")).toBeNull();
  });

  it("click opens the full text (pre-wrap, nothing truncated); click again collapses and unmounts it", async () => {
    const prompt = "First line of the assembled prompt\nand a second line that would never fit one line";
    const view = render(<ImageBlock images={[{ src: "/api/assets/a2", alt: "gen", caption: prompt }]} />);
    const caption = view.getByTestId("image-block-caption");

    fireEvent.click(caption);
    expect(caption.getAttribute("aria-expanded")).toBe("true");
    const text = view.getByTestId("image-block-caption-text");
    expect(text.className).toContain("whitespace-pre-wrap");
    // The FULL text is reachable — newlines render, nothing truncated.
    expect(text.textContent).toBe(prompt);

    fireEvent.click(caption);
    expect(caption.getAttribute("aria-expanded")).toBe("false");
    // Collapsed again — the exit animation (AnimatePresence) runs first; the
    // resolved state (text unmounted) is what we pin (RTL waitFor idiom).
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(view.queryByTestId("image-block-caption-text")).toBeNull());
  });

  it("no caption node without a caption (legacy slots carry no prompt)", () => {
    const view = render(<ImageBlock images={[{ src: "/api/assets/a1", alt: "gen" }]} />);
    expect(view.queryByTestId("image-block-caption")).toBeNull();
  });
});

describe("AttachmentGrid — slot routing parity", () => {
  it("imageGen attachments render the ImageBlock row; ordinary images keep the plain lightbox", () => {
    const view = render(<AttachmentGrid attachments={[slotAtt(), plainAtt()]} messageId="m1" />);
    // One justified image: the slot's; its prompt sits behind the MR-8
    // accordion — one click reveals it.
    expect(view.container.querySelectorAll('[data-testid="image-block-img"]').length).toBe(1);
    const captionRow = view.getByTestId("image-block-caption");
    fireEvent.click(captionRow);
    expect(view.getByTestId("image-block-caption-text").textContent).toContain("A painted portrait");

    // The ordinary upload still opens the plain lightbox, not the floating viewer.
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

  it("multiple imageGen attachments share ONE justified row (the gallery mechanism)", () => {
    const view = render(
      <AttachmentGrid
        attachments={[slotAtt(), slotAtt({ id: "att-2", assetId: "asset-2", imageGen: { mode: "portrait", profileId: "p1", params: {} } })]}
        messageId="m1"
      />,
    );
    expect(view.container.querySelectorAll('[data-testid="image-block"]').length).toBe(1);
    expect(view.container.querySelectorAll('[data-testid="image-block-img"]').length).toBe(2);
  });

  it("MR-9 wiring: saving through the accordion calls the prompt-write API with the slot's ids", async () => {
    promptSaveCalls.length = 0;
    const view = render(<AttachmentGrid attachments={[slotAtt()]} messageId="m1" />);
    fireEvent.click(view.getByTestId("image-block-caption"));
    fireEvent.click(view.getByTestId("image-block-prompt-edit"));
    const textarea = view.getByTestId("image-block-prompt-editor").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "rewritten via the grid" } });
    fireEvent.click(view.getByTestId("image-block-prompt-save"));
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(promptSaveCalls).toHaveLength(1));
    expect(promptSaveCalls[0]).toEqual({ messageId: "m1", attachmentId: "att-1", prompt: "rewritten via the grid" });
  });
});

describe("ImageBlock — prompt editing (MR-9)", () => {
  it("the edit action renders only when a saver is wired — read-only surfaces keep the plain accordion", () => {
    const readonly = render(<ImageBlock images={[{ src: "/api/assets/ro1", alt: "inline", caption: "markdown prompt" }]} />);
    fireEvent.click(readonly.getByTestId("image-block-caption"));
    expect(readonly.getByTestId("image-block-caption-text").textContent).toContain("markdown prompt");
    expect(readonly.queryByTestId("image-block-prompt-edit")).toBeNull();
    // RTL queries bind to document.body — unmount before the second render so
    // the testids stay unique (one block live at a time).
    readonly.unmount();

    const editable = render(<ImageBlock images={[{ src: "/api/assets/ed1", alt: "gen", caption: "old", onEditPrompt: async () => true }]} />);
    fireEvent.click(editable.getByTestId("image-block-caption"));
    expect(editable.getByTestId("image-block-prompt-edit")).toBeTruthy();
  });

  it("edit opens the prefilled editor; Save persists via the saver and exits to view mode on success", async () => {
    const savedCalls: string[] = [];
    const view = render(
      <ImageBlock images={[{ src: "/api/assets/ed2", alt: "gen", caption: "old text", onEditPrompt: async (next) => { savedCalls.push(next); return true; } }]} />,
    );
    fireEvent.click(view.getByTestId("image-block-caption"));
    fireEvent.click(view.getByTestId("image-block-prompt-edit"));
    const editor = view.getByTestId("image-block-prompt-editor");
    const editorTextarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(editorTextarea.value).toBe("old text");

    fireEvent.change(editorTextarea, { target: { value: "new text" } });
    fireEvent.click(view.getByTestId("image-block-prompt-save"));
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(view.queryByTestId("image-block-prompt-editor")).toBeNull());
    expect(savedCalls).toEqual(["new text"]);
    // Back to the view branch (the caption prop — the parent swaps it for the
    // persisted text on its re-render).
    expect(view.getByTestId("image-block-caption-text").textContent).toBe("old text");
  });

  it("failed save (saver resolves false) keeps the editor open with the draft", async () => {
    const view = render(
      <ImageBlock images={[{ src: "/api/assets/ed3", alt: "gen", caption: "old", onEditPrompt: async () => false }]} />,
    );
    fireEvent.click(view.getByTestId("image-block-caption"));
    fireEvent.click(view.getByTestId("image-block-prompt-edit"));
    const textarea = view.getByTestId("image-block-prompt-editor").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "doomed edit" } });
    fireEvent.click(view.getByTestId("image-block-prompt-save"));
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(textarea.value).toBe("doomed edit"));
    // Still editing — the failure keeps the draft for a retry.
    expect(view.getByTestId("image-block-prompt-editor")).toBeTruthy();
  });

  it("Cancel discards the draft — the saver is never called", () => {
    let called = false;
    const view = render(
      <ImageBlock images={[{ src: "/api/assets/ed4", alt: "gen", caption: "old", onEditPrompt: async () => { called = true; return true; } }]} />,
    );
    fireEvent.click(view.getByTestId("image-block-caption"));
    fireEvent.click(view.getByTestId("image-block-prompt-edit"));
    const textarea = view.getByTestId("image-block-prompt-editor").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "discarded" } });
    fireEvent.click(view.getByTestId("image-block-prompt-cancel"));
    expect(view.queryByTestId("image-block-prompt-editor")).toBeNull();
    expect(called).toBe(false);
    expect(view.getByTestId("image-block-caption-text").textContent).toBe("old");
  });

  it("Save stays disabled while the draft is empty (the server rejects empty prompts)", () => {
    const view = render(
      <ImageBlock images={[{ src: "/api/assets/ed5", alt: "gen", caption: "old", onEditPrompt: async () => true }]} />,
    );
    fireEvent.click(view.getByTestId("image-block-caption"));
    fireEvent.click(view.getByTestId("image-block-prompt-edit"));
    const textarea = view.getByTestId("image-block-prompt-editor").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(view.getByTestId("image-block-prompt-save").getAttribute("disabled")).toBe("");
    fireEvent.change(textarea, { target: { value: "filled" } });
    expect(view.getByTestId("image-block-prompt-save").getAttribute("disabled")).toBeNull();
  });
});
