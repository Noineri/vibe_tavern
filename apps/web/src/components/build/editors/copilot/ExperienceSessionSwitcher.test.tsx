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

function session(id: string, over: Partial<ExperienceCopilotThreadWire> = {}): ExperienceCopilotThreadWire {
  return {
    id,
    scriptId: "script-1",
    draftSessionId: null,
    title: "",
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
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
});
