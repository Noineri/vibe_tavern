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
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let AgentActivityCard: typeof import("./AgentActivityCard.js").AgentActivityCard;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  // The card resolves target labels through the registered host
  // descriptors — importing the real host modules registers both kinds
  // (this file never unregisters them — the worker isolates the module
  // registry; same pattern as AgentProfileModal.test.tsx).
  await import("../../build/editors/copilot/experience-agent-host.js");
  await import("../../build/editors/script-agent-host.js");
  ({ AgentActivityCard } = await import("./AgentActivityCard.js"));
});

function activity(over: Partial<AgentToolActivity>): AgentToolActivity {
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
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "read1", toolName: "read_skill_file", status: "done", summary: undefined, readPath: "/skills/combat.md" })}
        />
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "write1", toolName: "write_buffer", status: "done", summary: "wrote rules", target: "rules", proposed: "proposed buffer" })}
        />
        <AgentActivityCard
          kind="experience"
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
    expect(getAllByTestId("copilot-activity-target")[0]!.textContent).toBe("agent_rules");
    // run_test → informational summary.
    expect(getAllByText("2 passed")).toHaveLength(1);
    // The reviewing affordances live in the editor now, not here.
    expect(queryByTestId("copilot-apply-btn")).toBeNull();
    // Truncation policy (2026-08-17): a model summary WRAPS (never visually
    // cut — it is the user's window into what the copilot is doing); only a
    // file path stays single-line with ellipsis.
    const titles = getAllByTestId("copilot-activity-title").map((el) => el.className);
    expect(titles[0]).toContain("truncate"); // read path
    expect(titles[1]).not.toContain("truncate"); // write_buffer summary
    expect(titles[1]).toContain("break-words");
  });

  it("renders a visual-target write_buffer card with a Visual label", () => {
    const { getByTestId } = render(
      <AgentActivityCard
        kind="experience"
        activity={activity({ toolCallId: "v1", toolName: "edit_buffer", status: "done", summary: "tweaked visual", target: "visual", proposed: "new visual" })}
      />,
    );

    expect(getByTestId("copilot-activity-target").textContent).toBe("agent_visual");
  });

  it("AS-8e4: a script `code` proposal chip shows the script host's buffer label", () => {
    const { getByTestId, getByText } = render(
      <AgentActivityCard
        kind="script"
        activity={activity({ toolCallId: "c1", toolName: "edit_buffer", status: "done", summary: "fixed dice", target: "code", proposed: "new code" })}
      />,
    );

    // Identity i18n (no LocaleProvider mounted): the script host's buffer
    // label key renders verbatim — never the experience host's Visual label.
    expect(getByTestId("copilot-activity-target").textContent).toBe("script_code_label");
    expect(getByText("fixed dice")).toBeDefined();
  });

  it("renders a streaming placeholder and an error row", () => {
    const { getByText, container } = render(
      <div>
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "s1", toolName: "write_buffer", status: "streaming", summary: undefined })}
        />
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "e1", toolName: "run_test", status: "error", summary: undefined })}
        />
      </div>,
    );
    expect(container.querySelectorAll('[data-tool="write_buffer"]').length).toBe(1);
    expect(getByText("agent_tool_failed")).toBeDefined();
  });

  it("renders a minimal done run_test activity as a card", () => {
    const { getByTestId } = render(
      <AgentActivityCard
        kind="experience"
        activity={activity({ toolCallId: "m1", toolName: "run_test", status: "done", summary: "ok" })}
      />,
    );
    expect(getByTestId("copilot-activity-card")).toBeDefined();
  });

  it("PM-6: plan cards label by i18n (never the raw envelope/plan JSON); an errored plan keeps the raw summary", () => {
    const { getAllByTestId } = render(
      <div>
        {/* A done plan rewrite — NO summary (the controller/extraction omit it
            so the i18n label owns the title). */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "p1", toolName: "plan", status: "done", summary: undefined })}
        />
        {/* A done read_plan — the persisted row carries the whole plan JSON as
            its summary; the label must win over the machine shape. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "p2", toolName: "read_plan", status: "done", summary: '{"goal":"…","tasks":[…]}' })}
        />
        {/* A failed plan save — the error card keeps the raw content (the
            write_buffer failure shape), NOT the success label. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "p3", toolName: "plan", status: "error", summary: '{"ok":false}' })}
        />
      </div>,
    );
    const titles = getAllByTestId("copilot-activity-title").map((el) => el.textContent);
    // Identity i18n: the keys render verbatim without a LocaleProvider.
    expect(titles[0]).toBe("agent_plan_updated");
    expect(titles[1]).toBe("agent_plan_title");
    expect(titles[2]).toBe('{"ok":false}');
  });

  it("AS-8e5: a script run_script_test card shows a caption, not the raw JSON", () => {
    const { getAllByTestId } = render(
      <div>
        {/* A passed prompt-script test — the full result envelope, live shape. */}
        <AgentActivityCard
          kind="script"
          activity={activity({ toolCallId: "ok1", toolName: "run_script_test", status: "done", summary: JSON.stringify({ ok: true, kind: "prompt", personality: "p", scenario: "s", stateSummary: "{}", injectedMessages: [], console: [], errors: [] }) })}
        />
        {/* A failed prompt-script test — the first error is the detail. */}
        <AgentActivityCard
          kind="script"
          activity={activity({ toolCallId: "fail1", toolName: "run_script_test", status: "done", summary: JSON.stringify({ ok: false, kind: "prompt", personality: "", scenario: "", stateSummary: "{}", injectedMessages: [], console: [], errors: [{ error: "boom", line: 3 }, { error: "second" }] }) })}
        />
        {/* The trust refusal — the errorMessage is the detail. */}
        <AgentActivityCard
          kind="script"
          activity={activity({ toolCallId: "ref1", toolName: "run_script_test", status: "done", summary: JSON.stringify({ ok: false, errorCode: "script_not_trusted", errorMessage: "enable it first" }) })}
        />
        {/* Unparseable — keeps today's raw-summary fallback. */}
        <AgentActivityCard
          kind="script"
          activity={activity({ toolCallId: "raw1", toolName: "run_script_test", status: "done", summary: "{not json" })}
        />
      </div>,
    );
    const titles = getAllByTestId("copilot-activity-title").map((el) => el.textContent);
    // Identity i18n: the keys render verbatim without a LocaleProvider.
    expect(titles[0]).toBe("agent_script_test_ok");
    expect(titles[1]).toBe("agent_script_test_failed");
    expect(titles[2]).toBe("agent_script_test_failed");
    expect(titles[3]).toBe("{not json");
    // The failed + refusal details render in the existing sub-row style.
    const cards = getAllByTestId("copilot-activity-card");
    expect(cards[0]!.parentElement!.textContent).not.toContain("boom");
    expect(cards[1]!.parentElement!.textContent).toContain("boom");
    expect(cards[2]!.parentElement!.textContent).toContain("enable it first");
    expect(cards[3]!.parentElement!.textContent).toContain("{not json");
  });

  it("AS-8e5: an experience run_test card keeps its raw summary", () => {
    const { getByTestId } = render(
      <AgentActivityCard
        kind="experience"
        activity={activity({ toolCallId: "exp1", toolName: "run_test", status: "done", summary: JSON.stringify({ ok: true, checks: 3 }) })}
      />,
    );
    // No host caption for the experience kind — the raw digest stays.
    expect(getByTestId("copilot-activity-title").textContent).toBe(JSON.stringify({ ok: true, checks: 3 }));
  });
});
