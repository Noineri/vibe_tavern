import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// No i18n mock here: `useT()` without a `LocaleProvider` ancestor returns the
// context default (`t: key => key` — see the `createContext` default in
// `i18n/context.tsx`), so the key assertions below hold with the REAL module
// and nothing leaks into co-loaded files. A `mock.module` on this first-party
// module would be process-wide in a bundled run and reduce every co-loaded
// `useT()` (including a real `LocaleProvider`) to key-fallback — the exact
// poisoning this file caused for the RU separator suite (AgentMessageList's
// provider-less key assertions are the same safe pattern).

let MessageReasoning: typeof import("./MessageReasoning.js").MessageReasoning;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ MessageReasoning } = await import("./MessageReasoning.js"));
});

describe("MessageReasoning disclosure", () => {
  it("opens and collapses the real reasoning body", async () => {
    const { getByText, queryByText } = render(
      <MessageReasoning reasoning="private chain" variant="minimal" />,
    );
    expect(queryByText("private chain")).toBeNull();

    fireEvent.click(getByText("reasoning"));
    expect(getByText("private chain")).toBeTruthy();

    fireEvent.click(getByText("reasoning"));
    await waitFor(() => expect(queryByText("private chain")).toBeNull(), { timeout: 5000 });
  }, { timeout: 10000 });
});

// ─── AP-29: the inline preset (caption-line toggle, full-width body) ───────
// The co-author's block gains its third preset for the agent feed: the
// header sits inline in the caption row (caption-sized text, dot separator,
// label, duration, caret) and the AnimatedDisclosure body takes the row's
// full width on the next line. WAS (nothing rendered inline): no `inline`
// variant existed. NOW: the preset below (the `rich`/`minimal` entries and
// their render paths are untouched — the minimal test above pins minimal).
describe("MessageReasoning inline preset (AP-29)", () => {
  it("renders container-less: the header button sits inline, collapsed by default", () => {
    const { container, getByText, queryByText } = render(
      <MessageReasoning reasoning="kept thought" reasoningDurationMs={4200} variant="inline" />,
    );
    // Collapsed: the mono body is absent.
    expect(queryByText("kept thought")).toBeNull();
    // The caption-sized header carries the dot separator, the label and the
    // one-decimal duration — the toggle is the reasoning part only.
    const header = getByText("reasoning").closest("button")!;
    expect(header.textContent).toContain("·");
    expect(header.textContent).toContain("(4.2s)");
    // No boxing container (the preset renders `contents` so the button sits
    // inline in the caption row); the header keeps the caption size, never
    // the rich uppercase label; the caret is the small 9px glyph, never the
    // 14px brain icon (the minimal look).
    expect(header.parentElement!.className).not.toContain("rounded");
    expect(header.className).toContain("text-[calc(var(--ui-fs)-3px)]");
    expect(header.className).not.toContain("uppercase");
    expect(container.querySelector('svg[width="9"]')).not.toBeNull();
    expect(container.querySelector('svg[width="14"]')).toBeNull();
  });

  it("expanding puts the mono body on its own full-width line under the row", () => {
    const { container, getByText } = render(
      <MessageReasoning reasoning="kept thought" reasoningDurationMs={4200} variant="inline" />,
    );
    fireEvent.click(getByText("reasoning"));
    const body = getByText("kept thought");
    // The animated wrapper takes the row's full width (wraps to the next
    // flex line under the caption row); the body keeps the minimal mono type.
    const wrapper = body.closest(".basis-full");
    expect(wrapper).not.toBeNull();
    expect(body.className).toContain("font-mono");
    expect(container.querySelector(".basis-full")!.textContent).toContain("kept thought");
  });

  it("the minimal preset header carries no dot separator (inline-only)", () => {
    const { queryByText } = render(
      <MessageReasoning reasoning="kept thought" reasoningDurationMs={4200} variant="minimal" />,
    );
    expect(queryByText("·")).toBeNull();
  });
});
