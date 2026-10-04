/**
 * Shared API-reference parts — layout contract tests (SCRIPT_EDITOR_CLEANUP
 * step 4): the «code + description» row renders both halves, and the overflow
 * contract holds — the card root and grids carry `min-w-0`, the code block
 * scrolls horizontally instead of widening the card, and nothing truncates or
 * ellipsizes authored copy.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let ApiRefCard: typeof import("./api-reference-parts.js").ApiRefCard;
let ApiRefCode: typeof import("./api-reference-parts.js").ApiRefCode;
let ApiRefRow: typeof import("./api-reference-parts.js").ApiRefRow;
let ApiRefSection: typeof import("./api-reference-parts.js").ApiRefSection;
beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ ApiRefCard, ApiRefCode, ApiRefRow, ApiRefSection } = await import("./api-reference-parts.js"));
});

function clsOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

describe("ApiRefRow", () => {
  it("renders the code chip and the description in one desktop row", () => {
    const { container, getByText } = render(
      <ApiRefRow code="context.dice.roll(notation)">— The ONLY source of randomness.</ApiRefRow>,
    );

    expect(getByText("context.dice.roll(notation)").tagName).toBe("CODE");
    expect(getByText("— The ONLY source of randomness.")).toBeTruthy();

    const row = container.querySelector("div");
    if (!row) throw new Error("row not rendered");
    const cls = clsOf(row);
    // Desktop keeps today's one-line row (md: = 768px, the app-wide MOBILE_MQ);
    // below it the chip stacks onto its own line (flex-col).
    expect(cls).toContain("flex");
    expect(cls).toContain("md:flex-row");
    expect(cls).toContain("flex-col");
    expect(cls).toContain("md:items-center");
  });

  it("renders a description-only row without the code chip", () => {
    const { container, getByText } = render(<ApiRefRow>— resolve() takes NO argument.</ApiRefRow>);

    expect(getByText("— resolve() takes NO argument.")).toBeTruthy();
    expect(container.querySelector("code")).toBeNull();
  });

  it("never truncates or ellipsizes the description", () => {
    const { container } = render(<ApiRefRow code="context.actor">— Frozen snapshot.</ApiRefRow>);
    const span = container.querySelector("span");
    if (!span) throw new Error("description span not rendered");
    const cls = clsOf(span);
    expect(cls).not.toContain("truncate");
    expect(cls).not.toContain("line-clamp");
    expect(cls).not.toContain("whitespace-nowrap");
    expect(cls).toContain("min-w-0");
  });
});

describe("ApiRefCode / ApiRefCard overflow contract", () => {
  it("scrolls long code lines horizontally instead of widening the card", () => {
    const { container } = render(
      <ApiRefCard title="Dice Script API">
        <ApiRefSection heading="1. Register a check">
          <ApiRefRow code="context.dice.register(def)">— Declare one check.</ApiRefRow>
          <ApiRefCode>{"context.dice.register({ /* …a line far wider than any phone… */ })"}</ApiRefCode>
        </ApiRefSection>
      </ApiRefCard>,
    );

    const pre = container.querySelector("pre");
    if (!pre) throw new Error("code block not rendered");
    const preCls = clsOf(pre);
    expect(preCls).toContain("overflow-x-auto");
    // Code stays unwrapped — the scroll carries the overflow, not the wrap.
    expect(preCls).not.toContain("whitespace-pre-wrap");

    // The card root and every grid level can shrink below their min-content,
    // so no code line can set the card's width.
    const cardRoot = container.querySelector("div");
    if (!cardRoot) throw new Error("card root not rendered");
    expect(clsOf(cardRoot)).toContain("min-w-0");
    const grids = Array.from(container.querySelectorAll("div")).filter((el) => clsOf(el).split(/\s+/).includes("grid"));
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(clsOf(grid)).toContain("min-w-0");
    }
  });
});
