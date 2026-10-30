/**
 * Markdown — result cache (LC-4, LONG_CHAT_PERFORMANCE_REPORT step 4).
 *
 * Pins the bounded LRU in front of react-markdown's parse:
 * - a second mount of the same (variant, text) does NOT re-enter the
 *   react-markdown seam — the processor/parse pipeline does not run. That is
 *   the case a chat reopen or branch switch hits: `React.memo` cannot help
 *   there, it only skips re-renders of an already-mounted block, so on HEAD
 *   every remount rebuilds the processor and re-parses the whole string.
 * - for every fixture family the CACHED re-mount renders byte-identical DOM
 *   to the uncached first mount (the cache must not change what a message
 *   looks like — same contract as markdown.test.tsx's characterization);
 * - the key is complete: a different text and a different variant both
 *   re-run the pipeline, and the key is the text AFTER
 *   `preserveEscapedUnderscoreTags` (the exact renderer input);
 * - the lazy KaTeX path ($-bearing agent text) stays uncached;
 * - the LRU evicts at BOTH bounds (entry count, total text size) and a hit
 *   refreshes recency (true LRU, not FIFO).
 *
 * CO-LOAD CONTRACT (test/react-markdown-seam.ts discipline): this file
 * registers the SAME shared factory as markdown.test.tsx and
 * markdown.memo.test.tsx, so a co-loaded pair is behavior-identical whichever
 * registration is live.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { installReactMarkdownSeam, seamCalls } from "../../test/react-markdown-seam.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { render, waitFor } = await import("@testing-library/react");

installReactMarkdownSeam();

let Markdown: typeof import("./markdown.js").Markdown;
let configureMarkdownResultCacheForTests: typeof import("./markdown-result-cache.js").configureMarkdownResultCacheForTests;
let resetMarkdownResultCacheForTests: typeof import("./markdown-result-cache.js").resetMarkdownResultCacheForTests;

beforeAll(async () => {
  ({ Markdown } = await import("./markdown.js"));
  ({
    configureMarkdownResultCacheForTests,
    resetMarkdownResultCacheForTests,
  } = await import("./markdown-result-cache.js"));
});

beforeEach(() => {
  seamCalls.length = 0;
  resetMarkdownResultCacheForTests();
});

afterAll(() => {
  // Restore the default tunables and drop every entry (the cache is
  // module-global; a co-loaded sibling must not inherit test bounds), and
  // remove this file's injected KaTeX stylesheet link.
  resetMarkdownResultCacheForTests();
});

/**
 * The LC-4 fixture families: each exercises one transform the cache must
 * carry through unchanged. `sanity` proves the fixture actually reaches the
 * transform, so a fixture that silently stopped exercising it cannot pass.
 */
const FIXTURES: ReadonlyArray<{
  name: string;
  text: string;
  sanity?: (root: HTMLElement) => void;
}> = [
  {
    name: "paragraphs",
    text: ["First paragraph with **bold** words.", "", "Second paragraph after the blank line."].join("\n"),
    sanity: (root) => {
      expect(root.querySelectorAll("p")).toHaveLength(2);
      expect(root.querySelector("strong")).not.toBeNull();
    },
  },
  {
    name: "fenced code with blank lines",
    text: ["```python", "def f():", "", "    return 1", "```"].join("\n"),
    sanity: (root) => {
      expect(root.querySelector("pre")).not.toBeNull();
      expect(root.querySelector(".md-copy-btn")).not.toBeNull();
      expect(root.textContent).toContain("return 1");
    },
  },
  {
    name: "nested list",
    text: ["- outer", "  - inner", "    - deepest", "- second outer"].join("\n"),
    sanity: (root) => {
      expect(root.querySelectorAll(".md-list-item")).toHaveLength(4);
    },
  },
  {
    name: "quoted dialogue split across emphasis",
    text: `"Your shorts," he said. "You're *grieving fast fashion.*"`,
    sanity: (root) => {
      // The emphasis-split second quote is the rehypeQuotedText case.
      expect(root.querySelectorAll(".quoted-text")).toHaveLength(2);
    },
  },
  {
    name: "raw HTML that sanitize strips",
    text: 'Before <script>alert(1)</script> after',
    sanity: (root) => {
      expect(root.querySelector("script")).toBeNull();
      expect(root.textContent).toContain("Before");
    },
  },
  {
    name: "underscore custom tags",
    text: "<internal_states><details><summary>State</summary>Visible content</details></internal_states>",
    sanity: (root) => {
      expect(root.querySelector("details")).not.toBeNull();
      expect(root.textContent).not.toContain("<internal_states>");
    },
  },
  {
    name: "banners",
    text: "Before the fight [Combat begins] and after it.",
    sanity: (root) => {
      expect(root.querySelector(".system-banner")).not.toBeNull();
    },
  },
];

