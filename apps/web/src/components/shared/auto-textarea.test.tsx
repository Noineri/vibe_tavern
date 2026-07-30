import { beforeAll, describe, expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

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
});
