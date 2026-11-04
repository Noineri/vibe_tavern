import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installAgentMessageMarkdownSeam } from "../../../../test/agent-message-markdown-seam.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";
import { agentThreadKey } from "../../../lib/agent-host-registry.js";

useDomEnv();

// AFP-1 (AGENT_FEED_PERFORMANCE_PLAN, Wave 1 step 1): characterization of the
// PRE-PORT flat feed. The pins below define the preservation contract the
// virtualization port (AFP-2..AFP-6) must keep byte-stable: event-separator
// anchoring, the composite row/card/separator document order, the
// regenerate cut covering anchored separators, the pre-port bottom-pinning
// semantics, and DOM identity across a settle-refetch-shaped rerender.
// The flat-mount baseline at the bottom documents the DEFECT itself and is
// superseded deliberately by AFP-6's agent-feed-virtualization.test.tsx —
// never "fixed" early, never kept after the port lands.
//
// CO-LOAD CONTRACT (i18n-context-seam family): provider-less pins echo raw
// keys — the identity spec, same registration as AgentMessageList.test.tsx
// (a co-loaded file registering a params-appending spec would rewrite these
// labels; the identity seam is this file's OWN registration).
installI18nContextSeam();

// CO-LOAD CONTRACT (react-markdown-seam discipline): the shared agent
// markdown seam — same registration as AgentMessageList.test.tsx / the
// block suite, so hand-bundled co-loads render the real variant classes.
installAgentMessageMarkdownSeam();

// CustomTooltip (Radix) never anchors under happy-dom — the ask card's
// recommended chip is wrapped in it. Same `...real`-spread mock as the
// sibling suites (R4 shape; the loaded graph pulls TooltipProvider since
// CA-4f, a factory without the spread would break co-loaded importers).
const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;
let AgentMessageList: typeof import("./AgentMessageList.js").AgentMessageList;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
  // Tool cards resolve target labels through the registered host
  // descriptor — the real experience host registers kind "experience"
  // (same side-effect import as AgentMessageList.test.tsx).
  await import("../../build/editors/copilot/experience-agent-host.js");
  ({ AgentMessageList } = await import("./AgentMessageList.js"));
});

beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
  useAgentLiveStreamStore.setState({ liveByThread: {} });
});

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
    ...over,
  };
}

// ─── Event wire fixtures (agent-thread-event-schema shapes) ─────────────────

function rpSyncEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return {
    id,
    kind: "rp_sync",
    beforeMessageId,
    payload: {
      fromPosition: 0,
      toPosition: 2,
      messages: [
        {
          id: "rp1", position: 0, role: "user", authorName: null, variantId: null,
          model: null, preset: null, text: "The café hums with evening chatter",
        },
        {
          id: "rp2", position: 1, role: "assistant", authorName: "Mira", variantId: null,
          model: null, preset: null, text: "She stirs her latte, watching the door",
        },
      ],
    },
  };
}

function branchForkedEvent(id: string): AgentThreadEventWire {
  return { id, kind: "branch_forked", beforeMessageId: null, payload: { at: 12 } };
}

function selectionChangedEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return {
    id,
    kind: "selection_changed",
    beforeMessageId,
    payload: {
      messageId: "rp2",
      position: 1,
      previous: { variantId: "v1", text: "first draft", model: null, preset: null },
      current: { variantId: "v2", text: "second draft", model: null, preset: null },
    },
  };
}

