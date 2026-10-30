/**
 * AgentStreamingMarkdown + splitLiveMarkdown — the LAG-4 block-split
 * renderer for the agent streaming bubble (step 5 of
 * AGENT_SHELL_RENDER_LAG_REPORT; supervisor-sanctioned prefix+tail shape).
 *
 * WHAT THIS PROVES
 *   1. SPLITTER BOUNDARIES (pure): the split lands only at safe block
 *      boundaries — fenced code keeps its blank lines whole, loose/nested
 *      list runs stay whole until a non-list line ends them, blank-line
 *      paragraph semantics match the whole-text parse — and the prefix is
 *      byte-stable while only the tail grows (the perf contract).
 *   2. FIXTURE EQUIVALENCE (the report's fixture set, real renderer): at
 *      EVERY growth point of each fixture, the split render produces the
 *      same markdown DOM and rendered text as the whole-text render. Each
 *      `Markdown` instance emits its own `.md-content` wrapper, so literal
 *      DOM equality is impossible BY CONSTRUCTION under any multi-instance
 *      split — the pinned equivalence is the task's parenthetical form:
 *      same normalized markdown per block (the serialized children of the
 *      wrappers, concatenated) + same rendered text. The two slices always
 *      reassemble the fixture byte-exactly.
 *   3. PERF SHAPE (supervisor condition 1): across a tail-growing flush the
 *      completed prefix never re-enters the react-markdown seam — only the
 *      tail re-parses (the seam records and delegates, so the DOM stays
 *      real; same instrument as markdown.memo.test.tsx).
 *   4. SETTLED PATH (supervisor condition 3): a non-streaming message
 *      renders exactly ONE .md-content wrapper with no seam class,
 *      byte-identical to the single-Markdown render of the same content —
 *      the durable truth the stream-time seam gap must hand back to.
 *
 * CO-LOAD CONTRACT (react-markdown-seam discipline — the seam's header):
 * this file renders through the REAL Markdown, so it joins the
 * markdown.test.tsx / markdown.memo.test.tsx set — the ONE shared
 * recording-and-delegating factory, never a private one.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installReactMarkdownSeam, seamCalls } from "../../../../test/react-markdown-seam.js";

useDomEnv();
const { render } = await import("@testing-library/react");

// Registered BEFORE the component imports below: mock.module only affects
// modules imported after the registration.
installReactMarkdownSeam();

let Markdown: typeof import("../../../lib/markdown.js").Markdown;
let AgentStreamingMarkdown: typeof import("./agent-streaming-markdown.js").AgentStreamingMarkdown;
let splitLiveMarkdown: typeof import("./agent-streaming-markdown.js").splitLiveMarkdown;
let AgentMessageBlock: typeof import("./AgentMessageBlock.js").AgentMessageBlock;
let syntheticAgentMessage: typeof import("./agent-synthetic-message.js").syntheticAgentMessage;

beforeAll(async () => {
  ({ Markdown } = await import("../../../lib/markdown.js"));
  ({ AgentStreamingMarkdown, splitLiveMarkdown } = await import("./agent-streaming-markdown.js"));
  ({ AgentMessageBlock } = await import("./AgentMessageBlock.js"));
  ({ syntheticAgentMessage } = await import("./agent-synthetic-message.js"));
});

// ── The report's fixture set (step 5) ────────────────────────────────────────
// No `$` (the math lazy chunk is out of scope here) and no raw HTML.
const FIXTURES: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: "plain paragraphs",
    text: "First paragraph, plain text.\n\nSecond paragraph with *emphasis* and **bold**.\n\nThird paragraph still streaming",
  },
  {
    name: "fenced code containing blank lines",
    text: "Before the fence.\n\n```python\ndef f():\n    return 1\n\n\ndef g():\n    return 2\n```\n\nAfter the fence, still streaming",
  },
  {
    name: "a nested list",
    text: "Lead-in line.\n\n- first item\n  - nested item one\n  - nested item two\n\n- second item\n\nTail paragraph streaming",
  },
  {
    name: "quoted dialogue split across emphasis",
    text: '"Your shorts," he said. "You are *grieving fast fashion.*"\n\n"Thank you," she replied, "**deeply**."\n\nThe scene continues streaming',
  },
];

/** Serialize an element's children as a structural string (tag + class +
 *  exact text nodes) — the normalized-markdown form compared across the
 *  whole and split renders. */
