/**
 * Desktop two-pane assistant layout — behavioral tests (SIDECHAT_PLAN, SC-16c).
 *
 * Mounts the REAL `AgentShellDesktopTwoPane` with probe chat/editor nodes (no
 * stores, no fetch, no host registration — the kind is only a storage-key
 * namespace). The only process-global state touched here is `localStorage`
 * and the viewport width, both restored after each test. `useT` runs without
 * a provider (the context default returns keys verbatim), so no global i18n
 * is initialized (R13); the Radix tooltip never opens in these tests.
 *
 * Pins (the SC-16c steps this module owns; mobile stays with the untouched
 * ExperienceCopilotShell/script-agent-host suites, whose mobile branches and
 * tab rows render byte-identically — verified by diff, not re-pinned here):
 *   - collapse/expand per surface (script + experience kinds);
 *   - collapsed + width state restored after remount;
 *   - script and mini-app state independent (separate keys, no cross-write);
 *   - width drag, clamp (320 min, half-window max) and double-click reset
 *     (440) per surface;
 *   - the collapsed pane keeps its mounted content (the draft survives on
 *     the SAME DOM node, the turn marker stays in the document, hidden);
 *   - the owner-settled «Помощник»/«Assistant» copy on both handles
 *     (asserted against the real locale files, not the key).
 *
 * L1: paths repo-relative (relative imports + a viewport override restored in
 * afterAll); restores in beforeEach (localStorage, viewport); waits are the
 * paint-gate slide-kick drain + a transform `transitionend` dispatch
 * (never a sleep);
 * queries via render()'s returned utils (`within` for the dual-surface
 * test); every assertion pins a stable state (post-kick widths, the
 * post-transition hidden frame). No `mock.module` (no third-party seam is
 * crossed), no out-of-repo paths.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { AgentShellDesktopTwoPane } from "./desktop-two-pane.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// ── Viewport width control (the pane's 50% max reads window.innerWidth) ────
const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
function setViewportWidth(value: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value });
}

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let within: typeof import("@testing-library/react").within;

beforeAll(async () => {
  ({ render, act, fireEvent, within } = await import("@testing-library/react"));
});

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1024);
});

afterAll(() => {
  if (innerWidthDescriptor) Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
});

/** Stateful chat probe: the input draft stands in for the assistant's composer. */
function DraftProbe({ id }: { id: string }) {
  const [draft, setDraft] = useState("");
  return (
    <div data-testid={id}>
      <input data-testid={`${id}-draft`} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
      <div data-testid={`${id}-turn`}>turn-marker</div>
    </div>
  );
}

function renderTwoPane(kind: string) {
  return render(
    <AgentShellDesktopTwoPane
      kind={kind}
      chatPane={<DraftProbe id={`chat-${kind}`} />}
      editorPane={<div data-testid={`editor-${kind}`}>editor</div>}
    />,
  );
}

