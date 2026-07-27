import { beforeAll, describe, it, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// Mock react-i18next
const realReactI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
  ...realReactI18next,
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "dice_faces_enumeration") return `${options?.notation}: ${options?.faces}`;
      if (key === "dice_face_showing") return `d${options?.shape} showing ${options?.value}`;
      if (key === "dice_overflow_more") return `+${options?.n} more`;
      return key;
    },
  }),
}));

let DiceFace: typeof import("./dice-faces.js").DiceFace;
let DiceFaces: typeof import("./dice-faces.js").DiceFaces;
let glyphFor: typeof import("./dice-faces.js").glyphFor;
let extremityTone: typeof import("./dice-faces.js").extremityTone;
beforeAll(async () => {
  ({ DiceFace, DiceFaces, glyphFor, extremityTone } = await import("./dice-faces.js"));
});

describe("DiceFace — glyph", () => {
  it("glyphFor returns right paths for d4", () => {
    const glyph = glyphFor("d4");
    expect(glyph.valueDy).toBe(3.5);
    expect(glyph.paths.length).toBe(1);
    expect(glyph.fills).toBeUndefined();
  });

  it("glyphFor returns right paths for d6 with echo fill", () => {
    const glyph = glyphFor("d6");
    expect(glyph.fills?.length).toBe(1);
  });
});

describe("DiceFaces — structure", () => {
  it("has role=list, role=listitem, aria-label", () => {
    const { container } = render(
      <DiceFaces faceShape="d20" faces={[17]} notation="1d20" size="sm" maxVisible={3} rollKey="test1" />
    );
    const list = container.querySelector("[role='list']");
    expect(list).not.toBeNull();
    
    const listItem = container.querySelector("[role='listitem']");
    expect(listItem).not.toBeNull();
    expect(listItem?.getAttribute("aria-label")).toContain("showing 17");
  });
});

describe("DiceFaces — overflow", () => {
  it("maxVisible truncates, +N more chip appears", () => {
    const { container } = render(
      <DiceFaces faceShape="d6" faces={[1, 2, 3, 4, 5]} notation="5d6" size="sm" maxVisible={3} rollKey="test2" />
    );
    const diceList = container.querySelectorAll("svg");
    expect(diceList.length).toBe(3);
    const moreBtn = container.querySelector(".build-tag");
    expect(moreBtn).not.toBeNull();
    expect(moreBtn?.textContent).toBe("+2 more");
  });
});

describe("DiceFaces — extremity tint", () => {
  it("computes extremity tone correctly", () => {
    expect(extremityTone(20, 20)).toBe("max");
    expect(extremityTone(1, 20)).toBe("min");
    expect(extremityTone(10, 20)).toBe("default");
    expect(extremityTone(100, 100)).toBe("max");
  });

  it("renders success classes on max face", () => {
    const { container } = render(<DiceFace faceShape="d20" value={20} size="md" />);
    const text = container.querySelector("text");
    expect(text?.getAttribute("fill")).toBe("var(--success-text)");
  });

  it("renders danger classes on 1 face", () => {
    const { container } = render(<DiceFace faceShape="d20" value={1} size="md" />);
    const text = container.querySelector("text");
    expect(text?.getAttribute("fill")).toBe("var(--danger-text)");
  });
});

describe("DiceFaces — a11y", () => {
  it("visually-hidden enumeration survives overflow", () => {
    const { container } = render(
      <DiceFaces faceShape="d6" faces={[1, 2, 3, 4, 5]} notation="5d6" size="sm" maxVisible={3} rollKey="test3" />
    );
    const srOnly = container.querySelector(".sr-only");
    expect(srOnly).not.toBeNull();
    expect(srOnly?.textContent).toContain("1, 2, 3, 4, 5");
  });
});

describe("DiceFaces — loading skeleton", () => {
  it("renders exactly loading.count skeleton dice (no maxVisible cap, no overflow chip)", () => {
    // Spec: the consumer already caps loading.count at the notation's dice
    // count; the component renders `count` skeletons. maxVisible governs
    // rendered-dice overflow, not skeletons — so count > maxVisible still
    // renders every skeleton.
    const { container } = render(
      <DiceFaces faceShape="d6" notation="8d6" size="sm" maxVisible={6} rollKey="load1" loading={{ count: 8 }} />,
    );
    const skeletons = container.querySelectorAll("svg");
    expect(skeletons.length).toBe(8);
    // No "+N more" chip in the loading state — faces are unknown.
    expect(container.querySelector(".build-tag")).toBeNull();
  });

  it("skeleton dice use the --t3 outline and genp pulse", () => {
    const { container } = render(
      <DiceFaces faceShape="d20" notation="1d20" size="sm" maxVisible={6} rollKey="load2" loading={{ count: 1 }} />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("stroke")).toBe("var(--t3)");
    expect(svg.getAttribute("style")).toContain("genp");
  });

  it("loading row is role=list with the dice_loading aria-label", () => {
    const { container } = render(
      <DiceFaces faceShape="d6" notation="2d6" size="sm" maxVisible={6} rollKey="load3" loading={{ count: 2 }} />,
    );
    const list = container.querySelector("[role='list']");
    expect(list?.getAttribute("aria-label")).toBe("dice_loading");
  });
});

