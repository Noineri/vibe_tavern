/**
 * ExperienceCopilotMessageBlock digest-card tests (CM-9) — pins the collapsed
 * compaction-digest card: collapsed by default, expands on click, and derives
 * its caption count from `coveredCount`. The user/assistant bubble path is
 * covered by the message-list test; this file isolates the role-dispatch.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentMessageAction } from "../../../lib/agent-host-registry.js";

useDomEnv();

// Markdown is heavy and pinned elsewhere; the digest card renders the raw
// summary text (not through Markdown), but the block still imports it — stub it
// so the digest path has a deterministic DOM. The stub surfaces the variant
// prop as `data-variant` so the AP-2 markup tests pin the block→variant map.
const realMarkdown = await import("../../../lib/markdown.js");
mock.module("../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text, variant }: { text: string; variant?: string }) => (
    <div data-variant={variant}>{text}</div>
  ),
}));

// Mutable viewport override (the SC-16 row branches on it) — same pattern as
// sidechat-host.test.tsx so both halves agree.
let mobileOverride = false;
const realMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

// Radix Tooltip never anchors under happy-dom — render children inline (the
// same mock the message-list test uses; this file pins the row, not tooltips).
const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentMessageBlock: typeof import("./AgentMessageBlock.js").AgentMessageBlock;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentMessageBlock } = await import("./AgentMessageBlock.js"));
  // The sidechat host self-registers on import (module-load registration) —
  // the wiring test below resolves its declared action by kind.
  await import("../../chat/sidechat/sidechat-host.js");
});

beforeEach(() => {
  mobileOverride = false;
});

function digestMsg(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return {
    id: "d1",
    threadId: "thread-1",
    role: "digest",
    content: "Earlier context was compacted: the rules buffer gained a `score` action.",
    toolCallsJson: null,
    toolCallId: "u3",
    createdAt: "2026-08-15T10:00:00.000Z",
    ...over,
  };
}

describe("ExperienceCopilotMessageBlock — digest card (CM-9)", () => {
  it("renders a collapsed digest card by default (summary hidden)", () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <AgentMessageBlock messageMarkup="plain" message={digestMsg()} coveredCount={3} />,
    );

    expect(getByTestId("copilot-digest-card")).toBeDefined();
    expect(getByText("copilot_context_digest_title")).toBeDefined();
    // Collapsed → summary body absent.
    expect(queryByTestId("copilot-digest-card-body")).toBeNull();
  });

  it("expands on click to reveal the summary text and collapses again", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={digestMsg()} coveredCount={3} />,
    );

    fireEvent.click(getByTestId("copilot-digest-card-toggle"));
    expect(queryByTestId("copilot-digest-card-body")).not.toBeNull();
    expect(getByTestId("copilot-digest-card-body").textContent).toContain("rules buffer");

    fireEvent.click(getByTestId("copilot-digest-card-toggle"));
    expect(queryByTestId("copilot-digest-card-body")).toBeNull();
  });

  it("carries the covered count on the card for the caption", () => {
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={digestMsg()} coveredCount={12} />,
    );

    expect(getByTestId("copilot-digest-card-toggle").getAttribute("data-covered-count")).toBe("12");
  });

  it("renders an assistant bubble for a normal assistant message (no digest chrome)", () => {
    const { queryByTestId, getByText } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={{ ...digestMsg(), id: "a1", role: "assistant", toolCallId: null }}
      />,
    );

    expect(queryByTestId("copilot-digest-card")).toBeNull();
    expect(getByText("Earlier context was compacted: the rules buffer gained a `score` action.")).toBeDefined();
  });

  it("returns nothing for an empty assistant tool-call carrier turn", () => {
    const { container } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={{ ...digestMsg(), id: "a2", role: "assistant", content: "" }}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});

// ─── SC-16: the host's message-action row ───────────────────────────────────
// A host-declared action renders under ASSISTANT bubbles only (desktop:
// hover/focus-within reveal, cloned from the RP row; mobile: always-visible
// 44px button). Hosts that declare none render byte-identically.

function assistantMsg(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return {
    id: "a1",
    threadId: "thread-1",
    role: "assistant",
    content: "Consider asking about her brother",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "",
    ...over,
  };
}

function fixtureAction(onSelect: (text: string) => void): AgentMessageAction {
  return {
    labelKey: "copy",
    icon: () => (
      <svg data-testid="fixture-action-icon" />
    ),
    onSelect,
    testId: "fixture-action",
  };
}

describe("ExperienceCopilotMessageBlock — message actions (SC-16)", () => {
  it("renders the action row under an assistant bubble (desktop hover/focus reveal chrome)", () => {
    const seen: string[] = [];
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[fixtureAction((text) => seen.push(text))]} />,
    );

    const row = getByTestId("copilot-message-actions");
    expect(row).toBeDefined();
    // The reveal row clones the RP desktop container + the focus-within arm
    // the owner quote settles (hover AND keyboard focus).
    const reveal = row.firstElementChild!;
    expect(reveal.className).toContain("opacity-0");
    expect(reveal.className).toContain("group-hover:opacity-100");
    expect(reveal.className).toContain("focus-within:opacity-100");
    // Icon-only button with the label as its accessible name (the tooltip
    // content is mocked to children — the aria-label carries the assertion).
    const button = getByTestId("fixture-action");
    expect(button.getAttribute("aria-label")).toBe("copy");
    expect(button.className).toContain("px-[7px]");
    expect(getByTestId("fixture-action-icon")).toBeDefined();
  });

  it("action row sits INSIDE the .group message row so desktop group-hover fires", () => {
    const { container, getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[fixtureAction(() => {})]} />,
    );

    const row = container.querySelector("[data-role='assistant']");
    expect(row).not.toBeNull();
    // The row carries .group exactly when actions exist.
    expect(row!.className).toContain("group");
    // The action row is a DESCENDANT of the .group row (group-hover matches
    // descendants only — as a sibling the desktop reveal never fired).
    const actionsEl = getByTestId("copilot-message-actions");
    expect(row!.contains(actionsEl)).toBe(true);
    expect(actionsEl.firstElementChild!.className).toContain("group-hover:opacity-100");
  });

  it("clicking the action forwards the message text", () => {
    const seen: string[] = [];
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[fixtureAction((text) => seen.push(text))]} />,
    );

    fireEvent.click(getByTestId("fixture-action"));
    expect(seen).toEqual(["Consider asking about her brother"]);
  });

  it("renders no row for a user message even when actions are declared", () => {
    const { queryByTestId, getByText } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
        messageActions={[fixtureAction(() => {})]}
      />,
    );

    expect(getByText("What should I say?")).toBeDefined();
    expect(queryByTestId("copilot-message-actions")).toBeNull();
  });

  it("renders no row (byte-identical) when actions are absent or empty", () => {
    const bare = render(<AgentMessageBlock messageMarkup="plain" message={assistantMsg()} />);
    const empty = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[]} />,
    );
    const userShaped = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
        messageActions={[fixtureAction(() => {})]}
      />,
    );

    expect(bare.queryByTestId("copilot-message-actions")).toBeNull();
    expect(empty.container.innerHTML).toBe(bare.container.innerHTML);
    expect(userShaped.queryByTestId("copilot-message-actions")).toBeNull();
  });

  it("mobile renders an always-visible 44px button (no opacity gate)", () => {
    mobileOverride = true;
    const seen: string[] = [];
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[fixtureAction((text) => seen.push(text))]} />,
    );

    const row = getByTestId("copilot-message-actions");
    const reveal = row.firstElementChild!;
    expect(reveal.className).not.toContain("opacity-0");
    const button = getByTestId("fixture-action");
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-11");
    expect(button.getAttribute("aria-label")).toBe("copy");
    fireEvent.click(button);
    expect(seen).toEqual(["Consider asking about her brother"]);
  });

  it("the sidechat host's declared action renders and copies the reply into the RP draft", async () => {
    const { getAgentHost } = await import("../../../lib/agent-host-registry.js");
    const { SIDECHAT_AGENT_KIND } = await import("../../../api/agent-kind-served-modes.js");
    const { useChatStore } = await import("../../../stores/chat-store.js");
    const { useSidechatMobileStore } = await import("../../../stores/sidechat-mobile-store.js");
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.messageActions).toHaveLength(1);
    expect(host.messageActions![0]!.labelKey).toBe("sidechat_copy_to_composer");
    expect(host.messageActions![0]!.testId).toBe("sidechat-copy-to-composer");

    // Non-empty draft: the user is mid-typing — the reply lands on a new line.
    useChatStore.setState({ draft: "Already typed" });
    useSidechatMobileStore.setState({ tab: "sidechat" });
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={host.messageActions} />,
    );
    fireEvent.click(getByTestId("sidechat-copy-to-composer"));
    expect(useChatStore.getState().draft).toBe("Already typed\nConsider asking about her brother");
    expect(useSidechatMobileStore.getState().tab).toBe("chat");
    useChatStore.setState({ draft: "" });
    useSidechatMobileStore.setState({ tab: "chat" });
  });
});

// ─── AP-11: turn actions (copy / regenerate / delete) ─────────────────────
// WAS (characterized pre-change, basis: SC-16 + the AP-11 contract): user
// bubbles NEVER carried an action row (`messageActions` were assistant-only
// and the user branch ignored them); the assistant row held host actions
// only. NOW: a second, role-agnostic `turnActions` prop carries the turn
// actions — user bubbles render them under the bubble (right-aligned),
// assistant bubbles merge them with the host actions in the SAME row
// (host first). Absent/empty = byte-identical to before.

describe("ExperienceCopilotMessageBlock — turn actions (AP-11)", () => {
  it("renders the turn row under a user bubble (right-aligned column, .group for hover reveal)", () => {
    const { container, getByTestId, getByText } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
        turnActions={[fixtureAction(() => {})]}
      />,
    );

    expect(getByText("What should I say?")).toBeDefined();
    const row = container.querySelector("[data-role='user']");
    expect(row).not.toBeNull();
    // WAS flex-row-reverse (bubble-only) → NOW the column stacks the bubble
    // above the row; items-end keeps both right-aligned (mockup §1).
    expect(row!.className).toContain("flex-col");
    expect(row!.className).toContain("items-end");
    expect(row!.className).toContain("group");
    // The bubble stays the first child (bg-user-bg, max-w-[85%]).
    expect(row!.firstElementChild!.className).toContain("bg-user-bg");
    expect(getByTestId("copilot-message-actions")).toBeDefined();
    expect(row!.contains(getByTestId("copilot-message-actions"))).toBe(true);
  });

  it("merges host and turn actions in ONE assistant row (host first)", () => {
    const { container, getByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg()}
        messageActions={[fixtureAction(() => {})]}
        turnActions={[{ ...fixtureAction(() => {}), testId: "turn-action" }]}
      />,
    );

    const rows = container.querySelectorAll('[data-testid="copilot-message-actions"]');
    expect(rows.length).toBe(1);
    const rowHtml = rows[0]!.innerHTML;
    expect(getByTestId("fixture-action")).toBeDefined();
    expect(getByTestId("turn-action")).toBeDefined();
    // Host actions (the sidechat copy-to-composer family) lead; turn actions follow.
    expect(rowHtml.indexOf("fixture-action")).toBeLessThan(rowHtml.indexOf("turn-action"));
  });

  it("user bubbles ignore host actions but render turn actions", () => {
    const { queryByTestId, getByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
        messageActions={[fixtureAction(() => {})]}
        turnActions={[{ ...fixtureAction(() => {}), testId: "turn-action" }]}
      />,
    );

    expect(queryByTestId("fixture-action")).toBeNull();
    expect(getByTestId("turn-action")).toBeDefined();
  });

  it("absent/empty turn actions render byte-identically (no row, old user shape)", () => {
    const bare = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
      />,
    );
    const empty = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
        turnActions={[]}
      />,
    );

    expect(bare.queryByTestId("copilot-message-actions")).toBeNull();
    expect(empty.container.innerHTML).toBe(bare.container.innerHTML);
    // The bubble-only shape keeps the old row-reverse row (no column wrapper).
    expect(bare.container.querySelector("[data-role='user']")!.className).toContain("flex-row-reverse");
  });
});

// ─── AP-4: flat assistant feed ────────────────────────────────────────────
// WAS (characterized pre-restyling, basis: mockup §1 + unit contract): a
// two-column avatar+bubble row — avatar div (h-7 w-7 rounded-full bg-s3) +
// bubble (max-w-[80%] rounded-lg px-3.5 py-2.5, bg-s2 assistant / bg-user-bg
// user), action row offset by the avatar column (pl-[38px]). NOW: the
// assistant renders flat (no avatar, no bubble chrome, full width), the user
// keeps the right-aligned bubble without avatar at max-w-[85%], and the
// action row aligns to the text edge (no offset). Role attributes, the min-w-0
// overflow fix, and the AP-2 Markdown variant mapping are unchanged.

describe("ExperienceCopilotMessageBlock — flat feed shape (AP-4)", () => {
  it("assistant renders flat: no avatar, no bubble chrome, full width (data-role=assistant)", () => {
    const { container } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} />,
    );

    const row = container.querySelector("[data-role='assistant']");
    expect(row).not.toBeNull();
    // WAS two-column flex row (flex-row + gap-2.5) → NOW full-width flat.
    expect(row!.className).not.toContain("flex-row");
    expect(row!.className).not.toContain("gap-2.5");
    expect(row!.className).toContain("min-w-0");
    // WAS avatar div (h-7 w-7 rounded-full bg-s3) → NOW gone.
    expect(row!.querySelector("div.bg-s3")).toBeNull();
    // WAS bubble chrome (bg-s2, max-w-[80%], rounded-lg, px-3.5 py-2.5) → NOW gone.
    expect(row!.querySelector("div.bg-s2")).toBeNull();
    expect(row!.innerHTML).not.toContain("max-w-[80%]");
    expect(row!.innerHTML).not.toContain("rounded-lg");
    // The text keeps the overflow-wrap rules + the AP-2 Markdown variant.
    const text = row!.querySelector("div[class*=\"[overflow-wrap\"]");
    expect(text).not.toBeNull();
    expect(text!.className).toContain("[overflow-wrap:anywhere]");
    expect(container.querySelector("[data-variant]")?.getAttribute("data-variant")).toBe("agent-plain");
  });

  it("user keeps the right-aligned bubble without avatar, max-w-[85%] (data-role=user)", () => {
    const { container } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={assistantMsg({ id: "u1", role: "user", content: "What should I say?" })}
      />,
    );

    const row = container.querySelector("[data-role='user']");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("flex-row-reverse");
    // WAS avatar div → NOW gone.
    expect(row!.querySelector("div.bg-s3")).toBeNull();
    // Bubble stays (bg-user-bg, rounded, padded) — WAS max-w-[80%] → NOW max-w-[85%].
    const bubble = row!.firstElementChild;
    expect(bubble).not.toBeNull();
    expect(bubble!.className).toContain("bg-user-bg");
    expect(bubble!.className).toContain("max-w-[85%]");
    expect(bubble!.className).not.toContain("max-w-[80%]");
    expect(bubble!.className).toContain("rounded-lg");
    expect(bubble!.className).toContain("px-3.5");
  });

  it("action row aligns to the text edge: no avatar-column offset (desktop arm)", () => {
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[fixtureAction(() => {})]} />,
    );

    // WAS pl-[38px] (avatar column) → NOW no left offset.
    expect(getByTestId("copilot-message-actions").className).not.toContain("pl-[38px]");
    expect(getByTestId("copilot-message-actions")).toBeDefined();
  });

  it("action row aligns to the text edge: no avatar-column offset (mobile arm)", () => {
    mobileOverride = true;
    const { getByTestId } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} messageActions={[fixtureAction(() => {})]} />,
    );

    expect(getByTestId("copilot-message-actions").className).not.toContain("pl-[38px]");
    expect(getByTestId("copilot-message-actions")).toBeDefined();
  });
});

// ─── AP-2: per-host message markup ──────────────────────────────────────────
// Each assistant host declares its markup; the block renders the matching
// Markdown variant (`rp-colors` → `agent-rp`, `plain` → `agent-plain`). The
// block's own `em` override is gone — the variants own `em` now — while the
// bubble's overflow-wrap rules stay.

describe("ExperienceCopilotMessageBlock — message markup (AP-2)", () => {
  it("renders the agent-rp variant for rp-colors markup", () => {
    const { container } = render(
      <AgentMessageBlock messageMarkup="rp-colors" message={assistantMsg()} />,
    );

    expect(container.querySelector("[data-variant]")?.getAttribute("data-variant")).toBe("agent-rp");
  });

  it("renders the agent-plain variant for plain markup", () => {
    const { container } = render(
      <AgentMessageBlock messageMarkup="plain" message={assistantMsg()} />,
    );

    expect(container.querySelector("[data-variant]")?.getAttribute("data-variant")).toBe("agent-plain");
  });

  it("owns no em override on the bubble text (the variants own em) but keeps the overflow-wrap rules", () => {
    const { container } = render(
      <AgentMessageBlock messageMarkup="rp-colors" message={assistantMsg()} />,
    );

    const bubble = container.querySelector("div[class*=\"[overflow-wrap\"]");
    expect(bubble).not.toBeNull();
    expect(bubble!.className).toContain("[overflow-wrap:anywhere]");
    expect(bubble!.className).toContain("[&_.md-pre]:[overflow-wrap:normal]");
    expect(bubble!.className).not.toContain("[&_em]");
  });
});
