/**
 * selectAgentLiveAsk (AP-5, AGENT_SHELL_POLISH) — the ONE pure derivation of
 * "the thread's live awaiting ask": the `ask_user` call the main composer
 * answers while it exists. Pins every card state on BOTH activity sources
 * (the live feed — the current turn — and the persisted history fallback a
 * reload / thread switch leaves), the optimistic-override resolution, the
 * no-stream gate, and the ask-family-only rule (a waiting permission card is
 * answered by its own buttons, never by the composer).
 */
import { describe, expect, it } from "bun:test";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { selectAgentLiveAsk } from "./agent-live-ask.js";

const ASK = {
  question: "Which buffer owns the counter?",
  options: ["Rules", "Visual"],
  recommended: "Rules",
} as const;

/** A feed text segment (not an activity — never a last-activity candidate). */
const TEXT = (id: string) => ({ kind: "text" as const, id, text: "Some text", closed: true });

/** The four ask card states as activities (`data-state` derives from these). */
/** The controller's optimistic-override payload shape (structural — the
 *  selector reads only toolCallId; passing the FULL shape proves the real
 *  controller payload flows through without a components import). */
interface AskOverride {
  toolCallId: string;
  status: "answered" | "skipped";
  answer?: string;
}

function overrideResolved(toolCallId: string, answer = "Rules"): AskOverride {
  return { toolCallId, status: "answered", answer };
}

function askActivity(
  toolCallId: string,
  status: "awaiting_answer" | "answered" | "skipped",
): Parameters<typeof selectAgentLiveAsk>[0]["activities"][number] {
  return {
    toolCallId,
    toolName: "ask_user",
    status: "done",
    ask: {
      ...ASK,
      status,
      ...(status === "answered" ? { answer: "Rules" } : {}),
    },
  };
}

function permissionActivity(
  toolCallId: string,
): Parameters<typeof selectAgentLiveAsk>[0]["activities"][number] {
  return {
    toolCallId,
    toolName: "read_message_prompt",
    status: "done",
    permission: {
      status: "awaiting_permission",
      variantNumber: 2,
      replyFirstLine: "First line of the swipe",
      promptTokens: 1234,
    },
  };
}

function runActivity(
  toolCallId: string,
): Parameters<typeof selectAgentLiveAsk>[0]["activities"][number] {
  return { toolCallId, toolName: "run_test", status: "done", summary: "ok" };
}

// ─── Wire fixtures (the history source) ─────────────────────────────────────

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "",
    ...over,
  };
}

function askCarrier(toolCallId: string): ExperienceCopilotMessageWire {
  return message({
    id: `carrier-${toolCallId}`,
    role: "assistant",
    content: "",
    toolCallsJson: JSON.stringify([
      { type: "tool-call", toolCallId, toolName: "ask_user", input: { ...ASK } },
    ]),
  });
}

function askRow(toolCallId: string, output: unknown): ExperienceCopilotMessageWire {
  return message({
    id: `row-${toolCallId}`,
    role: "tool",
    toolCallId,
    content: JSON.stringify({ toolName: "ask_user", output }),
  });
}

function writeRow(toolCallId: string): ExperienceCopilotMessageWire {
  return message({
    id: `row-${toolCallId}`,
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      toolName: "write_buffer",
      output: { target: "rules", proposed: "# R1", summary: "wrote" },
    }),
  });
}

function permCarrierRow(toolCallId: string): ExperienceCopilotMessageWire[] {
  return [
    message({
      id: `carrier-${toolCallId}`,
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify([
        { type: "tool-call", toolCallId, toolName: "read_message_prompt", input: { position: 7, variant: 2 } },
      ]),
    }),
    message({
      id: `row-${toolCallId}`,
      role: "tool",
      toolCallId,
      content: JSON.stringify({
        toolName: "read_message_prompt",
        output: {
          status: "awaiting_permission",
          position: 7,
          variantNumber: 2,
          replyFirstLine: "First line of the swipe",
          promptTokens: 1234,
        },
      }),
    }),
  ];
}

const EMPTY = {
  feed: [],
  activities: [],
  messages: [],
  pendingAskAnswer: null,
  isSending: false,
} as const;

// ─── The live feed path (the current turn) ──────────────────────────────────

