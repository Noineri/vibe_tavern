/**
 * TrackerTemplateSummaryRow — schema preview accordion + icon remove.
 *
 * Pins the owner-approved character-form change: the remove control is an
 * icon-only trash button (named via `character_tracker_template_remove_aria`,
 * opening the existing DestructiveConfirmModal flow), and a "Schema" header
 * toggles an AnimatedDisclosure wrapping TrackerTemplateSchemaPreview, which
 * renders the full template schema recursively (nested object + array keys,
 * number ranges, type — label rows) plus the objective bullet rows.
 */
import { describe, expect, it, mock } from "bun:test";
import { normalizeTrackerTemplate, type TrackerTemplate } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { createElement } = await import("react");

// useT at the module boundary — keys verbatim so assertions match.
const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const n = Number(opts?.n);
      switch (key) {
        case "character_tracker_template_label": return "Tracker template";
        case "character_tracker_template_schema": return "Schema";
        case "character_tracker_template_remove_aria": return "Remove tracker template";
        case "character_tracker_template_remove": return "Remove";
        case "character_tracker_template_remove_title": return "Remove tracker template?";
        case "character_tracker_template_remove_body": return "Removing the template.";
        case "character_tracker_template_scene": return `Scene: ${n} field${n === 1 ? "" : "s"}`;
        case "character_tracker_template_objective": return `Objectives: ${String(opts?.mode)} mode, ${n} goal${n === 1 ? "" : "s"}`;
        case "character_tracker_template_mode_route": return "route";
        case "character_tracker_template_mode_goals": return "goals";
        case "tracker_template_long_term_goal": return "Long-term goal";
        case "tracker_template_prompt_scene_generate": return "Scene generation prompt";
        case "tracker_template_prompt_scene_rules": return "Scene rules prompt";
        case "tracker_template_prompt_scene_inject": return "Scene injection prompt";
        case "tracker_template_prompt_objective_generate": return "Objective generation prompt";
        case "tracker_template_prompt_objective_check": return "Objective check prompt";
        case "tracker_template_prompt_objective_inject": return "Objective injection prompt";
        case "cancel": return "Cancel";
        case "tracker_template_type_string": return "string";
        case "tracker_template_type_number": return "number";
        case "tracker_template_type_boolean": return "boolean";
        case "tracker_template_type_object": return "object";
        case "tracker_template_type_array": return "list";
        default: return key;
      }
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { TrackerTemplateSummaryRow } = await import("./TrackerTemplateSummaryRow.js");

function makeTemplate({
  mode = "goals",
  authoredPrompts = true,
  includeObjective = true,
}: {
  mode?: "route" | "goals";
  authoredPrompts?: boolean;
  includeObjective?: boolean;
} = {}): TrackerTemplate {
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
  const template = normalizeTrackerTemplate({
    version: 1,
    scene: {
      enabled: true,
      config: {
        schema: {
          mood: { $type: "string", label: "Mood" },
          stats: {
            $type: "object",
            properties: {
              health: { $type: "number", min: 0, max: 100 },
            },
          },
          tags: { $type: "array", items: { $type: "string" } },
        },
        ...scenePrompts,
      },
    },
    objective: includeObjective
      ? mode === "goals"
        ? {
            enabled: true,
            state: {
              mode: "goals",
              shortTermGoals: [{ id: "goal_1", description: "Find the hidden map", status: "pending" }],
              longTermGoal: { description: "Recover the lost archive", status: "pending" },
              ...objectivePrompts,
            },
          }
        : {
            enabled: true,
            state: {
              mode: "route",
              tasks: [{ id: "task_1", description: "Follow the hidden map", status: "pending" }],
              ...objectivePrompts,
            },
          }
      : null,
  });
  if (!template) throw new Error("Expected a populated tracker template");
  return template;
}

