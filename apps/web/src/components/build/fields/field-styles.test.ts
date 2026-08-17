import { describe, expect, it } from "bun:test";
import { inputCls, lblCls, monoCls } from "./field-styles.js";

/**
 * Contract pin: the shared field classes must keep AutoTextarea's documented
 * `maxRows` behavior intact — "Max rows before the textarea stops growing and
 * SCROLLS INTERNALLY" (auto-textarea.tsx). `overflow-hidden` on a capped
 * auto-grow textarea silently clips the overflow instead of scrolling it
 * (invisible tail with no scrollbar); that regression shipped once (the class
 * was introduced in the same commit as auto-resize) and lived unnoticed in
 * every capped consumer — the character form's create-modal fields (cap 20)
 * and the experience playground's JSON fields (cap 12). This test makes the
 * shared constant loud if anyone reintroduces it.
 */
describe("field-styles — overflow contract (AutoTextarea maxRows)", () => {
  it("inputCls scrolls once capped: overflow-y-auto, never overflow-hidden", () => {
    expect(inputCls).toContain("overflow-y-auto");
    expect(inputCls).not.toContain("overflow-hidden");
  });

  it("monoCls inherits the scrollable overflow (it extends inputCls)", () => {
    expect(monoCls).toContain("overflow-y-auto");
    expect(monoCls).not.toContain("overflow-hidden");
    expect(monoCls.startsWith(inputCls)).toBe(true);
  });

  it("overflow appears exactly once (no competing overflow utilities)", () => {
    const overflows = inputCls.match(/overflow[a-z-]*/g) ?? [];
    expect(overflows).toEqual(["overflow-y-auto"]);
  });

  it("the label class is unchanged by the overflow contract (sanity)", () => {
    expect(lblCls).not.toContain("overflow");
  });
});
