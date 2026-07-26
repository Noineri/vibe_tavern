import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { AutoTextarea } from "./auto-textarea.js";

/** The native value setter — same technique the component uses to insert a
 *  macro, so the test mirrors production. Setting `.value` directly on a
 *  React-controlled textarea then firing `change` makes the handler observe the
 *  new value + caret (RTL's `fireEvent.change` init does not set selectionStart
 *  reliably, so we set both on the node first). */
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)!.set!;

function typeInto(el: HTMLTextAreaElement, text: string, caret = text.length) {
  nativeValueSetter.call(el, text);
  el.setSelectionRange(caret, caret);
  fireEvent.change(el);
}

function Controlled({ disabled }: { disabled?: boolean }) {
  const [v, setV] = useState("");
  return (
    <AutoTextarea
      className="test"
      value={v}
      onChange={(e) => setV(e.target.value)}
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
