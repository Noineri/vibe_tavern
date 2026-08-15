/**
 * ExperienceCopilotTurnShell — the live turn's audit feed (ER-11c; CD-7).
 *
 * Pins the audit-card contract after the review moved to the editor: read /
 * write_buffer / run_test cards with their copilot shapes (path label, summary
 * + target chip, informational digest), streaming placeholders, and error
 * rows. The word-diff disclosure and the Apply button are GONE — the inline
 * diff review lives in ExperienceCopilotEditorPanel (CD-5/CD-6) and is pinned
 * there; this surface is glanceable live progress only.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let ExperienceCopilotTurnShell: typeof import("./ExperienceCopilotTurnShell.js").ExperienceCopilotTurnShell;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
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

describe("ExperienceCopilotTurnShell — live audit cards (CD-7)", () => {
  it("renders read / write_buffer / run_test cards with their copilot shapes", () => {
    const { getByText, getByTestId, queryByTestId } = render(
      <ExperienceCopilotTurnShell
        activities={[
          activity({ toolCallId: "read1", toolName: "read_skill_file", status: "done", summary: undefined, readPath: "/skills/combat.md" }),
          activity({ toolCallId: "write1", toolName: "write_buffer", status: "done", summary: "wrote rules", target: "rules", proposed: "proposed buffer" }),
          activity({ toolCallId: "run1", toolName: "run_test", status: "done", summary: "2 passed" }),
        ]}
      />,
    );

    // read_skill_file → the path is the card label.
    expect(getByText("/skills/combat.md")).toBeDefined();
    // write_buffer → summary + target chip (copilot target is "rules"|"visual").
    expect(getByText("wrote rules")).toBeDefined();
    // Identity i18n (no LocaleProvider mounted): useT falls back to the
    // key-as-string default, so the target chip renders its i18n key.
    expect(getByTestId("copilot-activity-target").textContent).toBe("experience_copilot_rules");
    // run_test → informational summary.
    expect(getByText("2 passed")).toBeDefined();
    // The reviewing affordances live in the editor now, not here.
    expect(queryByTestId("copilot-apply-btn")).toBeNull();
  });

  it("renders a visual-target write_buffer card with a Visual label", () => {
    const { getByTestId } = render(
      <ExperienceCopilotTurnShell
        activities={[
          activity({ toolCallId: "v1", toolName: "edit_buffer", status: "done", summary: "tweaked visual", target: "visual", proposed: "new visual" }),
        ]}
      />,
    );

    expect(getByTestId("copilot-activity-target").textContent).toBe("experience_copilot_visual");
  });

  it("renders a streaming placeholder and an error row", () => {
    const { getByText, container } = render(
      <ExperienceCopilotTurnShell
        activities={[
          activity({ toolCallId: "s1", toolName: "write_buffer", status: "streaming", summary: undefined }),
          activity({ toolCallId: "e1", toolName: "run_test", status: "error", summary: undefined }),
        ]}
      />,
    );
    expect(container.querySelectorAll('[data-tool="write_buffer"]').length).toBe(1);
    expect(getByText("experience_copilot_tool_failed")).toBeDefined();
  });

  it("renders nothing without activities", () => {
    const { container } = render(<ExperienceCopilotTurnShell activities={[]} />);
    expect(container.querySelector('[data-testid="copilot-turn-shell-block"]')).toBeNull();
  });
});
