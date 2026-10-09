import { describe, expect, it } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import { EmptyState } from "./empty-state.js";

useDomEnv();

const { render } = await import("@testing-library/react");

describe("EmptyState", () => {
  it("preserves the complete default DOM when no actions are passed", () => {
    const { container } = render(
      <EmptyState icon={<span>Icon</span>} title="No rules" sub="Create a rule to get started." />,
    );

    expect(container.innerHTML).toBe(
      '<div class="empty-state"><div class="empty-icon"><span>Icon</span></div><div class="empty-title">No rules</div><div class="empty-sub">Create a rule to get started.</div></div>',
    );
  });

  it("renders primary and secondary CTAs as native buttons", () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const { getByRole } = render(
      <EmptyState
        icon={<span>Icon</span>}
        title="No rules"
        cta="Create rule"
        onCta={() => { primaryCalls += 1; }}
        secondaryCta="Learn more"
        onSecondaryCta={() => { secondaryCalls += 1; }}
      />,
    );

    const primary = getByRole("button", { name: "Create rule" });
    const secondary = getByRole("button", { name: "Learn more" });
    expect(primary.getAttribute("type")).toBe("button");
    expect(primary.className).toBe("empty-cta");
    expect(secondary.getAttribute("type")).toBe("button");
    expect(secondary.className).toBe("empty-cta text-t2 hover:text-t1 bg-transparent border-transparent shadow-none");

    primary.click();
    secondary.click();
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(1);
  });
});
