/**
 * Markdown — rendered-output characterization.
 *
 * Pins what the two variants are allowed to emit, so the memoization work in
 * `Markdown` cannot quietly change what a message looks like:
 *
 *   - `variant="chat"` (default) runs the chat-only rehype transforms, so
 *     quoted speech becomes `<span class="quoted-text">` and a bracketed run
 *     becomes `<span class="system-banner">`.
 *   - `variant="plain"` (release notes, docs) must emit neither, while keeping
 *     ordinary GFM — bold, italics, inline code, lists, tables — intact.
 *   - Empty text renders nothing at all, not an empty wrapper.
 *
 * These assertions are written against the pre-memoization component and must
 * hold identically after it, which is the whole point of pinning them.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { fireEvent, render } = await import("@testing-library/react");

// Viewer seam — the SAME mock shape as ImageBlock.test.tsx (IG-CF6) pins:
// FloatingImageViewer replaced by a marker div carrying the opened image's
// src/alt. Identical factory on purpose: mock.module is process-global, so if
// both files ever share a worker the leak is behavior-identical either way.
const realGalleryViewer = await import("../components/build/editors/GalleryViewer.js");
mock.module("../components/build/editors/GalleryViewer.js", () => ({
  ...realGalleryViewer,
  FloatingImageViewer: ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
    <div data-testid="floating-viewer" data-src={src} data-alt={alt} onClick={onClose} />
  ),
}));


let Markdown: typeof import("./markdown.js").Markdown;

beforeAll(async () => {
  ({ Markdown } = await import("./markdown.js"));
});

/** A bracketed run with no colon, so the `p` override does not treat it as scene meta. */
const BANNER_SOURCE = "Before the fight [Combat begins] and after it.";
const QUOTE_SOURCE = `"Your shorts," he said.`;
const GFM_SOURCE = [
  "**bold** and *italic* and `code`",
  "",
  "- first",
  "- second",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
].join("\n");

describe("Markdown — chat variant transforms", () => {
  it("wraps quoted speech in .quoted-text", () => {
    const { container } = render(<Markdown text={QUOTE_SOURCE} />);
    expect(container.querySelector(".quoted-text")).not.toBeNull();
  });

  it("wraps a bracketed run in .system-banner", () => {
    const { container } = render(<Markdown text={BANNER_SOURCE} />);
    expect(container.querySelector(".system-banner")).not.toBeNull();
  });
});

describe("Markdown — plain variant omits chat-only transforms", () => {
  it("leaves quoted speech untouched", () => {
    const { container } = render(<Markdown text={QUOTE_SOURCE} variant="plain" />);
    expect(container.querySelector(".quoted-text")).toBeNull();
    expect(container.textContent).toContain("Your shorts,");
  });

  it("leaves a bracketed run untouched", () => {
    const { container } = render(<Markdown text={BANNER_SOURCE} variant="plain" />);
    expect(container.querySelector(".system-banner")).toBeNull();
    expect(container.textContent).toContain("[Combat begins]");
  });

  it("still renders standard GFM", () => {
    const { container } = render(<Markdown text={GFM_SOURCE} variant="plain" />);
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("em")).not.toBeNull();
    expect(container.querySelector(".md-code-inline")).not.toBeNull();
    expect(container.querySelectorAll(".md-list-item")).toHaveLength(2);
    expect(container.querySelector("table")).not.toBeNull();
  });
});

describe("Markdown — empty input", () => {
  it("renders nothing for an empty string", () => {
    const { container } = render(<Markdown text="" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Markdown — className", () => {
  it("uses the default wrapper class when none is given", () => {
    const { container } = render(<Markdown text="hi" />);
    expect(container.querySelector(".md-content")).not.toBeNull();
  });

  it("uses the supplied wrapper class instead of the default", () => {
    const { container } = render(<Markdown text="hi" className="custom-wrap" />);
    expect(container.querySelector(".custom-wrap")).not.toBeNull();
    expect(container.querySelector(".md-content")).toBeNull();
  });
});

/**
 * Markdown — inline images render through the shared ImageBlock (IG-CF7).
 *
 * Owner decision 2026-09-15: `![alt](url)` must use the SAME media-gallery
 * display pattern as the image-gen slot, reusing the CF6 `ImageBlock`
 * primitive — not the old bare `<img class="md-img">` (no height cap, no
 * viewer). Each inline image is its own single-image ImageBlock with its own
 * viewer state; no caption (no provenance prompt exists for inline images).
 */
describe("Markdown — inline images via ImageBlock", () => {
  it("renders ![alt](url) through ImageBlock, not the bare md-img", () => {
    const { container, getByTestId } = render(<Markdown text="![pic alt](https://example.com/a.png)" />);
    const img = getByTestId("image-block-img");
    expect(img.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img.getAttribute("alt")).toBe("pic alt");
    expect(container.querySelector(".md-img")).toBeNull();
  });

  it("clicking the inline image opens the FloatingImageViewer", () => {
    const view = render(<Markdown text="![pic alt](https://example.com/a.png)" />);
    expect(view.queryByTestId("floating-viewer")).toBeNull();
    fireEvent.click(view.getByTestId("image-block-img"));
    const viewer = view.getByTestId("floating-viewer");
    expect(viewer.getAttribute("data-src")).toBe("https://example.com/a.png");
    expect(viewer.getAttribute("data-alt")).toBe("pic alt");
  });

  it("inline images ride the orientation buckets (MR-7): no fixed-height budget, ratio-true placeholder until load", () => {
    const view = render(<Markdown text="![tall](https://example.com/tall.png)" />);
    const img = view.getByTestId("image-block-img");
    const tile = img.closest("div.flex.shrink-0")!;
    // Same primitive as the image-gen slots: the portrait bucket class +
    // the per-tile ratio custom property (square 1 until decode); the
    // height comes from the img's aspect-ratio, never a fixed budget.
    expect(tile.className).toContain("image-tile-portrait");
    expect(tile.getAttribute("style")).toContain("--tile-ratio: 1");
    expect(img.parentElement!.getAttribute("style")).toBeNull();
    expect(img.getAttribute("style")).toContain("aspect-ratio: 1");
  });

  it("keeps surrounding text around a mid-sentence inline image", () => {
    const view = render(<Markdown text="before ![mid](https://example.com/m.png) after" />);
    expect(view.container.textContent).toContain("before");
    expect(view.container.textContent).toContain("after");
    expect(view.getByTestId("image-block-img").getAttribute("alt")).toBe("mid");
  });
});