function serializeMarkdownChildren(wrapper: Element): string {
  const parts: string[] = [];
  // nodeType literals: 1 = element, 3 = text.
  const visit = (node: ChildNode): void => {
    if (node.nodeType === 3) {
      parts.push(JSON.stringify(node.nodeValue ?? ""));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const cls = el.getAttribute("class");
    parts.push(`<${el.tagName.toLowerCase()}${cls !== null ? ` class="${cls}"` : ""}>`);
    for (const child of Array.from(el.childNodes)) visit(child);
    parts.push(`</${el.tagName.toLowerCase()}>`);
  };
  for (const child of blockChildrenOf(wrapper)) visit(child);
  return parts.join("");
}

/** The wrapper's TOP-LEVEL children minus whitespace-only text nodes:
 *  react-markdown keeps each blank-line separator as a "\n" text node
 *  BETWEEN blocks, but every `Markdown` instance trims its own document
 *  edges — the separator node therefore exists only in the whole-text
 *  render, under ANY multi-instance split. It is layout-invisible
 *  (whitespace-only text between block boxes generates no box); the BLOCKS
 *  and their full contents — including in-block, pre-wrap-significant
 *  whitespace — stay byte-compared on both sides. */
function blockChildrenOf(wrapper: Element): ChildNode[] {
  return Array.from(wrapper.childNodes).filter(
    (node) => !(node.nodeType === 3 && (node.nodeValue ?? "").trim() === ""),
  );
}

/** Rendered text of the compared blocks (top-level separator whitespace
 *  excluded — see `blockChildrenOf`). */
function blockTextOf(wrapper: Element): string {
  return blockChildrenOf(wrapper).map((node) => node.textContent ?? "").join("");
}

/** The fixture-equivalence oracle: the split render's markdown DOM and
 *  rendered text equal the whole-text render's, and the slices reassemble
 *  the text byte-exactly. */
function expectSplitMatchesWhole(text: string, variant: "agent-rp" | "agent-plain"): void {
  const split = splitLiveMarkdown(text);
  expect(split.prefix + split.tail).toBe(text);

  const whole = render(<Markdown text={text} variant={variant} />);
  const wholeWrapper = whole.container.querySelector(".md-content");
  // The growth sweep starts at the empty text: `Markdown` renders null for
  // it, so BOTH paths render nothing — that is the equivalence.
  if (wholeWrapper === null) {
    expect(text).toBe("");
    const emptySplit = render(<AgentStreamingMarkdown text={text} variant={variant} />);
    expect(emptySplit.container.querySelector(".md-content")).toBeNull();
    emptySplit.unmount();
    whole.unmount();
    return;
  }
  const wholeDom = serializeMarkdownChildren(wholeWrapper);
  const wholeText = blockTextOf(wholeWrapper);
  whole.unmount();

  const splitRender = render(<AgentStreamingMarkdown text={text} variant={variant} />);
  const wrappers = Array.from(splitRender.container.querySelectorAll(".md-content"));
  // At most the prefix and tail wrappers (an empty side renders null).
  expect(wrappers.length).toBeLessThanOrEqual(2);
  const splitDom = wrappers.map((w) => serializeMarkdownChildren(w)).join("");
  const splitText = wrappers.map((w) => blockTextOf(w)).join("");
  splitRender.unmount();

  expect(splitDom).toBe(wholeDom);
  expect(splitText).toBe(wholeText);
}

// ── 1. Splitter boundaries (pure) ────────────────────────────────────────────

describe("splitLiveMarkdown — boundaries", () => {
  it("no safe boundary yet: everything is the tail", () => {
    expect(splitLiveMarkdown("Hello world")).toEqual({
      prefix: "",
      tail: "Hello world",
      seamAfterParagraph: false,
    });
    // A single newline is NOT a blank line — same paragraph, no boundary.
    expect(splitLiveMarkdown("One line\nstill the same paragraph")).toEqual({
      prefix: "",
      tail: "One line\nstill the same paragraph",
      seamAfterParagraph: false,
    });
    expect(splitLiveMarkdown("One.\n")).toEqual({
      prefix: "",
      tail: "One.\n",
      seamAfterParagraph: false,
    });
  });

  it("splits at the last sealed blank-line run; the run rides the tail", () => {
    expect(splitLiveMarkdown("P1.\n\nP2.\n\nP3 open")).toEqual({
      prefix: "P1.\n\nP2.\n",
      tail: "\nP3 open",
      seamAfterParagraph: true,
    });
    // A trailing blank run is a boundary only once SEALED by a newline.
    expect(splitLiveMarkdown("P1.\n\n")).toEqual({
      prefix: "P1.\n",
      tail: "\n",
      seamAfterParagraph: false,
    });
    // Multi-blank runs: one run, the boundary at its start.
    expect(splitLiveMarkdown("P1.\n\n\n\nP2")).toEqual({
      prefix: "P1.\n",
      tail: "\n\n\nP2",
      seamAfterParagraph: true,
    });
  });

  it("fenced code keeps its blank lines whole and completes as one block", () => {
    // Streaming INSIDE the fence: the boundary before the fence holds.
    expect(splitLiveMarkdown("Intro.\n\n```py\na\n\nb")).toEqual({
      prefix: "Intro.\n",
      tail: "\n```py\na\n\nb",
      seamAfterParagraph: false,
    });
    // Closed fence + sealed blank: the fence completes into the prefix.
    expect(splitLiveMarkdown("Intro.\n\n```py\na\n\nb\n```\n\nOutro")).toEqual({
      prefix: "Intro.\n\n```py\na\n\nb\n```\n",
      tail: "\nOutro",
      seamAfterParagraph: false,
    });
  });

  it("a list run (loose, nested) stays whole until a non-list line ends it", () => {
    expect(splitLiveMarkdown("Lead.\n\n- a\n  - nested\n\n- b")).toEqual({
      prefix: "Lead.\n",
      tail: "\n- a\n  - nested\n\n- b",
      seamAfterParagraph: false,
    });
    expect(splitLiveMarkdown("Lead.\n\n- a\n  - nested\n\n- b\n\nAfter")).toEqual({
      prefix: "Lead.\n\n- a\n  - nested\n\n- b\n",
      tail: "\nAfter",
      seamAfterParagraph: false,
    });
  });

  it("headings and quotes complete at their blank line; no seam compensation", () => {
    expect(splitLiveMarkdown("## Head\n\nBody streams")).toEqual({
      prefix: "## Head\n",
      tail: "\nBody streams",
      seamAfterParagraph: false,
    });
    expect(splitLiveMarkdown("> quoted\n\nBody streams")).toEqual({
      prefix: "> quoted\n",
      tail: "\nBody streams",
      seamAfterParagraph: false,
    });
  });

  it("seam compensation fires ONLY between two paragraph blocks", () => {
    expect(splitLiveMarkdown("P.\n\nP2 streams").seamAfterParagraph).toBe(true);
    // Conservative misses (no false compensation): non-paragraph tails.
    expect(splitLiveMarkdown("P.\n\n- item").seamAfterParagraph).toBe(false);
    expect(splitLiveMarkdown("P.\n\n| a | b |").seamAfterParagraph).toBe(false);
    expect(splitLiveMarkdown("P.\n\n    indented").seamAfterParagraph).toBe(false);
    // A paragraph tail after a NON-paragraph prefix: natural margins only.
    expect(splitLiveMarkdown("```\nc\n```\n\nTail paragraph").seamAfterParagraph).toBe(false);
  });

  it("the prefix is byte-stable across tail-only growth (supervisor condition 1)", () => {
    const steps = [
      "One.\n\nTwo",
      "One.\n\nTwo words",
      "One.\n\nTwo words arrive",
      "One.\n\nTwo words arrive.\n\nThree",
    ];
    const prefixAt = (t: string) => splitLiveMarkdown(t).prefix;
    const stable = prefixAt(steps[0]!);
    expect(stable).toBe("One.\n");
    // Tail-only growth: byte-identical prefix at every step.
    expect(prefixAt(steps[1]!)).toBe(stable);
    expect(prefixAt(steps[2]!)).toBe(stable);
    // A completed block extends the prefix exactly once, still stable after.
    expect(prefixAt(steps[3]!)).toBe("One.\n\nTwo words arrive.\n");
  });
});

// ── 2. Fixture equivalence (real renderer, growth sweep) ────────────────────

describe("AgentStreamingMarkdown — fixture equivalence with the whole-text render", () => {
  for (const fixture of FIXTURES) {
    it(`split render matches the whole-text render at every growth point — ${fixture.name}`, () => {
      for (let len = 0; len <= fixture.text.length; len += 6) {
        expectSplitMatchesWhole(fixture.text.slice(0, len), "agent-rp");
      }
      // The full fixture through the plain pipeline too (the agent-plain
      // variant shares the splitter; only the plugin set differs).
      expectSplitMatchesWhole(fixture.text, "agent-plain");
    });
  }
});

// ── 3. Perf shape (supervisor condition 1) ───────────────────────────────────

describe("AgentStreamingMarkdown — perf shape", () => {
  beforeEach(() => {
    seamCalls.length = 0;
  });

  it("a tail-growing flush re-parses only the tail — the completed prefix never re-enters the seam", () => {
    const completed = "First paragraph.\n\nSecond paragraph.\n\n";
    const { rerender } = render(
      <AgentStreamingMarkdown text={`${completed}The open tail`} variant="agent-rp" />,
    );
    rerender(<AgentStreamingMarkdown text={`${completed}The open tail gro`} variant="agent-rp" />);
    rerender(<AgentStreamingMarkdown text={`${completed}The open tail grows.`} variant="agent-rp" />);

    const texts = seamCalls.map((call) => String(call.children));
    // The completed prefix rendered EXACTLY once (its initial mount) — the
    // real Markdown's React.memo bailed on both tail-growing re-renders.
    expect(texts.filter((t) => t === "First paragraph.\n\nSecond paragraph.\n")).toHaveLength(1);
    // The open tail re-parsed per flush (the only live re-parse).
    expect(texts.filter((t) => t.includes("The open tail"))).toHaveLength(3);
  });

  it("a stream with no completed block yet renders exactly the single-Markdown DOM", () => {
    const text = "Just one growing paragraph";
    const bare = render(<Markdown text={text} variant="agent-plain" />);
    const bareHtml = bare.container.querySelector(".md-content")!.outerHTML;
    bare.unmount();

    const { container } = render(<AgentStreamingMarkdown text={text} variant="agent-plain" />);
    expect(container.querySelectorAll(".md-content")).toHaveLength(1);
    expect(container.querySelector(".md-content")!.outerHTML).toBe(bareHtml);
    expect(container.querySelector(".md-stream-tail-seam")).toBeNull();
  });

  it("paragraph-after-paragraph compensates the seam; other pairs do not", () => {
    const pAfterP = render(
      <AgentStreamingMarkdown text={"Para one.\n\nPara two streams"} variant="agent-rp" />,
    );
    // (JSX attribute literals do not process escapes — newline-bearing
    // strings are braced so the split sees real newlines, not literal "\\n".)
    const tailAfterParagraph = pAfterP.container.querySelectorAll(".md-content");
    expect(tailAfterParagraph.length).toBe(2);
    // The LAST wrapper is the tail — it carries the variant class + seam.
    expect(tailAfterParagraph[1]!.className).toBe("md-content md-agent md-stream-tail-seam");
    pAfterP.unmount();

    // A list tail streaming after a completed paragraph: the list stays in
    // the tail (it may still grow), and NO seam compensation fires (the
    // natural list margins ride the prefix's own container; conservative).
    const listTail = render(
      <AgentStreamingMarkdown text={"Lead.\n\n- a\n  - b"} variant="agent-rp" />,
    );
    const listWrappers = listTail.container.querySelectorAll(".md-content");
    expect(listWrappers.length).toBe(2);
    expect(listWrappers[1]!.className).toBe("md-content md-agent");
    listTail.unmount();

    // A paragraph tail after a closed fence: natural margins only.
    const afterFence = render(
      <AgentStreamingMarkdown text={"```\nc\n```\n\nTail paragraph"} variant="agent-rp" />,
    );
    const fenceWrappers = afterFence.container.querySelectorAll(".md-content");
    expect(fenceWrappers.length).toBe(2);
    expect(fenceWrappers[1]!.className).toBe("md-content md-agent");
    afterFence.unmount();
  });
});

// ── 4. The settled path stays the single-Markdown render (AP-29 handover) ────

describe("AgentStreamingMarkdown — the settled path is untouched", () => {
  it("a non-streaming message renders ONE .md-content wrapper, byte-identical to the single Markdown", () => {
    const content = "Settled message.\n\nWith a second paragraph and `code`.\n\n- a list";
    const bare = render(<Markdown text={content} variant="agent-rp" />);
    const bareHtml = bare.container.querySelector(".md-content")!.outerHTML;
    bare.unmount();

    const block = render(
      <AgentMessageBlock
        message={syntheticAgentMessage({ id: "m1", threadId: "t1", role: "assistant", content })}
        messageMarkup="rp-colors"
      />,
    );
    // THE SETTLED TRUTH: exactly one markdown wrapper, no seam class, and
    // its DOM is byte-identical to the single-Markdown render (the split
    // path never runs without the streaming flag — the transient seam gap
    // is stream-only and hands back to exactly this).
    expect(block.container.querySelectorAll(".md-content")).toHaveLength(1);
    expect(block.container.querySelector(".md-stream-tail-seam")).toBeNull();
    expect(block.container.querySelector(".md-content")!.outerHTML).toBe(bareHtml);
  });
});