describe("TrackerTemplateSummaryRow — schema preview accordion + icon remove", () => {
  it("renders the summary line with the schema accordion collapsed", () => {
    const { container, getByRole, queryByText } = render(
      createElement(TrackerTemplateSummaryRow, { template: makeTemplate(), onClear: mock() }),
    );

    expect(queryByText("Scene: 3 fields · Objectives: goals mode, 1 goal")).not.toBeNull();
    expect(getByRole("button", { name: "Schema" })).not.toBeNull();
    // Collapsed: the disclosure body is unmounted, so no schema content exists.
    expect(queryByText("health")).toBeNull();
    expect(queryByText("Find the hidden map")).toBeNull();
    expect(queryByText("Scene generation prompt")).toBeNull();
    // The remove control is icon-only: an aria-labelled button with no text.
    const remove = container.querySelector('button[aria-label="Remove tracker template"]');
    expect(remove).not.toBeNull();
    expect(remove!.textContent).toBe("");
  });

  it("toggles the schema preview open, revealing nested keys, goals, prompts, and the long-term goal", async () => {
    const { container, findByText, getByRole, queryByText } = render(
      createElement(TrackerTemplateSummaryRow, { template: makeTemplate(), onClear: mock() }),
    );

    expect(queryByText("health")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Schema" }));

    expect(await findByText("mood")).not.toBeNull();
    expect(await findByText("health")).not.toBeNull();
    expect(await findByText("Find the hidden map")).not.toBeNull();
    expect(await findByText("Long-term goal")).not.toBeNull();
    expect(await findByText("Recover the lost archive")).not.toBeNull();
    const sceneGeneratePrompt = await findByText("Scene generation prompt");
    expect(sceneGeneratePrompt.nextElementSibling?.textContent).toBe("Write the next scene beat.\nPreserve the clue trail.");
    expect(sceneGeneratePrompt.nextElementSibling?.className).toContain("whitespace-pre-wrap");
    expect(await findByText("Scene rules prompt")).not.toBeNull();
    expect(await findByText("Keep continuity with established evidence.")).not.toBeNull();
    expect(await findByText("Scene injection prompt")).not.toBeNull();
    expect(await findByText("Scene tracker state follows.")).not.toBeNull();
    expect(await findByText("Objective generation prompt")).not.toBeNull();
    expect(await findByText("Update the objective after each scene.")).not.toBeNull();
    expect(await findByText("Objective check prompt")).not.toBeNull();
    expect(await findByText("Mark goals complete only with decisive evidence.")).not.toBeNull();
    expect(await findByText("Objective injection prompt")).not.toBeNull();
    expect(await findByText("Objective tracker state follows.")).not.toBeNull();
    const body = container.textContent ?? "";
    expect(body.includes("number 0–100")).toBe(true);
    expect(body.includes("string — Mood")).toBe(true);
  });

  it("omits empty prompt blocks and leaves route and scene-only previews without a long-term-goal row", async () => {
    const route = render(
      createElement(TrackerTemplateSummaryRow, {
        template: makeTemplate({ mode: "route", authoredPrompts: false }),
        onClear: mock(),
      }),
    );
    fireEvent.click(route.getByRole("button", { name: "Schema" }));
    expect(await route.findByText("Follow the hidden map")).not.toBeNull();
    expect(route.queryByText("Long-term goal")).toBeNull();
    expect(route.queryByText("Scene generation prompt")).toBeNull();
    expect(route.queryByText("Objective generation prompt")).toBeNull();
    route.unmount();

    const sceneOnly = render(
      createElement(TrackerTemplateSummaryRow, {
        template: makeTemplate({ includeObjective: false, authoredPrompts: false }),
        onClear: mock(),
      }),
    );
    fireEvent.click(sceneOnly.getByRole("button", { name: "Schema" }));
    expect(await sceneOnly.findByText("health")).not.toBeNull();
    expect(sceneOnly.queryByText("Long-term goal")).toBeNull();
    expect(sceneOnly.queryByText("Scene generation prompt")).toBeNull();
  });

  it("icon remove opens the confirm modal; confirm calls onClear", async () => {
    const onClear = mock(() => Promise.resolve());
    const { findByRole, findByText, getByRole, queryByText } = render(
      createElement(TrackerTemplateSummaryRow, { template: makeTemplate(), onClear }),
    );

    fireEvent.click(getByRole("button", { name: "Remove tracker template" }));
    expect(await findByText("Remove tracker template?")).not.toBeNull();
    fireEvent.click(await findByRole("button", { name: "Remove" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    // Flush the async confirm (onClear await → modal close) inside act.
    await waitFor(() => expect(queryByText("Remove tracker template?")).toBeNull());
  });
});
