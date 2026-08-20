import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";

useDomEnv();

// Radix Popover.Content never mounts under happy-dom: its Popper anchors through
// `getBoundingClientRect`, which reports a 0x0 box for every element, so the
// content never anchors (documented in LinkBindingPopover.test.tsx). Render the
// popover inline so the session list is queryable — the same workaround the
// shell test applies to ToolbarSelect/CustomTooltip. apps/web runs each test
// file in its own bun process, so this full replacement cannot leak cross-file.
mock.module("@radix-ui/react-popover", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Anchor: () => null,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ExperienceSessionSwitcher: typeof import("./ExperienceSessionSwitcher.js").ExperienceSessionSwitcher;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ExperienceSessionSwitcher } = await import("./ExperienceSessionSwitcher.js"));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function session(id: string, over: Partial<Omit<ExperienceCopilotThreadWire, "metrics">> = {}): ExperienceCopilotThreadWire {
  return {
    id,
    scriptId: "script-1",
    draftSessionId: null,
    title: "",
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    metrics: null,
    contextLinks: [],
    todo: [],
    ...over,
  };
}

// Active first (the shell lists newest-first), then an archived sibling whose
// empty title exercises the locale "Session" fallback.
const SESSIONS: ExperienceCopilotThreadWire[] = [
  session("t1", { title: "Session one" }),
  session("t2", { archivedAt: "2026-08-11T10:00:00Z" }),
];

function renderSwitcher(over: Partial<Parameters<typeof ExperienceSessionSwitcher>[0]> = {}) {
  const props = {
    sessions: SESSIONS,
    activeThreadId: "t1",
    disabled: false,
    onActivate: mock(),
    onNew: mock(),
    onRename: mock(),
    ...over,
  };
  const utils = render(<ExperienceSessionSwitcher {...props} />);
  return { ...utils, props };
}