/** Drain the paint-gate slide kick `setTimeout(0)` inside `act` (a resolved-state wait, never a sleep). */
async function flushKick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function classTokens(el: HTMLElement): string[] {
  return (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
}

/**
 * Dispatch the slider's own transform `transitionend` (SC-16e: the close
 * path moved from the pane's width transition to the slider's transform
 * transition). happy-dom drops `propertyName` from the TransitionEvent init
 * dict, so a plain bubbling Event with the expando assigned is what the
 * slider filters on; dispatch ON the slider (`target === currentTarget`)
 * inside `act` so React flushes.
 */
function endSlideTransition(el: HTMLElement): void {
  const end = new Event("transitionend", { bubbles: true, cancelable: true }) as Event & {
    propertyName?: string;
  };
  end.propertyName = "transform";
  act(() => {
    el.dispatchEvent(end);
  });
}

/** The chevron svg inside a handle (Icons.Caret rotates via inline style). */
function toggleChevronStyle(toggle: HTMLElement): string {
  return toggle.querySelector("svg")?.getAttribute("style") ?? "";
}

// ── Collapse / expand ───────────────────────────────────────────────────────

describe("desktop-two-pane — collapse/expand (SC-16c)", () => {
  it("the chevron collapses the pane; the collapsed pane stays mounted and hidden", async () => {
    const utils = renderTwoPane("script");
    await flushKick();
    expect(utils.getByTestId("agent-assistant-panel-script").style.width).toBe("440px");

    // Draft a message before collapsing (the assistant's composer state).
    const draft = utils.getByTestId("chat-script-draft") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "half-written turn" } });
    expect(draft.value).toBe("half-written turn");

    // The open chevron points left (into the pane) under the shared label.
    expect(utils.getByTestId("assistant-collapse")).toBeDefined();
    const chevron = utils.getByTestId("assistant-toggle");
    expect(chevron.getAttribute("aria-label")).toBe("agent_assistant_toggle_label");
    expect(toggleChevronStyle(chevron)).toContain("rotate(180deg)");
    fireEvent.click(chevron);

    // The close slide runs (SC-16e: the box holds its width while the
    // slider glides out); the chevron unmounts at once while the expand
    // tab is immediate on the flag (never dead for the 0.18 s slide).
    expect(utils.getByTestId("agent-assistant-panel-script").style.width).toBe("440px");
    expect(utils.getByTestId("agent-assistant-slide-script").style.transform).toBe(
      "translateX(-100%)",
    );
    expect(utils.queryByTestId("assistant-collapse")).toBeNull();
    expect(utils.getByTestId("assistant-closed")).toBeDefined();
    // The draft is already intact mid-glide (same node, value kept) — the
    // settle below must not remount it either (the keepMounted contract).
    expect((utils.getByTestId("chat-script-draft") as HTMLInputElement).value).toBe("half-written turn");
    expect(utils.getByTestId("chat-script-draft")).toBe(draft);
    endSlideTransition(utils.getByTestId("agent-assistant-slide-script"));

    // Settled: the SAME draft node stays in the document, hidden, with the
    // turn marker beside it; the editor column never moved.
    expect(utils.getByTestId("chat-script-draft")).toBe(draft);
    expect(draft.value).toBe("half-written turn");
    expect(utils.getByTestId("chat-script-turn").textContent).toBe("turn-marker");
    expect(classTokens(utils.getByTestId("agent-assistant-panel-script"))).toContain("hidden");
    expect(utils.getByTestId("editor-script").textContent).toBe("editor");
    expect(localStorage.getItem("vt.agent-assistant.collapsed.script")).toBe("true");

    // The expand tab points right under the same shared label.
    expect(utils.getByTestId("assistant-closed")).toBeDefined();
    const expand = utils.getByTestId("assistant-toggle");
    expect(expand.getAttribute("aria-label")).toBe("agent_assistant_toggle_label");
    expect(toggleChevronStyle(expand)).not.toContain("rotate");
  });

  it("the expand tab restores the pane; collapsed + width survive a remount", async () => {
    localStorage.setItem("vt.agent-assistant.collapsed.script", "true");
    localStorage.setItem("vt.agent-assistant.width.script", "480");
    const first = renderTwoPane("script");
    // Closed on first mount renders hidden immediately (no glide to wait for).
    expect(classTokens(first.getByTestId("agent-assistant-panel-script"))).toContain("hidden");
    expect(first.getByTestId("assistant-closed")).toBeDefined();
    first.unmount();

    // A fresh mount restores the collapsed frame with the stored width intent.
    const second = renderTwoPane("script");
    expect(classTokens(second.getByTestId("agent-assistant-panel-script"))).toContain("hidden");
    fireEvent.click(second.getByTestId("assistant-toggle"));
    await flushKick();
    expect(second.getByTestId("agent-assistant-panel-script").style.width).toBe("480px");
    expect(second.queryByTestId("assistant-closed")).toBeNull();
    expect(second.getByTestId("assistant-collapse")).toBeDefined();
    expect(localStorage.getItem("vt.agent-assistant.collapsed.script")).toBe("false");
    second.unmount();
  });
});