// ─── Order-reading helper ────────────────────────────────────────────────────
// One union selector over every top-level feed item the port must keep in
// this relative order; labels prefer data-role (digest rows carry both
// data-role and the separator testid — the role wins so a digest never
// masquerades as an event separator in the pin).
function feedOrder(container: HTMLElement): string[] {
  const els = container.querySelectorAll(
    '[data-role], [data-testid="timeline-separator"], [data-testid="copilot-tool-accordion"], ' +
    '[data-testid="copilot-ask-card"], [data-testid="copilot-permission-card"], ' +
    '[data-testid="copilot-host-caption"]',
  );
  return Array.from(els).map((el) => {
    const role = el.getAttribute("data-role");
    if (role) return `role:${role}`;
    switch (el.getAttribute("data-testid")) {
      case "timeline-separator": return `event:${el.getAttribute("data-kind")}`;
      case "copilot-tool-accordion": return "accordion";
      case "copilot-ask-card": return "ask";
      case "copilot-permission-card": return "permission";
      case "copilot-host-caption": return "caption";
      default: return "other";
    }
  });
}

// ─── SC-19b: frozen events as separators (the events prop path) ─────────────

describe("AgentMessageList characterization — event separators (AFP-1)", () => {
  it("anchored events render immediately BEFORE their anchor message, in events order", () => {
    const { container } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first question" }),
          message({ id: "a1", role: "assistant", content: "first answer" }),
          message({ id: "u2", role: "user", content: "second question" }),
          message({ id: "a2", role: "assistant", content: "second answer" }),
        ]}
        pendingUserContent=""
        events={[rpSyncEvent("e-rp", "u2"), selectionChangedEvent("e-sel", "u1")]}
      />,
    );

    expect(feedOrder(container)).toEqual([
      "event:selection_changed",
      "role:user",
      "caption",
      "role:assistant",
      "event:rp_sync",
      "role:user",
      "caption",
      "role:assistant",
    ]);
  });

  it("null-anchor and unknown-anchor events trail at the end, before the optimistic pending row", () => {
    const { container } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first question" }),
          message({ id: "a1", role: "assistant", content: "first answer" }),
          message({ id: "u2", role: "user", content: "second question" }),
          message({ id: "a2", role: "assistant", content: "second answer" }),
        ]}
        pendingUserContent="typing a third…"
        events={[branchForkedEvent("e-branch"), rpSyncEvent("e-orphan", "no-such-row")]}
      />,
    );

    // Trailing events keep their events-array order and land AFTER every
    // persisted row but BEFORE the optimistic user bubble (the module
    // contract: pending rows only exist mid-turn, events refresh on settle).
    expect(feedOrder(container)).toEqual([
      "role:user",
      "caption",
      "role:assistant",
      "role:user",
      "caption",
      "role:assistant",
      "event:branch_forked",
      "event:rp_sync",
      "role:user",
    ]);
  });

  it("an event anchored to a replaced assistant row hides with it (flag AND id-set cuts); trailing events stay", () => {
    const messages = [
      message({ id: "u1", role: "user", content: "first question" }),
      message({ id: "a1", role: "assistant", content: "first answer" }),
      message({ id: "u2", role: "user", content: "go" }),
      message({ id: "a2", role: "assistant", content: "replaced reply" }),
    ];
    const events = [rpSyncEvent("e-anchor", "a2"), branchForkedEvent("e-trail")];

    // The in-flight regenerate flag: the anchored separator rides its
    // anchor's fragment, so the one cut covers it.
    const byFlag = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={messages} pendingUserContent=""
        isRegenerating events={events}
      />,
    );
    expect(feedOrder(byFlag.container)).toEqual([
      "role:user",
      "caption",
      "role:assistant",
      "role:user",
      "event:branch_forked",
    ]);
    byFlag.unmount();

    // The post-settle id hide (AP-29 follow-up 3): same fragment coverage.
    const byIds = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={messages} pendingUserContent=""
        hiddenRegeneratedIds={["a2"]} events={events}
      />,
    );
    expect(feedOrder(byIds.container)).toEqual([
      "role:user",
      "caption",
      "role:assistant",
      "role:user",
      "event:branch_forked",
    ]);
  });
});

// ─── Composite document order: every item kind in ONE pin ───────────────────