describe("ExperienceSessionSwitcher", () => {
  it("renders every session, highlights the active one, and marks archived", () => {
    const { getByTestId } = renderSwitcher();

    const active = getByTestId("copilot-session-t1");
    const archived = getByTestId("copilot-session-t2");

    expect(active).toBeDefined();
    expect(archived).toBeDefined();
    expect(active.getAttribute("data-active")).toBe("true");
    expect(active.getAttribute("data-archived")).toBe("false");
    expect(archived.getAttribute("data-active")).toBe("false");
    expect(archived.getAttribute("data-archived")).toBe("true");
    expect(active.className).toContain("bg-accent-dim");
    // Archived row is dimmed but still interactive (a real <button>).
    expect(archived.tagName).toBe("BUTTON");
  });

  it("uses the stored title when present and the locale fallback when empty", () => {
    const { getByTestId } = renderSwitcher();
    // No LocaleProvider in this isolated render → `t` is the identity function,
    // so the fallback renders as the raw key (deterministic assertion).
    expect(getByTestId("copilot-session-t1").textContent).toContain("Session one");
    expect(getByTestId("copilot-session-t2").textContent).toContain("experience_copilot_session");
  });

  it("the active session is not a switch target", () => {
    const onActivate = mock();
    const { getByTestId } = renderSwitcher({ onActivate });

    const active = getByTestId("copilot-session-t1");
    expect(active.tagName).not.toBe("BUTTON");
    fireEvent.click(active);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("clicking an archived session fires onActivate with its id", () => {
    const onActivate = mock();
    const { getByTestId } = renderSwitcher({ onActivate });

    fireEvent.click(getByTestId("copilot-session-t2"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith("t2");
  });

  it("+ New session fires onNew", () => {
    const onNew = mock();
    const { getByTestId } = renderSwitcher({ onNew });

    fireEvent.click(getByTestId("copilot-session-new"));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("when disabled, neither switching nor new-session fires", () => {
    const onActivate = mock();
    const onNew = mock();
    const { getByTestId } = renderSwitcher({ disabled: true, onActivate, onNew });

    fireEvent.click(getByTestId("copilot-session-t2"));
    fireEvent.click(getByTestId("copilot-session-new"));

    expect(onActivate).not.toHaveBeenCalled();
    expect(onNew).not.toHaveBeenCalled();
  });

  it("with no sessions, only + New session is shown", () => {
    const { getByTestId, queryByTestId } = renderSwitcher({ sessions: [] });

    expect(getByTestId("copilot-session-new")).toBeDefined();
    expect(queryByTestId("copilot-session-t1")).toBeNull();
  });

  // ── Numbering + rename (2026-08-17) ────────────────────────────────────────

  it("untitled sessions are numbered by creation order, not list position", () => {
    // Newest-first list: t2 (created later) is listed SECOND but is creation #2;
    // a third untitled session created FIRST lists last but must read "… 1".
    const sessions = [
      session("t1", { title: "", createdAt: "2026-08-02T00:00:00Z" }),
      session("t2", { title: "", createdAt: "2026-08-03T00:00:00Z", archivedAt: "x" }),
      session("t3", { title: "", createdAt: "2026-08-01T00:00:00Z" }),
    ];
    const { getByTestId } = renderSwitcher({ sessions });
    expect(getByTestId("copilot-session-t3").textContent).toContain("experience_copilot_session 1");
    expect(getByTestId("copilot-session-t1").textContent).toContain("experience_copilot_session 2");
    expect(getByTestId("copilot-session-t2").textContent).toContain("experience_copilot_session 3");
  });

  it("a stored title replaces the number; the active header shows the numbered label too", () => {
    const sessions = [
      session("t1", { title: "", createdAt: "2026-08-01T00:00:00Z" }),
      session("t2", { title: "Дурак редизайн", createdAt: "2026-08-02T00:00:00Z" }),
    ];
    const { getByTestId } = renderSwitcher({ sessions });
    expect(getByTestId("copilot-session-t2").textContent).toContain("Дурак редизайн");
    // Active = t1 (untitled) → the trigger label carries its number.
    expect(getByTestId("copilot-session-switcher-trigger").textContent).toContain(
      "experience_copilot_session 1",
    );
  });

  it("every row has a rename pencil; clicking it swaps the row into an inline input", () => {
    const onRename = mock();
    const { getByTestId, queryByTestId } = renderSwitcher({ onRename });

    // Pencil on both the active (div) row and a switch (button) row.
    expect(getByTestId("copilot-session-rename-t1")).toBeDefined();
    expect(getByTestId("copilot-session-rename-t2")).toBeDefined();

    fireEvent.click(getByTestId("copilot-session-rename-t2"));
    // The row becomes an <input> seeded with the DISPLAY label (the numbered
    // fallback for an untitled session).
    const input = getByTestId("copilot-session-t2").querySelector("input");
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toContain("experience_copilot_session");
  });

  it("Enter commits the rename (onRename with trimmed value); Escape cancels without firing", () => {
    const onRename = mock();
    const { getByTestId } = renderSwitcher({ onRename });

    fireEvent.click(getByTestId("copilot-session-rename-t1"));
    const input = getByTestId("copilot-session-t1").querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Дурак — визуал  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("t1", "Дурак — визуал");

    // Escape path: re-enter rename and abort.
    fireEvent.click(getByTestId("copilot-session-rename-t1"));
    const again = getByTestId("copilot-session-t1").querySelector("input") as HTMLInputElement;
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1); // still once
    expect(getByTestId("copilot-session-t1").querySelector("input")).toBeNull();
  });

  it("an unchanged or empty rename aborts without firing onRename", () => {
    const onRename = mock();
    const { getByTestId } = renderSwitcher({ onRename });

    // t1 has a stored title "Session one" — blur with the same value = abort.
    fireEvent.click(getByTestId("copilot-session-rename-t1"));
    const input = getByTestId("copilot-session-t1").querySelector("input") as HTMLInputElement;
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();

    // Empty input also aborts (never fires with "").
    fireEvent.click(getByTestId("copilot-session-rename-t1"));
    const again = getByTestId("copilot-session-t1").querySelector("input") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });
});
