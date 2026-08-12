import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { GenerationDots } from "./variants/generation-dots.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

useDomEnv();
const { render } = await import("@testing-library/react");

describe("StreamingMarkdown", () => {
  test("renders the generation indicator before the first token arrives", () => {
    // Given: an active stream that has not revealed text yet.
    const trailing = <GenerationDots label="Generating response" />;

    // When: the renderer receives the pending stream state.
    const { container } = render(<StreamingMarkdown text="" trailing={trailing} />);

    // Then: the user still receives generation feedback.
    expect(container.querySelector("[aria-label]")).not.toBeNull();
  });

  test("keeps the generation indicator inside the final text paragraph", () => {
    // Given: streamed Markdown with more than one paragraph.
    const text = "The first paragraph is already complete.\n\nThe final paragraph is still streaming.";

    // When: the renderer receives a trailing generation indicator.
    const { container } = render(
      <StreamingMarkdown
        text={text}
        trailing={<GenerationDots label="Generating response" />}
      />,
    );

    // Then: the indicator belongs to the final inline formatting context.
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.querySelector("[aria-label]")).toBeNull();
    expect(paragraphs[1]?.querySelector("[aria-label]")).not.toBeNull();
  });

  test.each([
    ["a heading", "# A final heading", "h1"],
    ["a list item", "- A final item", "li"],
    ["a quote", "> A final quote", "blockquote"],
    ["a paragraph with a trailing newline", "The final paragraph.\n", "p"],
  ])("keeps the generation indicator visible after %s", (_name, text, finalElement) => {
    const { container } = render(
      <StreamingMarkdown
        text={text}
        trailing={<GenerationDots label="Generating response" />}
      />,
    );

    const indicator = container.querySelector("[aria-label]");
    expect(indicator).not.toBeNull();
    expect(indicator?.closest(finalElement)).not.toBeNull();
  });
});
