import { beforeAll, describe, expect, it } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { act, fireEvent, render } = await import("@testing-library/react");

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
