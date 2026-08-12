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
import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { render } = await import("@testing-library/react");

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
