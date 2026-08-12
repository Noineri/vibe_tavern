/**
 * Markdown — render suppression at the ReactMarkdown seam.
 *
 * react-markdown 10 does not cache anything: its default export builds a fresh
 * unified processor and re-parses the whole string on every render it is given
 * (node_modules/react-markdown/lib/index.js — `Markdown()` calls
 * `createProcessor()` then `parse()` then `runSync()`, with no `useMemo`).
 * So the only way to stop a finished message from being re-parsed on every
 * streaming tick of its sibling is to stop rendering it at all — which is what
 * `React.memo` around `Markdown` does. These tests observe that seam directly:
 * how many times it is entered, and with which plugin lists.
 *
 * The `mock.module` factory spreads the real namespace first. That is mandatory
 * here, not defensive: `mock.module` is process-global, so a partial factory
 * turns every other export of the module into `undefined` for the rest of the
 * run.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Options } from "react-markdown";
import type { PluggableList } from "unified";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { render } = await import("@testing-library/react");

const realReactMarkdown = await import("react-markdown");

const seamCalls: Options[] = [];

mock.module("react-markdown", () => ({
  ...realReactMarkdown,
  default: function ReactMarkdownSeam(options: Options) {
    seamCalls.push(options);
    return <span data-testid="seam">{options.children}</span>;
  },
}));

let Markdown: typeof import("./markdown.js").Markdown;

beforeAll(async () => {
  ({ Markdown } = await import("./markdown.js"));
});

beforeEach(() => {
  seamCalls.length = 0;
});

function Parent({ text, variant }: { text: string; variant?: "chat" | "plain" }) {
  return <Markdown text={text} variant={variant} />;
}

function pluginCount(list: PluggableList | null | undefined): number {
  if (!Array.isArray(list)) throw new Error("expected the seam to receive a plugin list");
  return list.length;
}

describe("Markdown — memoization", () => {
  it("does not re-enter the seam when the parent re-renders with identical props", () => {
    const { rerender } = render(<Parent text="unchanged message" />);
    rerender(<Parent text="unchanged message" />);
    rerender(<Parent text="unchanged message" />);

    expect(seamCalls).toHaveLength(1);
  });

  it("hands the seam the same plugin lists across renders", () => {
    const { rerender } = render(<Parent text="a" />);
    rerender(<Parent text="ab" />);

    expect(seamCalls).toHaveLength(2);
    expect(seamCalls[1]?.remarkPlugins).toBe(seamCalls[0]?.remarkPlugins);
    expect(seamCalls[1]?.rehypePlugins).toBe(seamCalls[0]?.rehypePlugins);
  });
});

describe("Markdown — streaming updates still propagate", () => {
  it("re-renders on every text change and shows the newest text", () => {
    const { rerender, container } = render(<Parent text="A" />);
    rerender(<Parent text="AB" />);
    rerender(<Parent text="ABC" />);

    expect(seamCalls.map((call) => call.children)).toEqual(["A", "AB", "ABC"]);
    expect(container.textContent).toBe("ABC");
  });

  it("re-renders when only the variant changes", () => {
    const { rerender } = render(<Parent text="same text" variant="chat" />);
    rerender(<Parent text="same text" variant="plain" />);

    expect(seamCalls).toHaveLength(2);
    expect(seamCalls[0]?.rehypePlugins).not.toBe(seamCalls[1]?.rehypePlugins);
  });
});

describe("Markdown — variant selects the rehype list", () => {
  it("gives the chat variant two more rehype plugins than the plain one", () => {
    render(<Parent text="chat text" variant="chat" />);
    render(<Parent text="plain text" variant="plain" />);

    expect(seamCalls).toHaveLength(2);
    expect(pluginCount(seamCalls[0]?.rehypePlugins)).toBe(pluginCount(seamCalls[1]?.rehypePlugins) + 2);
  });
});
