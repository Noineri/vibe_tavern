import { beforeAll, describe, expect, it, mock } from "bun:test";
import { normalizeTrackerTemplate, type SceneTrackerDsl, type TrackerTemplate } from "@vibe-tavern/domain";
import type { CoauthorTrackerTemplateReviewLabels } from "./CoauthorTrackerTemplateReview.js";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let CoauthorTrackerTemplateReview: typeof import("./CoauthorTrackerTemplateReview.js").CoauthorTrackerTemplateReview;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ CoauthorTrackerTemplateReview } = await import("./CoauthorTrackerTemplateReview.js"));
});

const labels: CoauthorTrackerTemplateReviewLabels = {
  title: "Tracker template",
  defaults: "Differences from default settings",
  current: "Current",
  noCurrent: "No template",
  scene: (count) => `Scene — ${count} fields`,
  objectives: (mode, count) => `Objectives — ${mode}, ${count}`,
  settings: {
    autoMode: "Auto mode", contextWindow: "Context window", continuityLastN: "Scene continuity",
    injectionDepth: "Injection depth", injectLastN: "Scene memory", promptFormat: "Prompt format",
    generatePrompt: "Generation prompt", injectPrompt: "Injection prompt", rulesPrompt: "Scene rules",
  },
  types: { string: "string", number: "number", boolean: "boolean", object: "object", array: "list" },
  enabled: "Enabled",
  disabled: "Disabled",
};

const trackerLabels: Record<string, string> = {
  tracker_template_long_term_goal: "Long-term goal",
  tracker_template_prompt_scene_generate: "Scene generation prompt",
  tracker_template_prompt_scene_rules: "Scene rules prompt",
  tracker_template_prompt_scene_inject: "Scene injection prompt",
  tracker_template_prompt_objective_generate: "Objective generation prompt",
  tracker_template_prompt_objective_check: "Objective check prompt",
  tracker_template_prompt_objective_inject: "Objective injection prompt",
  tracker_template_value_based_color: "value-based color",
};

function translate(key: string, options?: Record<string, unknown>) {
  if (key === "coauthor.tracker_template.review.was") return `was ${options?.value}`;
  if (key === "character_tracker_template_mode_goals") return "goals";
  if (key === "character_tracker_template_mode_route") return "route";
  return trackerLabels[key] ?? key;
}

function template({
  mode = "goals",
  authoredPrompts = true,
  includeObjective = true,
  schema,
}: {
  mode?: "route" | "goals";
  authoredPrompts?: boolean;
  includeObjective?: boolean;
  schema?: SceneTrackerDsl;
} = {}): TrackerTemplate {
  const sceneSchema = schema ?? {
    location: { $type: "string", label: "short text" },
    suspects: { $type: "array", items: { $type: "string" }, label: "people of interest" },
  };
  const scenePrompts = authoredPrompts
    ? {
        generatePrompt: "Write the next scene beat.\nPreserve the clue trail.",
        rulesPrompt: "Keep continuity with established evidence.",
        injectPrompt: "Scene tracker state follows.",
      }
    : {};
  const objectivePrompts = authoredPrompts
    ? {
        generatePrompt: "Update the objective after each scene.",
        checkPrompt: "Mark goals complete only with decisive evidence.",
        injectPrompt: "Objective tracker state follows.",
      }
    : {};
  const value = normalizeTrackerTemplate({
    version: 1,
    scene: {
      enabled: true,
      config: {
        schema: sceneSchema,
        injectionDepth: 2,
        injectLastN: 5,
        ...scenePrompts,
      },
    },
    objective: includeObjective
      ? mode === "goals"
        ? {
            enabled: true,
            state: {
              mode: "goals",
              shortTermGoals: [
                { id: "goal-1", description: "Find the strange signal", status: "pending" },
                { id: "goal-2", description: "Earn the assistant's trust", status: "pending" },
              ],
              longTermGoal: { description: "Solve the source of the signal", status: "pending" },
              ...objectivePrompts,
            },
          }
        : {
            enabled: true,
            state: {
              mode: "route",
              tasks: [{ id: "task-1", description: "Follow the signal", status: "pending" }],
              ...objectivePrompts,
            },
          }
      : null,
  });
  if (!value) throw new Error("Expected fixture tracker template to normalize");
  return value;
}

