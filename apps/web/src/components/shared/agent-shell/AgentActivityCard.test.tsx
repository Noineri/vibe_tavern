/**
 * CopilotActivityCard — the single tool-activity card row (TF-5).
 *
 * Ports the ex-TurnShell `LiveActivityRow` assertions: read / write_buffer /
 * run_test card shapes (path label, summary + target chip, informational
 * digest), the visual-target chip, streaming + error rows, and the minimum
 * done-card render. The word-diff disclosure and the Apply button are GONE —
 * the inline diff review lives in ExperienceCopilotEditorPanel (CD-5/CD-6).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let AgentActivityCard: typeof import("./AgentActivityCard.js").AgentActivityCard;
let LocaleProvider: typeof import("../../../i18n/context.js").LocaleProvider;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  // The card resolves target labels through the registered host
  // descriptors — importing the real host modules registers both kinds
  // (this file never unregisters them — the worker isolates the module
  // registry; same pattern as AgentProfileModal.test.tsx).
  await import("../../build/editors/copilot/experience-agent-host.js");
  await import("../../build/editors/script-agent-host.js");
  // SC-13a: the caption-params fixture host — the only host that returns
  // `titleParams` (both built-ins return none, pinned by the suites below).
  const { getAgentHost, registerAgentHost } = await import("../../../lib/agent-host-registry.js");
  registerAgentHost({
    kind: "sc13a-caption-host",
    i18n: {
      title: "agent_title",
      kindLabel: "agent_kind_script",
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
    },
    // AP-17: required on every descriptor (four keys, tuple-typed).
    starterPromptKeys: [
      "agent_starter_script_explain",
      "agent_starter_script_fix_bugs",
      "agent_starter_script_comment",
      "agent_starter_script_simplify",
    ],
    toolKeys: [],
    profileAssignment: { target: "chat" },
    // AP-2: required on every descriptor (a missing markup is a compile break).
    messageMarkup: "plain",
    bufferSpecs: [],
    transport: getAgentHost("experience").transport,
    buildSendOptions: () => ({}),
    toolCaption: (probe) =>
      probe.toolName === "caption_probe"
        ? { titleKey: "copilot_review_hunks_count", titleParams: { n: 3 } }
        : undefined,
    recordProposalRenderers: {},
  });
  ({ AgentActivityCard } = await import("./AgentActivityCard.js"));
  ({ LocaleProvider } = await import("../../../i18n/context.js"));
  // The params test mounts the real LocaleProvider: its `t` reads the
  // process-global i18next singleton at render time, and the provider only
  // boots it in a post-mount effect (one render too late — the card would
  // keep the pre-init empty string). Booting here makes the bundled
  // resources synchronously available from the first render (initAsync is
  // false); the identity-fallback suites below never read the singleton.
  const { initI18n } = await import("../../../i18n/i18n.js");
  initI18n("en");
});

afterAll(async () => {
  // R13: the params test below mounts the real LocaleProvider (its effect
  // boots the process-global i18n singleton at the default locale); restore
  // the default language so no later assertion in this worker can observe it.
  const { i18next } = await import("../../../i18n/i18n.js");
  await i18next.changeLanguage("en");
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

  it("AS-8e6: a failed dice sample roll captions as failed with `<checkId>: <error>` detail", () => {
    const { getAllByTestId } = render(
      <AgentActivityCard
        kind="script"
        activity={activity({
          toolCallId: "dice1",
          toolName: "run_script_test",
          status: "done",
          // The AS-8e6 dice envelope: clean discovery (null), no errors, no
          // errorMessage — the ONLY failing signal is the sample roll whose
          // validation failed (ok is false because the roll failed).
          summary: JSON.stringify({
            ok: false,
            kind: "dice",
            checks: [{ id: "attack", label: "Attack Roll", notation: "d20+5", actors: ["persona", "character"], resolution: "strict", faceShape: "d20" }],
            sampleRolls: [
              { checkId: "attack", checkLabel: "Attack Roll", notation: "d20+5", faceShape: "d20", resolution: "strict", result: { ok: false, error: "strict resolution requires resolve() to return final" } },
            ],
            discoveryError: null,
          }),
        })}
      />,
    );
    const titles = getAllByTestId("copilot-activity-title").map((el) => el.textContent);
    // Identity i18n: the key renders verbatim without a LocaleProvider.
    expect(titles[0]).toBe("agent_script_test_failed");
    const cards = getAllByTestId("copilot-activity-card");
    expect(cards[0]!.parentElement!.textContent).toContain("attack: strict resolution requires resolve() to return final");
  });

  it("AS-8e7a: experience run_test / run_simulate cards show captions, not raw JSON", () => {
    const { getAllByTestId } = render(
      <div>
        {/* A passed rules test — the live digest shape. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "t1", toolName: "run_test", status: "done", summary: JSON.stringify({ ok: true, status: "active", revision: 0 }) })}
        />
        {/* A failed rules test — the errorMessage is the detail. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "t2", toolName: "run_test", status: "done", summary: JSON.stringify({ ok: false, errorCode: "vm_error", errorMessage: "boom" }) })}
        />
        {/* The trust refusal — the errorMessage is the detail. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "t3", toolName: "run_test", status: "done", summary: JSON.stringify({ ok: false, errorCode: "script_not_trusted", errorMessage: "enable it first" }) })}
        />
        {/* A failed rules test with no message — caption, no detail. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "t4", toolName: "run_test", status: "done", summary: JSON.stringify({ ok: false, errorCode: "vm_error" }) })}
        />
        {/* A passed simulation. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "s1", toolName: "run_simulate", status: "done", summary: JSON.stringify({ ok: true, stopReason: "completed", iterations: 3 }) })}
        />
        {/* A failed simulation — the errorMessage is the detail. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "s2", toolName: "run_simulate", status: "done", summary: JSON.stringify({ ok: false, errorCode: "vm_error", errorMessage: "stalled" }) })}
        />
        {/* The persisted wrapper — unwrapped before captioning. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "w1", toolName: "run_test", status: "done", summary: JSON.stringify({ toolName: "run_test", output: { ok: true, status: "active" } }) })}
        />
        {/* Unparseable — keeps today's raw-summary fallback. */}
        <AgentActivityCard
          kind="experience"
          activity={activity({ toolCallId: "r1", toolName: "run_test", status: "done", summary: "{not json" })}
        />
      </div>,
    );
    const titles = getAllByTestId("copilot-activity-title").map((el) => el.textContent);
    // Identity i18n: the keys render verbatim without a LocaleProvider.
    expect(titles[0]).toBe("agent_rules_test_ok");
    expect(titles[1]).toBe("agent_rules_test_failed");
    expect(titles[2]).toBe("agent_rules_test_failed");
    expect(titles[3]).toBe("agent_rules_test_failed");
    expect(titles[4]).toBe("agent_simulate_ok");
    expect(titles[5]).toBe("agent_simulate_failed");
    expect(titles[6]).toBe("agent_rules_test_ok");
    expect(titles[7]).toBe("{not json");
    const cards = getAllByTestId("copilot-activity-card");
    expect(cards[0]!.parentElement!.textContent).not.toContain("active");
    expect(cards[1]!.parentElement!.textContent).toContain("boom");
    expect(cards[2]!.parentElement!.textContent).toContain("enable it first");
    expect(cards[3]!.parentElement!.textContent).not.toContain("vm_error");
    expect(cards[5]!.parentElement!.textContent).toContain("stalled");
    expect(cards[7]!.parentElement!.textContent).toContain("{not json");
  });
});

