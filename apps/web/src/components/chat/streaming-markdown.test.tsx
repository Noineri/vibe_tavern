import { describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { FollowBottomContext } from "./follow-bottom-context.js";
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

describe("StreamingMarkdown — following the bottom", () => {
  function streamed(text: string, followBottom: () => void) {
    return (
      <FollowBottomContext.Provider value={followBottom}>
        <StreamingMarkdown text={text} indicator={<GenerationDots label="Generating response" />} />
      </FollowBottomContext.Provider>
    );
  }

  test("drives the view to the bottom in the commit that grew the streamed text", () => {
    // Given: a stream rendered inside a scroller that follows the bottom.
    const followBottom = mock(() => {});

    // When: the first tokens are revealed.
    const { rerender } = render(streamed("A streamed", followBottom));

    // Then: the view is driven to the bottom before the browser paints them.
    expect(followBottom).toHaveBeenCalledTimes(1);

    // When: the next tokens grow the body.
    rerender(streamed("A streamed line that wrapped", followBottom));

    // Then: the correction lands on that growth too — not one commit later.
    expect(followBottom).toHaveBeenCalledTimes(2);

    // When: the message re-renders without the text changing.
    rerender(streamed("A streamed line that wrapped", followBottom));

    // Then: nothing is driven anywhere, so the reader is left alone.
    expect(followBottom).toHaveBeenCalledTimes(2);
  });
});
