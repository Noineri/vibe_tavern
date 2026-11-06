import { beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import { useMacroAutocompleteStore } from "./macro-autocomplete-store.js";

const { act, fireEvent, render } = await import("@testing-library/react");

// Order determinism (--randomize shuffles tests within the file): the macro
// recency store is a module-level singleton shared across EVERY AutoTextarea
// instance — a test that inserts {{persona}} promotes it to the top of the
// picker, and any test shuffled after it gets persona from Enter-on-first
// instead of user. Start every test from the seed order
// (WEB_TEST_RANDOMIZE_ORDER_REPORT step 1).
beforeEach(() => {
  useMacroAutocompleteStore.setState({ recency: [] });
});

// The component reads `window.HTMLTextAreaElement` at module scope, so it must
// be imported only after useDomEnv() has registered happy-dom.
let AutoTextarea: typeof import("./auto-textarea.js").AutoTextarea;
beforeAll(async () => {
	({ AutoTextarea } = await import("./auto-textarea.js"));
});

/** RTL's `change` fires React's onChange (the native-setter trick does not
 *  reach React under happy-dom); caret is then moved explicitly and surfaced
 *  through the `select` event, which the component listens to for its
 *  autocomplete recompute. */
function typeInto(el: HTMLTextAreaElement, text: string, caret = text.length) {
	fireEvent.change(el, { target: { value: text } });
	el.setSelectionRange(caret, caret);
	fireEvent.select(el);
}

function Controlled({ disabled }: { disabled?: boolean }) {
  return (
    <AutoTextarea
      className="test"
      defaultValue=""
      macroAutocomplete={!disabled}
    />
  );
}

function textarea() {
  return document.querySelector("textarea") as HTMLTextAreaElement;
}
function picker() {
  return document.body.querySelector('[aria-label="Macro picker"]');
}
function firstOption() {
  return document.body.querySelector('[role="option"]') as HTMLElement | null;
}

describe("AutoTextarea — macro autocomplete", () => {
  it("applies container layout to the custom-chrome root without moving editor classes or remounting", async () => {
    const content = (containerClassName: string) => <AutoTextarea bare scrollbarSize="thin"
      containerClassName={containerClassName} className="composer-chrome" defaultValue="Draft" />;
    const view = render(content("flex-1"));
    await act(async () => {});
    const ta = view.getByRole("textbox") as HTMLTextAreaElement;
    const area = ta.closest('[data-scroll-area="thin"]')!;
    expect(area.classList.contains("flex-1")).toBe(true);
    expect(area.classList.contains("min-w-0")).toBe(true);
    expect(ta.classList.contains("composer-chrome")).toBe(true);
    expect(area.classList.contains("composer-chrome")).toBe(false);
    expect(ta.hasAttribute("containerClassName")).toBe(false);
    ta.focus();
    ta.setSelectionRange(1, 3);
    await act(async () => view.rerender(content("w-full")));
    expect(view.getByRole("textbox")).toBe(ta);
    expect(ta.closest('[data-scroll-area="thin"]')).toBe(area);
    expect(area.classList.contains("w-full")).toBe(true);
    expect(area.classList.contains("flex-1")).toBe(false);
    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd, ta.value]).toEqual([1, 3, "Draft"]);
  });

  it("keeps the actual composer textarea, caret and macro picker with custom thin chrome", async () => {
    const view = render(<AutoTextarea bare scrollbarSize="thin" className="composer-chrome" defaultValue="" />);
    await act(async () => {});
    const ta = view.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.hasAttribute("data-scroll-viewport")).toBe(true);
    expect(ta.closest('[data-scroll-area="thin"]')).not.toBeNull();
    expect(ta.classList.contains("composer-chrome")).toBe(true);
    expect(ta.tabIndex).toBe(0);
    await act(async () => typeInto(ta, "hello {{"));
    expect(picker()).not.toBeNull();
    await act(async () => fireEvent.keyDown(ta, { key: "Enter" }));
    expect(ta.value).toBe("hello {{user}}");
    expect(view.getByRole("textbox")).toBe(ta);
    expect(ta.selectionStart).toBe(ta.value.length);
  });

  it("opens the picker when `{{` is typed", () => {
    render(<Controlled />);
    expect(picker()).toBeNull();
    const ta = textarea();
    typeInto(ta, "hello {{");
    expect(picker()).not.toBeNull();
    expect(firstOption()).not.toBeNull();
  });

  it("inserts the selected macro at the caret on click", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "hello {{");
    const opt = firstOption();
    expect(opt).not.toBeNull();
    fireEvent.click(opt!);
    // The typed `{{` (caret after it) is replaced by the chosen `{{name}}`.
    expect(ta.value).toBe("hello {{user}}");
  });

  it("selects the highlighted item via Enter", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "{{");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("{{user}}");
    expect(picker()).toBeNull();
  });

  it("closes on Escape without inserting", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "{{");
    expect(picker()).not.toBeNull();
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(picker()).toBeNull();
    expect(ta.value).toBe("{{");
  });

  it("arrow keys move the highlight and Enter inserts the moved-to item", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "{{");
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "Enter" });
    // Seed order: user, char, persona, … — two downs lands on `persona`.
    expect(ta.value).toBe("{{persona}}");
  });

  it("does not open when macroAutocomplete is disabled", () => {
    render(<Controlled disabled />);
    const ta = textarea();
    typeInto(ta, "{{");
    expect(picker()).toBeNull();
  });

  it("filters the list as the query grows", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "{{char");
    const opts = Array.from(document.body.querySelectorAll('[role="option"]'));
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts[0]!.textContent).toContain("{{char}}");
  });

  it("shows the alias that matched the query beside its canonical macro", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "{{us");
    const deletevar = Array.from(document.body.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes("{{deletevar}}"),
    );
    expect(deletevar).toBeTruthy();
    expect(deletevar!.textContent).toContain("flushvar");
  });

  it("does not show an alias when the canonical name matched the query", () => {
    render(<Controlled />);
    const ta = textarea();
    typeInto(ta, "{{deletevar");
    const deletevar = Array.from(document.body.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes("{{deletevar}}"),
    );
    expect(deletevar).toBeTruthy();
    expect(deletevar!.textContent).not.toContain("flushvar");
  });

  it("scrolls the macro picker rows inside the shared thin ScrollArea viewport (CNR-8d)", () => {
    render(<Controlled />);
    typeInto(textarea(), "{{");
    const first = firstOption();
    expect(first).not.toBeNull();
    // The rows sit inside the thin ScrollArea region and its viewport — the
    // picker list no longer scrolls on a native overflow-y-auto div.
    expect(first!.closest('[data-scroll-area="thin"]')).not.toBeNull();
    expect(first!.closest("[data-scroll-viewport]")).not.toBeNull();
  });
});

