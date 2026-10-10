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
import { defaultObjectiveState, normalizeTrackerTemplate, type TrackerTemplate } from "@vibe-tavern/domain";
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

function makeTemplate(): TrackerTemplate {
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
      },
    },
    objective: {
      enabled: true,
      state: {
        ...defaultObjectiveState(),
        mode: "goals",
        shortTermGoals: [
          { id: "goal_1", description: "Find the hidden map", status: "pending" },
        ],
      },
    },
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
    // The remove control is icon-only: an aria-labelled button with no text.
    const remove = container.querySelector('button[aria-label="Remove tracker template"]');
    expect(remove).not.toBeNull();
    expect(remove!.textContent).toBe("");
  });

  it("toggles the schema preview open, revealing nested keys, ranges, and goals", async () => {
    const { container, findByText, getByRole, queryByText } = render(
      createElement(TrackerTemplateSummaryRow, { template: makeTemplate(), onClear: mock() }),
    );

    expect(queryByText("health")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Schema" }));

    expect(await findByText("mood")).not.toBeNull();
    expect(await findByText("health")).not.toBeNull();
    expect(await findByText("Find the hidden map")).not.toBeNull();
    const body = container.textContent ?? "";
    expect(body.includes("number 0–100")).toBe(true);
    expect(body.includes("string — Mood")).toBe(true);
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
