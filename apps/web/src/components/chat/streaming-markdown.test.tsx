import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { GenerationDots } from "./variants/generation-dots.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

useDomEnv();
const { render } = await import("@testing-library/react");

describe("StreamingMarkdown", () => {
  test("renders the generation indicator in its lower row before the first token arrives", () => {
    // Given: an active stream that has not revealed text yet.
    const indicator = <GenerationDots label="Generating response" />;

    // When: the renderer receives the pending stream state.
    const { container } = render(<StreamingMarkdown text="" indicator={indicator} />);

    // Then: the user still receives generation feedback in the reserved lower row.
    const indicatorRow = container.querySelector(".streaming-generation-indicator");
    expect(indicatorRow).not.toBeNull();
    expect(indicatorRow?.querySelector("[aria-label]")).not.toBeNull();
  });

  test.each([
    ["a heading", "# A final heading", "h1"],
    ["a list item", "- A final item", "li"],
    ["a quote", "> A final quote", "blockquote"],
    ["a paragraph with a trailing newline", "The final paragraph.\n", "p"],
  ])("keeps the lower indicator separate after %s", (_name, text, finalElement) => {
    const { container } = render(
      <StreamingMarkdown
        text={text}
        indicator={<GenerationDots label="Generating response" />}
      />,
    );

    const markdown = container.querySelector(".md-content");
    const indicatorRow = container.querySelector(".streaming-generation-indicator");
    const indicator = container.querySelector("[aria-label]");

    expect(markdown).not.toBeNull();
    expect(markdown?.querySelector(finalElement)).not.toBeNull();
    expect(markdown?.parentElement?.contains(indicatorRow)).toBe(true);
    expect(markdown?.parentElement?.lastElementChild).toBe(indicatorRow);
    expect(indicator).not.toBeNull();
    expect(markdown?.contains(indicator)).toBe(false);
    expect(indicatorRow?.contains(indicator)).toBe(true);
  });
});