describe("AgentMessageList characterization — composite order (AFP-1)", () => {
  it("two turns with tools, a permission, an ask, an anchored event and a digest keep the full order", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        pendingUserContent=""
        onAnswer={() => {}}
        events={[rpSyncEvent("e-rp", "u2"), branchForkedEvent("e-branch"), selectionChangedEvent("e-sel", "missing")]}
        messages={[
          // Turn 1: user → hidden tool carrier → tool row → text reply.
          message({ id: "u1", role: "user", content: "first question" }),
          message({
            id: "carrier1", role: "assistant", content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
            ]),
          }),
          message({
            id: "tool1", role: "tool", toolCallId: "c1",
            content: JSON.stringify({
              toolName: "write_buffer",
              output: { target: "rules", proposed: "# R1", summary: "first pass" },
            }),
          }),
          message({ id: "a1", role: "assistant", content: "first reply" }),
          // Turn 2: user → permission card → ask card → text reply.
          message({ id: "u2", role: "user", content: "second question" }),
          message({
            id: "carrier2", role: "assistant", content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "c-perm", toolName: "read_message_prompt", input: { position: 5 } },
            ]),
          }),
          message({
            id: "toolp", role: "tool", toolCallId: "c-perm",
            content: JSON.stringify({
              toolName: "read_message_prompt",
              output: {
                status: "awaiting_permission", position: 5, variantNumber: 2,
                replyFirstLine: "She smiles at the barista", promptTokens: 1200,
              },
            }),
          }),
          message({
            id: "carriera", role: "assistant", content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "tc-ask", toolName: "ask_user", input: { question: "Which buffer?" } },
            ]),
          }),
          message({
            id: "toola", role: "tool", toolCallId: "tc-ask",
            content: JSON.stringify({
              toolName: "ask_user",
              output: { status: "awaiting_answer", question: "Which buffer?", options: ["Rules", "Visual"] },
            }),
          }),
          message({ id: "a4", role: "assistant", content: "second reply" }),
          // The compaction digest, appended at its chronological slot.
          message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
        ]}
      />,
    );

    // Turn 1: caption sits above the turn's accordion (TA-1), then the
    // text. Turn 2: caption above the anchored card cluster — permission
    // then ask, in pending-accumulation order — then the text. The digest
    // lands at its own slot; trailing events (null + unknown anchor)
    // follow, in events order.
    expect(feedOrder(getByTestId("copilot-message-list"))).toEqual([
      "role:user",
      "caption",
      "accordion",
      "role:assistant",
      "event:rp_sync",
      "role:user",
      "caption",
      "permission",
      "ask",
      "role:assistant",
      "role:digest",
      "event:branch_forked",
      "event:selection_changed",
    ]);
    // The ask is the thread's last tool activity and no later user row
    // follows → still answerable (TAG-9). The permission is expired by the
    // later ask activity (SC-23f's last-activity rule) but still renders.
    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("awaiting");
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("expired");
  });
});

// ─── Bottom-pinning semantics of the pre-port scroller (CNR-8h follow-up) ────