describe("DiceFaces — excluded (Immersive dim)", () => {
  it("applies opacity-40 to the row when excluded", () => {
    const { container } = render(
      <DiceFaces faceShape="d20" faces={[10]} notation="1d20" size="sm" maxVisible={6} rollKey="ex1" excluded />,
    );
    const list = container.querySelector("[role='list']")!;
    expect(list.className).toMatch(/opacity-40/);
  });

  it("does not dim when excluded is absent", () => {
    const { container } = render(
      <DiceFaces faceShape="d20" faces={[10]} notation="1d20" size="sm" maxVisible={6} rollKey="ex2" />,
    );
    const list = container.querySelector("[role='list']")!;
    expect(list.className).not.toMatch(/opacity-40/);
  });
});

describe("DiceFaces — overflow action", () => {
  it("renders a <button> chip when onOverflowClick is provided", () => {
    const onClick = mock();
    const { container } = render(
      <DiceFaces faceShape="d6" faces={[1, 2, 3, 4, 5]} notation="5d6" size="sm" maxVisible={3} rollKey="of1" onOverflowClick={onClick} />,
    );
    const btn = container.querySelector("button.build-tag");
    expect(btn).not.toBeNull();
  });

  it("renders a <span> chip (no button) when onOverflowClick is absent", () => {
    const { container } = render(
      <DiceFaces faceShape="d6" faces={[1, 2, 3, 4, 5]} notation="5d6" size="sm" maxVisible={3} rollKey="of2" />,
    );
    expect(container.querySelector("button.build-tag")).toBeNull();
    expect(container.querySelector("span.build-tag")).not.toBeNull();
  });

  it("clicking the overflow button fires onOverflowClick", () => {
    const onClick = mock();
    const { container } = render(
      <DiceFaces faceShape="d6" faces={[1, 2, 3, 4, 5]} notation="5d6" size="sm" maxVisible={3} rollKey="of3" onOverflowClick={onClick} />,
    );
    const btn = container.querySelector("button.build-tag")!;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("DiceFace — d% percentile", () => {
  it("renders the % badge as a second <text> outside the outline", () => {
    const { container } = render(<DiceFace faceShape="d%" value={42} size="md" />);
    const texts = container.querySelectorAll("text");
    expect(texts.length).toBe(2);
    expect(texts[1].textContent).toBe("%");
  });

  it("aria-label uses the percentile-die key (not the generic 'showing' label)", () => {
    const { container } = render(<DiceFace faceShape="d%" value={42} size="md" />);
    const svg = container.querySelector("svg")!;
    // The mock returns the key for unmapped strings; what matters is that the
    // label is built from dice_die_percentile (not dice_face_showing), so the
    // d% die announces itself as a percentile die, not "d% showing 42".
    expect(svg.getAttribute("aria-label")).toContain("dice_die_percentile");
    expect(svg.getAttribute("aria-label")).not.toContain("showing");
  });
});

describe("DiceFaces — settle animation is once-only and survives rerenders", () => {
  it("adds dice-settle on first render of a new rollKey", () => {
    const { container } = render(
      <DiceFaces faceShape="d20" faces={[10]} notation="1d20" size="sm" maxVisible={6} rollKey="anim1" />,
    );
    const firstWrapper = container.querySelector("[role='list'] > div");
    expect(firstWrapper?.className).toContain("dice-settle");
  });

  it("keeps the class across an unrelated rerender mid-animation (regression: lane refresh used to strip it)", () => {
    const props = { faceShape: "d20" as const, faces: [10], notation: "1d20", size: "sm" as const, maxVisible: 6, rollKey: "anim1" };
    const { container, rerender } = render(<DiceFaces {...props} />);
    expect(container.querySelector("[role='list'] > div")?.className).toContain("dice-settle");
    // A lane refresh rerenders the same roll BEFORE animationend fires — the
    // class must stay, otherwise the user never sees the settle motion.
    rerender(<DiceFaces {...props} faces={[10]} />);
    expect(container.querySelector("[role='list'] > div")?.className).toContain("dice-settle");
  });

  it("drops the class after animationend fires", () => {
    const { container } = render(
      <DiceFaces faceShape="d20" faces={[10]} notation="1d20" size="sm" maxVisible={6} rollKey="anim1" />,
    );
    const wrapper = container.querySelector("[role='list'] > div")!;
    expect(wrapper.className).toContain("dice-settle");
    fireEvent.animationEnd(wrapper);
    expect(container.querySelector("[role='list'] > div")?.className ?? "").not.toContain("dice-settle");
  });

  it("a fresh rollKey animates again after a previous one settled", () => {
    const { container, rerender } = render(
      <DiceFaces faceShape="d20" faces={[5]} notation="1d20" size="sm" maxVisible={6} rollKey="anim2a" />,
    );
    const firstWrapper = container.querySelector("[role='list'] > div")!;
    fireEvent.animationEnd(firstWrapper);
    rerender(
      <DiceFaces faceShape="d20" faces={[8]} notation="1d20" size="sm" maxVisible={6} rollKey="anim2b" />,
    );
    const wrapper = container.querySelector("[role='list'] > div");
    expect(wrapper?.className).toContain("dice-settle");
  });
});
