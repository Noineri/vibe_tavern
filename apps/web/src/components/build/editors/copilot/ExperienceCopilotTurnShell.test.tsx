import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ExperienceCopilotTurnShell: typeof import("./ExperienceCopilotTurnShell.js").ExperienceCopilotTurnShell;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ExperienceCopilotTurnShell } = await import("./ExperienceCopilotTurnShell.js"));
});

function activity(over: Partial<ExperienceCopilotToolActivity>): ExperienceCopilotToolActivity {
  return {
    toolCallId: "call_1",
    toolName: "run_test",
    status: "done",
    summary: "digest",
    ...over,
  };
}

describe("ExperienceCopilotTurnShell — activity card shapes", () => {
  it("renders read / write_buffer / run_test cards with their copilot shapes", () => {
    const activities: ExperienceCopilotToolActivity[] = [
      activity({ toolCallId: "read1", toolName: "read_skill_file", status: "done", summary: undefined, readPath: "/skills/combat.md" }),
      activity({ toolCallId: "write1", toolName: "write_buffer", status: "done", summary: "wrote rules", target: "rules", proposed: "proposed buffer" }),
      activity({ toolCallId: "run1", toolName: "run_test", status: "done", summary: "2 passed" }),
    ];

    const { getByText, getByTestId, container } = render(
      <ExperienceCopilotTurnShell
        activities={activities}
        baseRules="old rules"
        baseVisual=""
        onApply={mock()}
      />,
    );

    // read_skill_file → the path is the card label, no diff.
    expect(getByText("/skills/combat.md")).toBeDefined();
    // write_buffer → summary + target chip (copilot target is "rules"|"visual").
    expect(getByText("wrote rules")).toBeDefined();
    // Identity i18n (no LocaleProvider mounted): useT falls back to the
    // key-as-string default, so the target chip renders its i18n key.
    expect(getByTestId("copilot-activity-target").textContent).toBe("experience_copilot_rules");
    // run_test → informational summary.
    expect(getByText("2 passed")).toBeDefined();

    // Expand the write_buffer card → base → proposed word diff renders. The
    // word diff splits on token boundaries, so assert the changed tokens.
    const writeCard = container.querySelector<HTMLElement>('[data-tool="write_buffer"]');
    expect(writeCard).not.toBeNull();
    fireEvent.click(writeCard!);
    expect(getByText("proposed")).toBeDefined();
    expect(getByText("buffer")).toBeDefined();
    expect(getByText("old")).toBeDefined();
    expect(getByText("rules")).toBeDefined();
  });

  it("renders a visual-target write_buffer card with a Visual label", () => {
    const { getByTestId } = render(
      <ExperienceCopilotTurnShell
        activities={[
          activity({ toolCallId: "v1", toolName: "edit_buffer", status: "done", summary: "tweaked visual", target: "visual", proposed: "new visual" }),
        ]}
        baseRules=""
        baseVisual="old visual"
        onApply={mock()}
      />,
    );

    expect(getByTestId("copilot-activity-target").textContent).toBe("experience_copilot_visual");
  });
});

describe("ExperienceCopilotTurnShell — Apply", () => {
  beforeEach(() => {
    // no shared state
  });

  it("Apply is disabled when no activity produced a proposal", () => {
    const { getByTestId } = render(
      <ExperienceCopilotTurnShell
        activities={[activity({ toolCallId: "run1", toolName: "run_test", status: "done", summary: "2 passed" })]}
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect((getByTestId("copilot-apply-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clicking Apply (after a write_buffer) calls onApply with the proposed buffer", () => {
    const onApply = mock();
    const { getByTestId } = render(
      <ExperienceCopilotTurnShell
        activities={[
          activity({ toolCallId: "w1", toolName: "write_buffer", status: "done", summary: "wrote rules", target: "rules", proposed: "new rules" }),
        ]}
        baseRules="old rules"
        baseVisual=""
        onApply={onApply}
      />,
    );

    fireEvent.click(getByTestId("copilot-apply-btn"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ rules: "new rules" });
  });

  it("routes both buffers into the patch when both were proposed", () => {
    const onApply = mock();
    const { getByTestId } = render(
      <ExperienceCopilotTurnShell
        activities={[
          activity({ toolCallId: "w1", toolName: "write_buffer", status: "done", summary: "rules", target: "rules", proposed: "R" }),
          activity({ toolCallId: "w2", toolName: "edit_buffer", status: "done", summary: "visual", target: "visual", proposed: "V" }),
        ]}
        baseRules=""
        baseVisual=""
        onApply={onApply}
      />,
    );

    fireEvent.click(getByTestId("copilot-apply-btn"));
    expect(onApply).toHaveBeenCalledWith({ rules: "R", visual: "V" });
  });
});