describe("CopilotActivityCard — caption params (SC-13a)", () => {
  it("a caption with params renders interpolated", () => {
    // The fixture host captions `caption_probe` with the hunks-count key
    // (`{n} hunks pending` in en) plus `{ n: 3 }` — the card renders
    // `t(titleKey, titleParams)`, so the real LocaleProvider interpolates.
    // (Without the provider `t` is the identity fallback and params are
    // unobservable — the ImagePromptTemplatesPane precedent mounts the real
    // provider at the default locale for the same reason.)
    const { getByTestId } = render(
      <LocaleProvider initialLocale="en">
        <AgentActivityCard
          kind="sc13a-caption-host"
          activity={activity({ toolCallId: "p1", toolName: "caption_probe", status: "done", summary: "raw probe output" })}
        />
      </LocaleProvider>,
    );
    expect(getByTestId("copilot-activity-title").textContent).toBe("3 hunks pending");
  });
});

// ─── Page translation (owner follow-up 2026-10-24) ───────────────────────
// behavior change: was → now, basis: AGENT_SHELL_POLISH_PLAN owner follow-up
// 2026-10-24 (page translation). The title slot carries MODEL text — it opts
// back in; the target chip (a buffer label) and the card root stay out.
describe("AgentActivityCard — page translation (follow-up 2026-10-24)", () => {
  it("title carries translate=yes (model summary)", () => {
    const { getByTestId } = render(
      <AgentActivityCard
        kind="experience"
        activity={activity({ toolCallId: "w1", toolName: "write_buffer", status: "done", summary: "added the score action" })}
      />,
    );
    expect(getByTestId("copilot-activity-title").getAttribute("translate")).toBe("yes");
  });

  it("chrome carries no opt-in: target chip stays untranslated", () => {
    const { getByTestId } = render(
      <AgentActivityCard
        kind="experience"
        activity={activity({ toolCallId: "v1", toolName: "edit_buffer", status: "done", summary: "tweaked visual", target: "visual", proposed: "new visual" })}
      />,
    );
    expect(getByTestId("copilot-activity-title").getAttribute("translate")).toBe("yes");
    expect(getByTestId("copilot-activity-target").getAttribute("translate")).toBeNull();
  });
});