describe("selectAgentLiveAsk — live feed (the current turn)", () => {
  it("returns the awaiting ask when it is the thread's last activity", () => {
    const activity = askActivity("tc-ask", "awaiting_answer");
    const live = selectAgentLiveAsk({
      ...EMPTY,
      activities: [activity],
      feed: [{ kind: "activity", id: "tc-ask" }],
    });
    expect(live).toBe(activity);
  });

  it("an answered ask is not live (the composer send after it is a normal message)", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "answered")],
        feed: [{ kind: "activity", id: "tc-ask" }],
      }),
    ).toBeNull();
  });

  it("a skipped ask is not live", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "skipped")],
        feed: [{ kind: "activity", id: "tc-ask" }],
      }),
    ).toBeNull();
  });

  it("an awaiting ask with a later feed activity is expired (the user moved on)", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "awaiting_answer"), runActivity("tc-run")],
        feed: [
          { kind: "activity", id: "tc-ask" },
          { kind: "activity", id: "tc-run" },
        ],
      }),
    ).toBeNull();
  });

  it("a trailing TEXT segment does not expire the ask (text is not an activity)", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "awaiting_answer")],
        feed: [{ kind: "activity", id: "tc-ask" }, TEXT("text-1")],
      }),
    ).not.toBeNull();
  });

  it("no ask is live while a stream runs (isSending)", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        isSending: true,
        activities: [askActivity("tc-ask", "awaiting_answer")],
        feed: [{ kind: "activity", id: "tc-ask" }],
      }),
    ).toBeNull();
  });

  it("the optimistic override that resolved the ask clears it (a chip click just happened)", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "awaiting_answer")],
        feed: [{ kind: "activity", id: "tc-ask" }],
        pendingAskAnswer: overrideResolved("tc-ask"),
      }),
    ).toBeNull();
  });

  it("the optimistic override for a DIFFERENT ask does not clear this one", () => {
    const activity = askActivity("tc-ask", "awaiting_answer");
    const staleOverride: AskOverride = { toolCallId: "tc-stale", status: "answered", answer: "older ask" };
    const live = selectAgentLiveAsk({
      ...EMPTY,
      activities: [activity],
      feed: [{ kind: "activity", id: "tc-ask" }],
      pendingAskAnswer: staleOverride,
    });
    expect(live).toBe(activity);
  });

  it("an awaiting permission card is never the composer's ask (ask_user family only)", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [permissionActivity("tc-perm")],
        feed: [{ kind: "activity", id: "tc-perm" }],
      }),
    ).toBeNull();
  });

  it("a dangling last activity ref (no activity behind it) blocks the fallback", () => {
    // The slot is occupied by the unresolved ref — no earlier ask is live.
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "awaiting_answer")],
        feed: [{ kind: "activity", id: "tc-ask" }, { kind: "activity", id: "tc-gone" }],
      }),
    ).toBeNull();
  });
});

// ─── The history fallback (reload / thread switch leaves the ask persisted) ──

describe("selectAgentLiveAsk — history fallback (reload / thread switch)", () => {
  it("returns the persisted awaiting ask when it is the last history activity", () => {
    const live = selectAgentLiveAsk({
      ...EMPTY,
      messages: [
        message({ id: "u1", role: "user", content: "plan it" }),
        askCarrier("tc-ask"),
        askRow("tc-ask", { status: "awaiting_answer", ...ASK }),
      ],
    });
    expect(live?.toolCallId).toBe("tc-ask");
    expect(live?.ask?.status).toBe("awaiting_answer");
    expect(live?.ask?.question).toBe(ASK.question);
  });

  it("persisted answered and skipped rows are not live", () => {
    const answered = selectAgentLiveAsk({
      ...EMPTY,
      messages: [
        message({ id: "u1", role: "user", content: "plan it" }),
        askCarrier("tc-ask"),
        askRow("tc-ask", { status: "answered", answer: "Rules" }),
      ],
    });
    expect(answered).toBeNull();

    const skipped = selectAgentLiveAsk({
      ...EMPTY,
      messages: [
        message({ id: "u1", role: "user", content: "plan it" }),
        askCarrier("tc-ask"),
        askRow("tc-ask", { status: "skipped" }),
      ],
    });
    expect(skipped).toBeNull();
  });

  it("a later history activity expires the persisted awaiting ask", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        messages: [
          message({ id: "u1", role: "user", content: "plan it" }),
          askCarrier("tc-ask"),
          askRow("tc-ask", { status: "awaiting_answer", ...ASK }),
          message({ id: "u2", role: "user", content: "never mind" }),
          writeRow("tc-write"),
        ],
      }),
    ).toBeNull();
  });

  it("a persisted awaiting permission row is never the composer's ask", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        messages: [
          message({ id: "u1", role: "user", content: "check the swipe" }),
          ...permCarrierRow("tc-perm"),
        ],
      }),
    ).toBeNull();
  });

  it("empty feed + empty messages → no live ask", () => {
    expect(selectAgentLiveAsk({ ...EMPTY })).toBeNull();
  });

  it("the live feed WINS: any live activity entry shadows the history ask", () => {
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [runActivity("tc-run")],
        feed: [{ kind: "activity", id: "tc-run" }],
        messages: [
          message({ id: "u1", role: "user", content: "plan it" }),
          askCarrier("tc-ask"),
          askRow("tc-ask", { status: "awaiting_answer", ...ASK }),
        ],
      }),
    ).toBeNull();
  });

  it("history rows the live store already owns are skipped (the list's dedupe)", () => {
    // After settle+refetch the latest turn exists in BOTH sources. Here the
    // live store owns the ask row but its feed ref is gone (the state a
    // cleared feed leaves behind): the history pass must skip the owned row
    // and settle on the last unowned activity — the write_buffer, not the ask.
    expect(
      selectAgentLiveAsk({
        ...EMPTY,
        activities: [askActivity("tc-ask", "awaiting_answer")],
        messages: [
          message({ id: "u1", role: "user", content: "plan it" }),
          writeRow("tc-write"),
          askCarrier("tc-ask"),
          askRow("tc-ask", { status: "awaiting_answer", ...ASK }),
        ],
      }),
    ).toBeNull();
  });
});
