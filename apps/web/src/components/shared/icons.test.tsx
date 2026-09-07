/**
 * Ic.settings anti-confusion pin (D7).
 *
 * v1.2.1 mobile defect D7: `Ic.settings` was a hand-drawn circle + 8 rays —
 * visually a phone-brightness sun — so users tapped past the AI pill's
 * settings button looking for brightness/theme. It is now lucide's real cog
 * gear. happy-dom cannot judge glyph similarity, so this pins the
 * machine-checkable side of the contract: the settings markup must not be
 * (or contain) the old sun glyph, and must differ from the dedicated Ic.sun.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let Ic: typeof import("./icons.js").Ic;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ Ic } = await import("./icons.js"));
});

describe("Ic.settings (D7 — must read as a gear, not a sun)", () => {
  it("renders an svg", () => {
    const { container } = render(<Ic.settings />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("is not the old sun glyph (r=2.5 center circle + 8 rays)", () => {
    // The retired glyph's signature: <circle cx="8" cy="8" r="2.5"/>. A gear
    // has no such circle; if a future redraw reintroduces this exact shape,
    // the confusion returns — fail loudly instead.
    const { container } = render(<Ic.settings />);
    expect(container.innerHTML).not.toContain('r="2.5"');
  });

  it("differs from the dedicated Ic.sun glyph", () => {
    const settings = render(<Ic.settings />);
    const sun = render(<Ic.sun />);
    expect(settings.container.innerHTML).not.toBe(sun.container.innerHTML);
  });
});