describe("AutoTextarea — thin-lane default (CNR-8n)", () => {
  it("wraps the default field in the thin editor root; the textarea stays the native viewport with its field base", async () => {
    const view = render(<AutoTextarea defaultValue="" minRows={2} />);
    await act(async () => {});
    const ta = view.getByRole("textbox") as HTMLTextAreaElement;
    // No props passed: the thin custom chrome is the DEFAULT now — the field
    // composes into the shared ScrollArea exactly like the composer seam.
    const root = ta.closest('[data-scroll-area="thin"]');
    expect(root).not.toBeNull();
    expect(root!.hasAttribute("data-scroll-editor")).toBe(true);
    expect(ta.hasAttribute("data-scroll-viewport")).toBe(true);
    // The textarea itself is unchanged as the real field + scroller: the
    // canon base (field-tokens) still composes on it, and the native
    // scrollbar is hidden by the viewport wiring (the lane replaces it).
    expect(ta.className).toContain("field-input-pad");
    expect(ta.className).toContain("overflow-y-auto");
    expect(ta.className).toContain("scrollbar-hide");
    // Non-scrolling fields show no chrome: Base UI mounts tracks on real
    // overflow only (happy-dom has none, so no track may render here).
    expect(root!.querySelector("[data-scroll-track]")).toBeNull();
  });

  it("keeps the same textarea node, caret and focus across the default wrap while the value grows", async () => {
    const content = (value: string) => <AutoTextarea value={value} onChange={() => {}} minRows={2} />;
    const view = render(content("One line"));
    await act(async () => {});
    const ta = view.getByRole("textbox") as HTMLTextAreaElement;
    const root = ta.closest('[data-scroll-area="thin"]')!;
    ta.focus();
    await act(async () => view.rerender(content("One line and a capped tail")));
    const next = view.getByRole("textbox") as HTMLTextAreaElement;
    // 8h2's node-identity pin, now for the default field: autosize growth
    // never remounts the editor — same DOM node, same root, focus retained.
    // (The caret is asserted on a same-value rerender below — a controlled
    // VALUE change legitimately resets it, React's own behavior.)
    expect(next).toBe(ta);
    expect(next.closest('[data-scroll-area="thin"]')).toBe(root);
    expect(document.activeElement).toBe(next);
    expect(next.value).toBe("One line and a capped tail");
    next.setSelectionRange(3, 5);
    await act(async () => view.rerender(content("One line and a capped tail")));
    expect(view.getByRole("textbox")).toBe(next);
    expect([next.selectionStart, next.selectionEnd]).toEqual([3, 5]);
  });

  it("carries row layout on containerClassName while className keeps styling the textarea (bare row shape)", async () => {
    const view = render(
      <AutoTextarea bare containerClassName="min-w-0 flex-1" className="bubble-chrome" minRows={1} maxRows={6} defaultValue="" />,
    );
    await act(async () => {});
    const ta = view.getByRole("textbox") as HTMLTextAreaElement;
    const root = ta.closest('[data-scroll-area="thin"]')!;
    // 8h2 lesson, now the default: in a horizontal flex row the remaining
    // width must size the ROOT — a flex class on the nested textarea cannot.
    expect(root.classList.contains("min-w-0")).toBe(true);
    expect(root.classList.contains("flex-1")).toBe(true);
    expect(ta.classList.contains("bubble-chrome")).toBe(true);
    expect(root.classList.contains("bubble-chrome")).toBe(false);
  });

  it("hides the field lane on phones; only the composer family keeps its thumb (owner ruling, CNR-8n rider)", async () => {
    const css = await Bun.file(`${import.meta.dir}/../../styles.css`).text();
    // The ≤768px / coarse-pointer policy hides EVERY DOM lane except the
    // composer family's (owner ruling 2026-11-02: on phones hide everything
    // except the composer). Since the CNR-8n flip every form field is an
    // editor root, so the old `:not([data-scroll-editor])` exception would
    // keep a 3px thumb on overflowing fields where the native bar was fully
    // hidden before — the rule now excludes exactly the composer marker.
    expect(css).toContain("@media (max-width: 768px), (hover: none) and (pointer: coarse)");
    expect(css).toContain("[data-scroll-area]:not([data-scroll-composer]) > [data-scroll-track]");
    const field = render(<AutoTextarea defaultValue="" minRows={2} />);
    await act(async () => {});
    const fieldRoot = (field.getByRole("textbox") as HTMLTextAreaElement).closest("[data-scroll-area]");
    // A form field is still an editor root, but NOT the composer: no marker,
    // so its lane hides on phone widths like every other lane.
    expect(fieldRoot!.hasAttribute("data-scroll-editor")).toBe(true);
    expect(fieldRoot!.hasAttribute("data-scroll-composer")).toBe(false);
    field.unmount();
    const composer = render(<AutoTextarea bare className="composer-chrome" defaultValue="" minRows={1} />);
    await act(async () => {});
    const composerRoot = (composer.getByRole("textbox") as HTMLTextAreaElement).closest("[data-scroll-area]");
    // `bare` is the composer-family escape hatch — exactly these lanes carry
    // the marker and keep their 3px thumb when overflowing on phones.
    expect(composerRoot!.hasAttribute("data-scroll-composer")).toBe(true);
  });
});
