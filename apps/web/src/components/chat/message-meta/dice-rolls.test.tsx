/**
 * DICE-F10_metadata — the message-owned Dice-result badge.
 *
 * Pins the descriptor contract (role gate + visibility), the compact badge
 * shapes (single → icon/total/label/inline dice; multiple → "{n} checks"), the
 * read-only historical detail (snapshot labels/notation/attempts/outcome), and
 * message isolation (two badges render independently). The historical-while-
 * disabled and script-lifecycle invariants are covered structurally: the badge
 * reads ONLY ctx.diceRolls (no dice-store / diceEnabled / live-script reads).
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import React from "react";
import { brandId, type DiceRollId, type DiceRollSnapshot } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realReactI18next = await import("react-i18next");
const realI18nContext = await import("../../../i18n/context.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");

// DiceFaces uses react-i18next directly; mock it (mirror dice-faces.test.tsx).
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

// dice-rolls.tsx uses useT from i18n/context.
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
  useT: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "dice_meta_checks") return `${options?.count} checks`;
      if (key === "dice_meta_checks_one") return `${options?.count} check`;
      if (key === "dice_attempt") return `Attempt ${options?.n}`;
      if (key === "dice_meta_captured_rev_title") return `captured r${options?.revision}`;
      return key;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => false }));

let DiceRollsBadge: typeof import("./dice-rolls.js").DiceRollsBadge;
let DiceRollDetailContent: typeof import("./dice-rolls.js").DiceRollDetailContent;
let diceRollsMetaDescriptor: typeof import("./dice-rolls.js").diceRollsMetaDescriptor;
let render: typeof import("@testing-library/react").render;
beforeAll(async () => {
	({ render } = await import("@testing-library/react"));
	({ DiceRollsBadge, DiceRollDetailContent, diceRollsMetaDescriptor } = await import("./dice-rolls.js"));
});

let n = 0;
function makeRoll(overrides: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
  n += 1;
  return {
    rollId: brandId<DiceRollId>(`roll-${n}`),
    requestId: `req-${n}`,
    actor: { actorType: "character", actorId: "char-1", actorLabel: "Hero" },
    scriptId: "script-1",
    scriptLabel: "Fate Die",
    scriptRevision: 3,
    checkId: "check-1",
    checkLabel: "Luck",
    notation: "1d20",
    faceShape: "d20",
    resolution: "narrative",
    mode: "normal",
    included: true,
    finalAttemptId: null,
    attempts: [{ attemptId: "att-1", faces: [14], modifier: 0, subtotal: 14, total: 14 }],
    boundMessageId: null,
    createdAt: "2026-07-22T10:00:00Z",
    ...overrides,
  };
}

describe("DICE-F10 dice-rolls meta descriptor", () => {
  it("is role-gated to user messages", () => {
    expect(diceRollsMetaDescriptor.roles).toEqual(["user"]);
  });

  it("is visible only when the message carries rolls (assistant/system never)", () => {
    const vis = diceRollsMetaDescriptor.visible!;
    expect(vis({ diceRolls: [] } as never)).toBe(false);
    expect(vis({ diceRolls: [makeRoll()] } as never)).toBe(true);
  });

  it("render returns a badge bound to the message's rolls (check label surfaces)", () => {
    const roll = makeRoll({ checkLabel: "Perception" });
    const node = diceRollsMetaDescriptor.render!({ diceRolls: [roll] } as never) as React.ReactElement;
    const { container } = render(node);
    expect(container.textContent).toContain("Perception");
  });
});

describe("DICE-F10 DiceRollsBadge — compact", () => {
  it("single roll renders the dice icon + mono total + check label + an inline DiceFaces row", () => {
    const roll = makeRoll({ final: { total: 17 } });
    const { container } = render(<DiceRollsBadge rolls={[roll]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("17"); // mono total
    expect(text).toContain("Luck"); // check label
    expect(container.querySelector('[role="list"]')).toBeTruthy(); // DiceFaces row
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(1); // one die
  });

  it("multiple rolls render an N-checks summary with NO inline dice row", () => {
    const rolls = [
      makeRoll({ rollId: brandId<DiceRollId>("a"), checkLabel: "Luck" }),
      makeRoll({ rollId: brandId<DiceRollId>("b"), checkLabel: "Aim" }),
    ];
    const { container } = render(<DiceRollsBadge rolls={rolls} />);
    expect(container.textContent).toContain("2 checks");
    expect(container.querySelector('[role="list"]')).toBeNull(); // no compact dice row
  });

  it("excluded roll dims the inline dice row (opacity-40)", () => {
    const roll = makeRoll({ included: false });
    const { container } = render(<DiceRollsBadge rolls={[roll]} />);
    const row = container.querySelector('[role="list"]');
    expect(row?.className).toContain("opacity-40");
  });

  it("narrative roll with no `final` shows the chosen/last attempt total", () => {
    const roll = makeRoll({
      attempts: [{ attemptId: "att-1", faces: [12], modifier: 0, subtotal: 12, total: 12 }],
    });
    const { container } = render(<DiceRollsBadge rolls={[roll]} />);
    expect(container.textContent).toContain("12");
  });
});

describe("DICE-F10 DiceRollDetailContent — read-only historical truth", () => {
  it("renders the SNAPSHOT's captured labels, notation, attempts, and strict outcome — not live scripts", () => {
    const roll = makeRoll({
      scriptLabel: "Old Fate Die",
      checkLabel: "Old Luck",
      scriptRevision: 2,
      notation: "2d6+1",
      attempts: [{ attemptId: "att-1", faces: [3, 5], modifier: 1, subtotal: 8, total: 9 }],
      final: { total: 9, outcome: "Success", degree: "by 3", constraint: "under fire" },
    });
    const { container } = render(<DiceRollDetailContent rolls={[roll]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Old Luck"); // captured check label
    expect(text).toContain("Old Fate Die"); // captured script label
    expect(text).toContain("2d6+1"); // notation
    expect(text).toContain("Success"); // outcome
    expect(text).toContain("by 3"); // degree
    expect(text).toContain("under fire"); // constraint
    expect(text).toContain("dice_total"); // i18n label key (mocked passthrough)
    expect(text).toContain("9"); // attempt total
  });

  it("renders the captured-revision tooltip on the actor/script line", () => {
    const roll = makeRoll({ scriptRevision: 7 });
    const { container } = render(<DiceRollDetailContent rolls={[roll]} />);
    const line = container.querySelector('[title]')!;
    expect(line.getAttribute("title")).toContain("captured r7");
    expect(line.getAttribute("title")).toContain("7");
  });

  it("renders multiple rolls as independent cards", () => {
    const rolls = [
      makeRoll({ rollId: brandId<DiceRollId>("a"), checkLabel: "Luck", attempts: [{ attemptId: "att-1", faces: [5], modifier: 0, subtotal: 5, total: 5 }] }),
      makeRoll({ rollId: brandId<DiceRollId>("b"), checkLabel: "Aim", attempts: [{ attemptId: "att-1", faces: [18], modifier: 0, subtotal: 18, total: 18 }] }),
    ];
    const { container } = render(<DiceRollDetailContent rolls={rolls} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Luck");
    expect(text).toContain("Aim");
    expect(text).toContain("5");
    expect(text).toContain("18");
  });
});

describe("DICE-F10 message isolation (registry renders per-message)", () => {
  it("two badges render their own rolls only — no cross-contamination", () => {
    const { container: a } = render(
      <DiceRollsBadge rolls={[makeRoll({ checkLabel: "Luck", final: { total: 5 } })]} />,
    );
    const { container: b } = render(
      <DiceRollsBadge rolls={[makeRoll({ checkLabel: "Aim", final: { total: 18 } })]} />,
    );
    expect(a.textContent).toContain("Luck");
    expect(a.textContent).not.toContain("Aim");
    expect(b.textContent).toContain("Aim");
    expect(b.textContent).not.toContain("Luck");
  });
});
