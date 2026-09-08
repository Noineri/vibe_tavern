import { describe, expect, it } from "bun:test";
import { inputCls, lblCls, monoCls } from "./field-styles.js";

/**
 * Contract pin: the label class carries the canon 6px label→control gap
 * (mb-1.5) baked into the shared constant (LBLCLS_MB_SPACING_CANON), so the
 * spacing is structural, not per-callsite discipline. Horizontal row contexts
 * opt out with a local `!mb-0` (see ProviderBindingPanel/ProviderModelSelector).
 * If mb-1.5 disappears here, ~90 labels across 28 files silently lose their
 * gap — this test makes that loud.
 */
describe("field-styles — label spacing contract", () => {
  it("lblCls carries the canon mb-1.5 gap", () => {
    expect(lblCls).toContain("mb-1.5");
  });
});

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
