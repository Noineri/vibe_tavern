import { beforeAll, describe, expect, it, mock } from "bun:test";
import { normalizeTrackerTemplate, type TrackerTemplate } from "@vibe-tavern/domain";
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

function template(): TrackerTemplate {
  const value = normalizeTrackerTemplate({
    version: 1,
    scene: {
      enabled: true,
      config: {
        schema: {
          location: { $type: "string", label: "short text" },
          suspects: { $type: "array", items: { $type: "string" }, label: "people of interest" },
        },
        injectionDepth: 2,
        injectLastN: 5,
      },
    },
    objective: {
      enabled: true,
      state: {
        mode: "goals",
        shortTermGoals: [
          { id: "goal-1", description: "Find the strange signal", status: "pending" },
          { id: "goal-2", description: "Earn the assistant's trust", status: "pending" },
        ],
      },
    },
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
        t={(key, options) => {
          if (key === "coauthor.tracker_template.review.was") return `was ${options?.value}`;
          if (key === "character_tracker_template_mode_goals") return "goals";
          return key;
        }}
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
        t={(key) => key}
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
        t={(key) => key}
      />,
    );
    expect((applying.getByRole("checkbox") as HTMLButtonElement).disabled).toBe(true);
  });
});