describe("CoauthorTrackerTemplateReview (CT-7b)", () => {
  it("renders the approved review-card sections and the empty current-template footer", () => {
    const { getByText } = render(
      <CoauthorTrackerTemplateReview
        template={template()}
        summary="Detective scene tracker with two starting goals."
        currentTemplate={null}
        selected={true}
        applying={false}
        onToggle={() => {}}
        labels={labels}
        t={translate}
      />,
    );
    expect(getByText("Tracker template")).toBeTruthy();
    expect(getByText("Detective scene tracker with two starting goals.")).toBeTruthy();
    expect(getByText("Scene — 2 fields")).toBeTruthy();
    expect(getByText("location")).toBeTruthy();
    expect(getByText("string — short text")).toBeTruthy();
    expect(getByText("Differences from default settings")).toBeTruthy();
    expect(getByText("Injection depth")).toBeTruthy();
    expect(getByText("2 (was 1)")).toBeTruthy();
    expect(getByText("Scene memory")).toBeTruthy();
    expect(getByText("5 (was 1)")).toBeTruthy();
    expect(getByText("Objectives — goals, 2")).toBeTruthy();
    expect(getByText("Find the strange signal")).toBeTruthy();
    expect(getByText("Current: No template")).toBeTruthy();
  });

  it("renders every non-empty authored prompt as a full block and the goals long-term goal", () => {
    const { getByText } = render(
      <CoauthorTrackerTemplateReview
        template={template()}
        summary="Drafted trackers."
        currentTemplate={null}
        selected={true}
        applying={false}
        onToggle={() => {}}
        labels={labels}
        t={translate}
      />,
    );

    const sceneGeneratePrompt = getByText("Scene generation prompt").nextElementSibling;
    expect(sceneGeneratePrompt?.textContent).toBe("Write the next scene beat.\nPreserve the clue trail.");
    expect(sceneGeneratePrompt?.className).toContain("whitespace-pre-wrap");
    expect(getByText("Scene rules prompt")).toBeTruthy();
    expect(getByText("Keep continuity with established evidence.")).toBeTruthy();
    expect(getByText("Scene injection prompt")).toBeTruthy();
    expect(getByText("Scene tracker state follows.")).toBeTruthy();
    expect(getByText("Objective generation prompt")).toBeTruthy();
    expect(getByText("Update the objective after each scene.")).toBeTruthy();
    expect(getByText("Objective check prompt")).toBeTruthy();
    expect(getByText("Mark goals complete only with decisive evidence.")).toBeTruthy();
    expect(getByText("Objective injection prompt")).toBeTruthy();
    expect(getByText("Objective tracker state follows.")).toBeTruthy();
    expect(getByText("Long-term goal")).toBeTruthy();
    expect(getByText("Solve the source of the signal")).toBeTruthy();
  });

  it("omits empty prompt blocks and the long-term-goal row for route and no-objective templates", () => {
    const route = render(
      <CoauthorTrackerTemplateReview
        template={template({ mode: "route", authoredPrompts: false })}
        summary="Route tracker."
        currentTemplate={null}
        selected={true}
        applying={false}
        onToggle={() => {}}
        labels={labels}
        t={translate}
      />,
    );
    expect(route.getByText("Follow the signal")).toBeTruthy();
    expect(route.queryByText("Long-term goal")).toBeNull();
    expect(route.queryByText("Scene generation prompt")).toBeNull();
    expect(route.queryByText("Objective generation prompt")).toBeNull();
    route.unmount();

    const sceneOnly = render(
      <CoauthorTrackerTemplateReview
        template={template({ includeObjective: false, authoredPrompts: false })}
        summary="Scene tracker."
        currentTemplate={null}
        selected={true}
        applying={false}
        onToggle={() => {}}
        labels={labels}
        t={translate}
      />,
    );
    expect(sceneOnly.queryByText("Objectives — goals, 2")).toBeNull();
    expect(sceneOnly.queryByText("Long-term goal")).toBeNull();
    expect(sceneOnly.queryByText("Scene generation prompt")).toBeNull();
  });

  it("calls the single include toggle and disables it while applying", () => {
    const onToggle = mock();
    const view = render(
      <CoauthorTrackerTemplateReview
        template={template()}
        summary="Drafted trackers."
        currentTemplate={template()}
        selected={true}
        applying={false}
        onToggle={onToggle}
        labels={labels}
        t={translate}
      />,
    );
    fireEvent.click(view.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.unmount();

    const applying = render(
      <CoauthorTrackerTemplateReview
        template={template()}
        summary="Drafted trackers."
        currentTemplate={null}
        selected={true}
        applying={true}
        onToggle={onToggle}
        labels={labels}
        t={translate}
      />,
    );
    expect((applying.getByRole("checkbox") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CoauthorTrackerTemplateReview — proposed tone markers (R7)", () => {
  const toneSchema: SceneTrackerDsl = {
    mood: { $type: "string", tone: "danger" },
    condition: { $type: "string", toneBy: { Stable: "success", Ruined: "danger" } },
    hunt: { $type: "object", tone: "accent", properties: { target: { $type: "string" } } },
    notes: { $type: "string" },
  };

  it("a toned node renders its dot; a toneBy string node renders the outline dot + muted label; neutral renders nothing", () => {
    const { container, getByText } = render(
      <CoauthorTrackerTemplateReview
        template={template({ schema: toneSchema, authoredPrompts: false, includeObjective: false })}
        summary="Tone-coded tracker."
        currentTemplate={null}
        selected={true}
        applying={false}
        onToggle={() => {}}
        labels={labels}
        t={translate}
      />,
    );

    // Row order follows the schema: mood (tone), condition (toneBy), hunt (tone); notes has no tone.
    const dots = Array.from(container.querySelectorAll(".tracker-template-tone-dot")) as HTMLElement[];
    expect(dots.length).toBe(3);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dots[0]!.className).toContain("bg-danger");
    expect(dots[1]!.className).toContain("border-t3");
    expect(dots[1]!.className).not.toContain("bg-");
    expect(dots[2]!.className).toContain("bg-accent");

    const valueBased = getByText("value-based color");
    expect(valueBased.className).toContain("text-t4");
    expect(valueBased.getAttribute("aria-hidden")).toBe(null);
  });
});