describe("AgentMessageList characterization — bottom pin (AFP-1)", () => {
  function fourTurnThread() {
    return [
      message({ id: "u1", role: "user", content: "one" }),
      message({ id: "a1", role: "assistant", content: "answer one" }),
      message({ id: "u2", role: "user", content: "two" }),
      message({ id: "a2", role: "assistant", content: "answer two" }),
    ];
  }

  function withRows(n: number) {
    const rows: ExperienceCopilotMessageWire[] = [];
    for (let i = 1; i <= n / 2; i++) {
      rows.push(message({ id: `u${i}`, role: "user", content: `question ${i}` }));
      rows.push(message({ id: `a${i}`, role: "assistant", content: `answer ${i}` }));
    }
    return rows;
  }

  it("content growth follows while pinned; a scrolled-up reader is never yanked down", async () => {
    const view = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={fourTurnThread()} pendingUserContent=""
      />,
    );
    const list = view.getByTestId("copilot-message-list");
    const area = list.querySelector("[data-scroll-area]")! as HTMLElement;
    expect(area.getAttribute("data-scroll-area")).toBe("thin");
    const viewport = area.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    // Fake a tall feed (happy-dom has no layout) — the same geometry trick
    // as the CNR-8h pin.
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });

    // Reader at the bottom (mount pins by default; the scroll handler
    // confirms the pin from the real geometry).
    await act(async () => {
      viewport.scrollTop = 1000;
      fireEvent.scroll(viewport);
    });
    expect(viewport.scrollTop).toBe(1000);

    // Growth while pinned → the view follows to the new bottom.
    view.rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={withRows(6)} pendingUserContent=""
      />,
    );
    expect(viewport.scrollTop).toBe(1000);

    // Reader scrolls up → unpinned; the jump affordance appears.
    await act(async () => {
      viewport.scrollTop = 0;
      fireEvent.scroll(viewport);
    });
    expect(viewport.scrollTop).toBe(0);
    const jumpButton = view.container.querySelector<HTMLButtonElement>("button.absolute");
    expect(jumpButton).not.toBeNull();

    // Further growth while away → NO yank (the reader keeps their place).
    view.rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={withRows(8)} pendingUserContent=""
      />,
    );
    expect(viewport.scrollTop).toBe(0);

    // The jump re-pins and returns to the bottom (the CNR-8h contract).
    await act(async () => {
      fireEvent.click(jumpButton!);
    });
    expect(viewport.scrollTop).toBe(1000);
  });
});

// ─── DOM identity across a settle-refetch-shaped rerender ────────────────────

describe("AgentMessageList characterization — row identity (AFP-1)", () => {
  it("a refetch rerender (new array, new object identities, same ids) keeps existing rows' DOM nodes", () => {
    const view = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first question" }),
          message({ id: "a1", role: "assistant", content: "first answer" }),
          message({ id: "u2", role: "user", content: "second question" }),
          message({ id: "a2", role: "assistant", content: "second answer" }),
        ]}
        pendingUserContent=""
      />,
    );
    // Read the invariant targets NOW (R10 — no async remounts in this file).
    const firstQuestion = view.getByText("first question");
    const firstAnswer = view.getByText("first answer");

    // The settle refetch arrives as a whole new array of fresh objects
    // (transport.listMessages → setState), with one appended row.
    view.rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first question" }),
          message({ id: "a1", role: "assistant", content: "first answer" }),
          message({ id: "u2", role: "user", content: "second question" }),
          message({ id: "a2", role: "assistant", content: "second answer" }),
          message({ id: "a3", role: "assistant", content: "third answer" }),
        ]}
        pendingUserContent=""
      />,
    );

    // Key-stable rows survive the refetch: the SAME DOM nodes stay mounted
    // (the message-id key owns them), and the appended row renders after.
    expect(view.container.contains(firstQuestion)).toBe(true);
    expect(view.container.contains(firstAnswer)).toBe(true);
    expect(view.getByText("third answer")).toBeDefined();
  });
});

// ─── Flat-mount baseline: the defect, measured (superseded by AFP-6) ────────

describe("AgentMessageList characterization — flat mount baseline (AFP-1)", () => {
  it("every persisted row mounts today — a 160-row thread renders 160 data-role elements", () => {
    const rows: ExperienceCopilotMessageWire[] = [];
    for (let i = 1; i <= 80; i++) {
      rows.push(message({ id: `u${i}`, role: "user", content: `question ${i}` }));
      rows.push(message({ id: `a${i}`, role: "assistant", content: `answer ${i}` }));
    }
    const { container } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={rows} pendingUserContent=""
      />,
    );

    // THE DEFECT, pinned: the flat `.map()` mounts the WHOLE thread — DOM
    // grows linearly with history, which is exactly what AFP-6 replaces
    // with a windowed mount. This pin is DELIBERATELY replaced by
    // agent-feed-virtualization.test.tsx when the port lands — it exists
    // so the port's diff is reviewable against a mechanical baseline.
    expect(container.querySelectorAll("[data-role]")).toHaveLength(160);
  });
});