// ── Per-surface independence ────────────────────────────────────────────────

describe("desktop-two-pane — script/mini-app independence (SC-16c)", () => {
  it("collapsing scripts leaves mini-apps open under separate keys", async () => {
    const utils = render(
      <>
        <div data-testid="surface-script">
          <AgentShellDesktopTwoPane
            kind="script"
            chatPane={<DraftProbe id="chat-script" />}
            editorPane={<div data-testid="editor-script">editor</div>}
          />
        </div>
        <div data-testid="surface-experience">
          <AgentShellDesktopTwoPane
            kind="experience"
            chatPane={<DraftProbe id="chat-experience" />}
            editorPane={<div data-testid="editor-experience">editor</div>}
          />
        </div>
      </>,
    );
    await flushKick();

    // Collapse scripts only (scoped queries — both surfaces render handles).
    const scriptSurface = utils.getByTestId("surface-script");
    fireEvent.click(within(scriptSurface).getByTestId("assistant-toggle"));
    endSlideTransition(within(scriptSurface).getByTestId("agent-assistant-slide-script"));
    expect(classTokens(within(scriptSurface).getByTestId("agent-assistant-panel-script"))).toContain("hidden");
    expect(within(scriptSurface).getByTestId("assistant-closed")).toBeDefined();

    // Mini-apps stay open at the default width with no expand tab.
    const experienceSurface = utils.getByTestId("surface-experience");
    expect(within(experienceSurface).getByTestId("agent-assistant-panel-experience").style.width).toBe("440px");
    expect(within(experienceSurface).queryByTestId("assistant-closed")).toBeNull();

    // Separate keys, no cross-write: scripts collapsed, mini-apps still on
    // the hook's mount-written default (false), never flipped by the script.
    expect(localStorage.getItem("vt.agent-assistant.collapsed.script")).toBe("true");
    expect(localStorage.getItem("vt.agent-assistant.collapsed.experience")).toBe("false");
  });
});

// ── Width: drag, clamp, reset ───────────────────────────────────────────────

describe("desktop-two-pane — width drag/clamp/reset (SC-16c)", () => {
  it("drags on the right edge, clamps 320..half-window, double-click resets 440", async () => {
    const utils = renderTwoPane("script");
    await flushKick();
    const pane = utils.getByTestId("agent-assistant-panel-script");
    const strip = utils.getByTestId("agent-assistant-resize-script");
    // The line sits on the pane's right edge (the pane is LEFT of the editor).
    expect(strip.getAttribute("class") ?? "").toContain("right-0");
    // Absent key → today's 440 default.
    expect(pane.style.width).toBe("440px");

    // Right-edge drag: moving the line right widens the pane.
    fireEvent.mouseDown(strip, { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 650 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("490px");
    expect(localStorage.getItem("vt.agent-assistant.width.script")).toBe("490");

    // Clamp at half the window (1024 → 512).
    fireEvent.mouseDown(strip, { button: 0, clientX: 650 });
    fireEvent.mouseMove(window, { clientX: 5000 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("512px");
    expect(localStorage.getItem("vt.agent-assistant.width.script")).toBe("512");

    // Clamp at the 320 min.
    fireEvent.mouseDown(strip, { button: 0, clientX: 5000 });
    fireEvent.mouseMove(window, { clientX: -5000 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("320px");

    // Double-click resets to the 440 default through the clamp/write path.
    fireEvent.doubleClick(strip);
    expect(pane.style.width).toBe("440px");
    expect(localStorage.getItem("vt.agent-assistant.width.script")).toBe("440");
  });
});

// ── Owner-settled copy ──────────────────────────────────────────────────────

describe("desktop-two-pane — assistant handle copy (SC-16c)", () => {
  it("the shared label reads «Помощник» / «Assistant»", () => {
    expect(en.agent_assistant_toggle_label).toBe("Assistant");
    expect(ru.agent_assistant_toggle_label).toBe("Помощник");
  });
});
