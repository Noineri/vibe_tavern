/**
 * CopilotActivityCard — the single tool-activity card row (TF-5).
 *
 * Ports the ex-TurnShell `LiveActivityRow` assertions: read / write_buffer /
 * run_test card shapes (path label, summary + target chip, informational
 * digest), the visual-target chip, streaming + error rows, and the minimum
 * done-card render. The word-diff disclosure and the Apply button are GONE —
 * the inline diff review lives in ExperienceCopilotEditorPanel (CD-5/CD-6).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let CopilotActivityCard: typeof import("./CopilotActivityCard.js").CopilotActivityCard;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ CopilotActivityCard } = await import("./CopilotActivityCard.js"));
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

describe("CopilotActivityCard — tool activity card (TF-5)", () => {
  it("renders read / write_buffer / run_test cards with their copilot shapes", () => {
    const { getAllByText, getAllByTestId, queryByTestId } = render(
      <div>
        <CopilotActivityCard
          activity={activity({ toolCallId: "read1", toolName: "read_skill_file", status: "done", summary: undefined, readPath: "/skills/combat.md" })}
        />
        <CopilotActivityCard
          activity={activity({ toolCallId: "write1", toolName: "write_buffer", status: "done", summary: "wrote rules", target: "rules", proposed: "proposed buffer" })}
        />
        <CopilotActivityCard
          activity={activity({ toolCallId: "run1", toolName: "run_test", status: "done", summary: "2 passed" })}
        />
      </div>,
    );

    // read_skill_file → the path is the card label.
    expect(getAllByText("/skills/combat.md")).toHaveLength(1);
    // write_buffer → summary + target chip (copilot target is "rules"|"visual").
    expect(getAllByText("wrote rules")).toHaveLength(1);
    // Identity i18n (no LocaleProvider mounted): useT falls back to the
    // key-as-string default, so the target chip renders its i18n key.
    expect(getAllByTestId("copilot-activity-target")[0]!.textContent).toBe("experience_copilot_rules");
    // run_test → informational summary.
    expect(getAllByText("2 passed")).toHaveLength(1);
    // The reviewing affordances live in the editor now, not here.
    expect(queryByTestId("copilot-apply-btn")).toBeNull();
  });

  it("renders a visual-target write_buffer card with a Visual label", () => {
    const { getByTestId } = render(
      <CopilotActivityCard
        activity={activity({ toolCallId: "v1", toolName: "edit_buffer", status: "done", summary: "tweaked visual", target: "visual", proposed: "new visual" })}
      />,
    );

    expect(getByTestId("copilot-activity-target").textContent).toBe("experience_copilot_visual");
  });

  it("renders a streaming placeholder and an error row", () => {
    const { getByText, container } = render(
      <div>
        <CopilotActivityCard
          activity={activity({ toolCallId: "s1", toolName: "write_buffer", status: "streaming", summary: undefined })}
        />
        <CopilotActivityCard
          activity={activity({ toolCallId: "e1", toolName: "run_test", status: "error", summary: undefined })}
        />
      </div>,
    );
    expect(container.querySelectorAll('[data-tool="write_buffer"]').length).toBe(1);
    expect(getByText("experience_copilot_tool_failed")).toBeDefined();
  });

  it("renders a minimal done run_test activity as a card", () => {
    const { getByTestId } = render(
      <CopilotActivityCard
        activity={activity({ toolCallId: "m1", toolName: "run_test", status: "done", summary: "ok" })}
      />,
    );
    expect(getByTestId("copilot-activity-card")).toBeDefined();
  });
});
