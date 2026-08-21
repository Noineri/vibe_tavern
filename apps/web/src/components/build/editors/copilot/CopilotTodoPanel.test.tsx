import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { CopilotTodoItem } from "@vibe-tavern/api-contracts";
import en from "../../../../i18n/locales/en.json";
import ru from "../../../../i18n/locales/ru.json";

useDomEnv();

// CustomTooltip wraps children in a Radix Tooltip that never anchors under
// happy-dom (same reason the meter + shell tests mock it). Render children
// inline — this test pins the panel's render contract, not tooltip internals.
mock.module("../../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { render, fireEvent } = await import("@testing-library/react");
const { CopilotTodoPanel } = await import("./CopilotTodoPanel.js");

function item(status: CopilotTodoItem["status"], title: string): CopilotTodoItem {
  return { status, title };
}

const PLAN: CopilotTodoItem[] = [
  item("completed", "Design the turn loop"),
  item("active", "Write the rules buffer"),
  item("pending", "Bind the visual"),
  item("abandoned", "Old approach"),
  item("pending", "Run the sandbox test"),
];

function renderPanel(items: readonly CopilotTodoItem[]) {
  return render(<CopilotTodoPanel items={items} />);
}

describe("CopilotTodoPanel (TAG-8)", () => {
  it("renders NOTHING while the plan is empty (hidden until the first `todo` call)", () => {
    const { queryByTestId } = renderPanel([]);
    expect(queryByTestId("copilot-todo-panel")).toBeNull();
  });

  it("collapsed: current ACTIVE goal + live glyph + remaining count (verbatim format)", () => {
    const { getByTestId } = renderPanel(PLAN);
    const panel = getByTestId("copilot-todo-panel");
    expect(panel.getAttribute("data-state")).toBe("collapsed");
    // Current goal = the `active` item's title.
    expect(panel.textContent).toContain("Write the rules buffer");
    // The current-goal glyph is the ACTIVE one (pulsing dot marks it live).
    expect(getByTestId("copilot-todo-glyph-active")).toBeDefined();
    // Remaining = pending + active (3 here: active + 2 pending; abandoned is
    // given up, not remaining; completed is done).
    expect(panel.textContent).toContain("· 3");
  });

  it("collapsed: falls back to the first PENDING goal when nothing is active", () => {
    const { getByTestId } = renderPanel([item("pending", "First step"), item("pending", "Second step")]);
    const panel = getByTestId("copilot-todo-panel");
    expect(panel.textContent).toContain("First step");
    expect(panel.textContent).toContain("· 2");
    expect(getByTestId("copilot-todo-glyph-pending")).toBeDefined();
  });

  it("collapsed: a fully-resolved plan shows the done label + zero remaining", () => {
    const { getByTestId } = renderPanel([item("completed", "Only step"), item("abandoned", "Dropped")]);
    const panel = getByTestId("copilot-todo-panel");
    expect(panel.textContent).toContain("copilot_todo_done");
    expect(panel.textContent).toContain("· 0");
    expect(getByTestId("copilot-todo-glyph-completed")).toBeDefined();
  });

  it("expands on click → full ordered list with per-status glyphs, collapses back", () => {
    const { getByTestId, getByLabelText, getAllByTestId, queryAllByTestId } = renderPanel(PLAN);

    fireEvent.click(getByTestId("copilot-todo-panel"));
    const expanded = getByTestId("copilot-todo-panel");
    expect(expanded.getAttribute("data-state")).toBe("expanded");
    // Header: the i18n title (key fallback in tests) + the remaining count.
    expect(expanded.textContent).toContain("copilot_todo_title");
    expect(expanded.textContent).toContain("3");
    // Every item renders, in order, with its status glyph.
    const titles = Array.from(expanded.querySelectorAll("ol li")).map((li) => li.textContent);
    expect(titles).toEqual([
      "Design the turn loop",
      "Write the rules buffer",
      "Bind the visual",
      "Old approach",
      "Run the sandbox test",
    ]);
    expect(getAllByTestId("copilot-todo-item-completed")).toHaveLength(1);
    expect(getAllByTestId("copilot-todo-item-active")).toHaveLength(1);
    expect(getAllByTestId("copilot-todo-item-pending")).toHaveLength(2);
    expect(getAllByTestId("copilot-todo-item-abandoned")).toHaveLength(1);

    fireEvent.click(getByLabelText("copilot_todo_collapse"));
    expect(getByTestId("copilot-todo-panel").getAttribute("data-state")).toBe("collapsed");
    expect(queryAllByTestId("copilot-todo-item-pending")).toHaveLength(0);
  });

  it("read-only: no item row is a button and nothing but the toggle is interactive", () => {
    const { getByTestId } = renderPanel(PLAN);
    fireEvent.click(getByTestId("copilot-todo-panel"));
    const expanded = getByTestId("copilot-todo-panel");
    const buttons = expanded.querySelectorAll("button");
    // Exactly ONE interactive control: the collapse chevron in the header.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("copilot_todo_collapse");
  });

  it("i18n parity: the four panel keys resolve in BOTH en and ru", () => {
    const KEYS = ["copilot_todo_title", "copilot_todo_expand", "copilot_todo_collapse", "copilot_todo_done"] as const;
    for (const key of KEYS) {
      expect(en[key as keyof typeof en]).toBeTruthy();
      expect(ru[key as keyof typeof ru]).toBeTruthy();
    }
  });
});