describe("Markdown — result cache (LC-4)", () => {
  describe("cached re-mounts render the same DOM without re-running the pipeline", () => {
    for (const fixture of FIXTURES) {
      it(`serves the cached element tree — ${fixture.name}`, () => {
        const first = render(<Markdown text={fixture.text} />);
        const firstHtml = first.container.innerHTML;
        fixture.sanity?.(first.container);
        first.unmount();

        seamCalls.length = 0;
        const second = render(<Markdown text={fixture.text} />);
        expect(second.container.innerHTML).toBe(firstHtml);
        // The cached re-mount must not run the parse pipeline.
        expect(seamCalls).toHaveLength(0);
        second.unmount();
      });
    }

    it("a second mount of the same text does not run the pipeline (chat reopen / branch switch)", () => {
      const first = render(<Markdown text="A reopened message body." />);
      expect(seamCalls).toHaveLength(1);
      first.unmount();

      const second = render(<Markdown text="A reopened message body." />);
      // Still one pipeline run — the second mount served the cache.
      expect(seamCalls).toHaveLength(1);
      second.unmount();
    });
  });

  describe("the cache key is complete", () => {
    it("a different text runs the pipeline", () => {
      render(<Markdown text="distinct body one" />).unmount();
      render(<Markdown text="distinct body two" />).unmount();
      expect(seamCalls).toHaveLength(2);
    });

    it("the same text under a different variant runs the pipeline — variant is in the key", () => {
      render(<Markdown text="variant key body" />).unmount();
      render(<Markdown text="variant key body" variant="plain" />).unmount();
      expect(seamCalls).toHaveLength(2);
    });

    it("keys by the text handed to the renderer (post preserveEscapedUnderscoreTags)", () => {
      render(<Markdown text={"&lt;b_x&gt;escaped&lt;/b_x&gt;"} />).unmount();
      seamCalls.length = 0;
      // A different raw spelling that preserves to the SAME renderer input
      // (markdown-underscore-tags.ts: entity and backslash escapes of an
      // underscore tag both become the private-use token) is a cache hit.
      render(<Markdown text={"\\<b_x>escaped\\</b_x>"} />).unmount();
      expect(seamCalls).toHaveLength(0);
    });
  });

  describe("the lazy KaTeX path stays uncached", () => {
    it("re-runs the math pipeline on a second mount of the same agent text", async () => {
      const { resetKatexStylesheetForTests } = await import("./markdown-math.js");
      resetKatexStylesheetForTests();

      const first = render(<Markdown text="$x^2$ first mount" variant="agent-plain" />);
      await waitFor(() => expect(first.container.querySelector(".katex")).not.toBeNull());
      first.unmount();

      seamCalls.length = 0;
      const second = render(<Markdown text="$x^2$ first mount" variant="agent-plain" />);
      await waitFor(() => expect(second.container.querySelector(".katex")).not.toBeNull());
      // The lazy math pipeline ran again — no cache in front of it.
      expect(seamCalls.some((call) => String(call.children).includes("x^2"))).toBe(true);
      second.unmount();
      resetKatexStylesheetForTests();
    });
  });

  describe("bounded LRU eviction", () => {
    it("evicts the least recently used entry at the entries bound", () => {
      configureMarkdownResultCacheForTests({ maxEntries: 2 });
      render(<Markdown text="oldest bound body" />).unmount();
      render(<Markdown text="middle bound body" />).unmount();
      // The third insert evicts the oldest entry (the entries bound is 2).
      render(<Markdown text="newest bound body" />).unmount();

      seamCalls.length = 0;
      render(<Markdown text="middle bound body" />).unmount();
      expect(seamCalls).toHaveLength(0);

      seamCalls.length = 0;
      render(<Markdown text="oldest bound body" />).unmount();
      expect(seamCalls).toHaveLength(1);
    });

    it("a hit refreshes recency — LRU, not FIFO", () => {
      configureMarkdownResultCacheForTests({ maxEntries: 2 });
      render(<Markdown text="alpha body" />).unmount();
      render(<Markdown text="beta body" />).unmount();
      // Touching alpha makes beta the least-recent side.
      render(<Markdown text="alpha body" />).unmount();
      render(<Markdown text="gamma body" />).unmount();

      seamCalls.length = 0;
      render(<Markdown text="alpha body" />).unmount();
      expect(seamCalls).toHaveLength(0);
    });

    it("evicts at the total text-size bound", () => {
      configureMarkdownResultCacheForTests({ maxEntries: 100, maxTotalChars: 30 });
      // 25 chars each: two entries total 50 chars > 30, so the second evicts
      // the first.
      const sized = (label: string) => `${label}${"x".repeat(25 - label.length)}`;
      render(<Markdown text={sized("one")} />).unmount();
      render(<Markdown text={sized("two")} />).unmount();

      // The surviving entry is still served from the cache (the size bound
      // evicted the OLDEST entry, not the newest).
      seamCalls.length = 0;
      render(<Markdown text={sized("two")} />).unmount();
      expect(seamCalls).toHaveLength(0);

      // The evicted entry re-runs the pipeline.
      seamCalls.length = 0;
      render(<Markdown text={sized("one")} />).unmount();
      expect(seamCalls).toHaveLength(1);
    });

    it("a text larger than the whole size bound is never cached", () => {
      configureMarkdownResultCacheForTests({ maxTotalChars: 4 });
      render(<Markdown text="far past the size bound" />).unmount();

      seamCalls.length = 0;
      render(<Markdown text="far past the size bound" />).unmount();
      expect(seamCalls).toHaveLength(1);
    });
  });
});
