/**
 * ExperienceCopilotMessageBlock digest-card tests (CM-9) — pins the collapsed
 * compaction-digest card: collapsed by default, expands on click, and derives
 * its caption count from `coveredCount`. The user/assistant bubble path is
 * covered by the message-list test; this file isolates the role-dispatch.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
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
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentMessageBlock: typeof import("./AgentMessageBlock.js").AgentMessageBlock;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
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
    reasoning: null,
    reasoningDurationMs: null,
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
    reasoning: null,
    reasoningDurationMs: null,
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

// ─── AP-12: inline edit of the last own message ─────────────────────────
// WAS (characterized at AP-11, basis: the turn-actions describe above):
// user bubbles carried turn actions but no edit affordance — the row was
// delete-only. NOW: with `canEditLast` (the builder's last-user-row signal)
// plus an `onEditLast` submit path the block prepends an «Изменить» opener;
// clicking it swaps the WHOLE user arm (bubble + row) for the inline editor
// in place, Esc/cancel closes without submitting, submit forwards the draft
// and closes. Absent either prop = exactly as before (no edit button).

function userMsg(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return assistantMsg({ id: "u1", role: "user", content: "What should I say?", ...over });
}

function deleteTurnAction(onSelect: (text: string) => void): AgentMessageAction {
  return {
    labelKey: "delete",
    icon: () => (
      <svg data-testid="turn-delete-icon" />
    ),
    onSelect,
    testId: "copilot-turn-delete",
  };
}

describe("ExperienceCopilotMessageBlock — inline edit (AP-12)", () => {
  it("renders the edit opener FIRST in the last user row (edit before delete)", () => {
    const { container, getByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
        onEditLast={() => {}}
      />,
    );

    const edit = getByTestId("copilot-turn-edit");
    expect(edit.getAttribute("aria-label")).toBe("edit");
    // The opener joins the row ahead of delete (mockup: «Изменить» first).
    const rowHtml = container.querySelector('[data-testid="copilot-message-actions"]')!.innerHTML;
    expect(rowHtml.indexOf("copilot-turn-edit")).toBeLessThan(rowHtml.indexOf("copilot-turn-delete"));
  });

  it("no edit affordance without canEditLast (earlier user rows)", () => {
    const { queryByTestId, getByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        onEditLast={() => {}}
      />,
    );

    expect(queryByTestId("copilot-turn-edit")).toBeNull();
    expect(getByTestId("copilot-turn-delete")).toBeDefined();
  });

  it("no edit affordance without onEditLast (no submit path)", () => {
    const { queryByTestId, getByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
      />,
    );

    expect(queryByTestId("copilot-turn-edit")).toBeNull();
    expect(getByTestId("copilot-turn-delete")).toBeDefined();
  });

  it("clicking edit swaps the bubble for the editor in place (the row hides)", () => {
    const { container, getByTestId, queryByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
        onEditLast={() => {}}
      />,
    );

    fireEvent.click(getByTestId("copilot-turn-edit"));
    // The editor renders in the user row's slot (data-role=user stays —
    // nothing else in the feed moves); the bubble AND the action row hide.
    const row = container.querySelector("[data-role='user']");
    expect(row).not.toBeNull();
    expect(getByTestId("copilot-edit-message")).toBeDefined();
    expect(row!.contains(getByTestId("copilot-edit-message"))).toBe(true);
    expect(queryByTestId("copilot-message-actions")).toBeNull();
    // The user bubble chrome is gone (its text now lives in the editor's
    // textarea — a text query would match there, so pin the bubble's absence
    // by its bg-user-bg box).
    expect(row!.querySelector(".bg-user-bg")).toBeNull();
    expect((getByTestId("copilot-edit-message").querySelector("textarea") as HTMLTextAreaElement).value)
      .toBe("What should I say?");
  });

  it("Escape closes the editor without submitting (the bubble returns)", () => {
    const seen: string[] = [];
    const { getByTestId, getByText } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
        onEditLast={(content) => seen.push(content)}
      />,
    );

    fireEvent.click(getByTestId("copilot-turn-edit"));
    const box = getByTestId("copilot-edit-message").querySelector("textarea")!;
    fireEvent.change(box, { target: { value: "changed my mind" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(seen).toEqual([]);
    expect(getByText("What should I say?")).toBeDefined();
    expect(getByTestId("copilot-turn-delete")).toBeDefined();
  });

  it("submit forwards the edited draft and closes the editor", () => {
    const seen: string[] = [];
    const { getByTestId, getByText, queryByTestId } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
        onEditLast={(content) => seen.push(content)}
      />,
    );

    fireEvent.click(getByTestId("copilot-turn-edit"));
    fireEvent.change(getByTestId("copilot-edit-message").querySelector("textarea")!, { target: { value: "revised question" } });
    fireEvent.click(getByTestId("copilot-edit-send"));
    expect(seen).toEqual(["revised question"]);
    // Closed: the bubble and its row return, the editor is gone.
    expect(queryByTestId("copilot-edit-message")).toBeNull();
    expect(getByText("What should I say?")).toBeDefined();
  });

  it("a stream started elsewhere closes an open editor (no editing while streaming)", () => {
    const { getByTestId, queryByTestId, getByText, rerender } = render(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
        onEditLast={() => {}}
      />,
    );

    fireEvent.click(getByTestId("copilot-turn-edit"));
    expect(getByTestId("copilot-edit-message")).toBeDefined();
    rerender(
      <AgentMessageBlock
        messageMarkup="plain"
        message={userMsg()}
        turnActions={[deleteTurnAction(() => {})]}
        canEditLast
        onEditLast={() => {}}
        isBusy
      />,
    );
    expect(queryByTestId("copilot-edit-message")).toBeNull();
    expect(getByText("What should I say?")).toBeDefined();
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

// ─── CA-4f: sent shell attachments — chips, menu, view-only lightbox ────────

const client = await import("../../../api/agent-attachment-actions-api.js");
const { AgentAttachmentActionsContext } = await import("./agent-attachment-actions-context.js");

describe("ExperienceCopilotMessageBlock — sent attachments (CA-4f)", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const textFile: import("@vibe-tavern/domain").Attachment = {
    id: "att1", assetId: "asset-1", name: "notes.md", type: "file",
    mimeType: "text/markdown", sizeBytes: 12, tokenCount: 42,
  };
  const image: import("@vibe-tavern/domain").Attachment = {
    id: "img1", assetId: "asset-2", name: "capture.png", type: "image",
    mimeType: "image/png", sizeBytes: 34,
  };

  function userMsg(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
    return {
      id: "u1",
      threadId: "thread-1",
      role: "user",
      content: "Read this",
      toolCallsJson: null,
      toolCallId: null,
      reasoning: null,
      reasoningDurationMs: null,
      createdAt: "2026-10-24T00:00:00.000Z",
      ...over,
    };
  }

  function renderWithActions(node: ReactNode) {
    return render(
      <AgentAttachmentActionsContext.Provider
        value={{ threadId: "thread-1", providerProfileId: "p1", model: "m1", refreshMessages: () => {} }}
      >
        {node}
      </AgentAttachmentActionsContext.Provider>,
    );
  }

  it("a user message with a text file shows the chip and its «⋯» menu", async () => {
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ attachments: [textFile] })} />);
    expect(view.getByTestId("file-attachment-chip")).toBeDefined();
    expect(view.getByTitle("notes.md")).toBeDefined();
    // The menu trigger mounts (desktop — the mobile override is false here).
    expect(view.getByRole("button", { name: "attachment_file_actions" })).toBeDefined();
  });

  it("an attachment-only user message renders (empty content no longer hides it)", () => {
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ content: "   ", attachments: [textFile] })} />);
    expect(view.getByTestId("file-attachment-chip")).toBeDefined();
  });

  it("the pending bubble shows the chips WITHOUT the menu", () => {
    const view = renderWithActions(
      <AgentMessageBlock messageMarkup="plain" message={userMsg({ id: "__pending-user", attachments: [textFile] })} />,
    );
    expect(view.getByTestId("file-attachment-chip")).toBeDefined();
    expect(view.queryByRole("button", { name: "attachment_file_actions" })).toBeNull();
  });

  it("a persisted image's lightbox shows the RP action set (behavior change: view-only → RP actions, basis owner 2026-10-24)", async () => {
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ attachments: [image] })} />);
    fireEvent.click(view.getByRole("button"));
    await waitFor(() => {
      expect(document.querySelector(".fixed.inset-0")).not.toBeNull();
    });
    expect(document.querySelector("img")).not.toBeNull();
    // WAS (CA-4f): view-only — no edit / regenerate / delete control. NOW:
    // the shell's action seam supplies the RP lightbox's three controls.
    expect(document.querySelector('[title="Edit description"], [title="Add description"]')).not.toBeNull();
    expect(document.querySelector('[title="regenerate_description_title"]')).not.toBeNull();
    expect(document.querySelector('[title="delete_attachment_title"]')).not.toBeNull();
  });

  it("regenerate calls the agent client with the picker's profile + model", async () => {
    const regenerate = spyOn(client, "regenerateAgentAttachmentDescription").mockResolvedValue({ description: "Fresh." });
    spies.push(regenerate);
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ attachments: [image] })} />);
    fireEvent.click(view.getByRole("button"));
    await waitFor(() => expect(document.querySelector('[title="regenerate_description_title"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[title="regenerate_description_title"]')!);
    await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(1));
    const call = regenerate.mock.calls[0]!;
    expect(call.slice(0, 4)).toEqual(["thread-1", "u1", "img1", { providerProfileId: "p1", model: "m1" }]);
    expect(call[4]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(document.body.textContent).toContain("Fresh."));
  });

  it("edit and delete call the agent description/remove clients", async () => {
    const update = spyOn(client, "updateAgentAttachmentDescription").mockResolvedValue({ ok: true });
    const remove = spyOn(client, "removeAgentAttachment").mockResolvedValue({ ok: true });
    spies.push(update, remove);
    // Two images: the pinned RP delete path short-circuits (closes, no API
    // call) when the deleted image was the message's LAST attachment, so the
    // client call is only reachable with a surviving sibling.
    const second = { ...image, id: "img2", assetId: "asset-3", name: "b.png" };
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ attachments: [image, second] })} />);
    fireEvent.click(view.getByAltText("capture.png"));
    await waitFor(() => expect(document.querySelector('[title="Add description"], [title="Edit description"]')).not.toBeNull());
    // Edit: open the editor, type, save.
    fireEvent.click(document.querySelector('[title="Add description"], [title="Edit description"]')!);
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "Hand-written." } });
    fireEvent.click([...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!);
    await waitFor(() => expect(update).toHaveBeenCalledWith("thread-1", "u1", "img1", "Hand-written."));
    // Delete: confirm through the destructive modal.
    fireEvent.click(document.querySelector('[title="delete_attachment_title"]')!);
    const confirm = await waitFor(() => {
      const found = [...document.querySelectorAll("button")].find((b) => b.textContent === "delete");
      expect(found).toBeDefined();
      return found!;
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("thread-1", "u1", "img1"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("thread-1", "u1", "img1"));
  });

  it("deleting a persisted user message's ONLY image calls the agent delete client (CA-4h)", async () => {
    const remove = spyOn(client, "removeAgentAttachment").mockResolvedValue({ ok: true });
    spies.push(remove);
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ attachments: [image] })} />);
    fireEvent.click(view.getByAltText("capture.png"));
    await waitFor(() => expect(document.querySelector('[title="delete_attachment_title"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[title="delete_attachment_title"]')!);
    fireEvent.click(await waitFor(() => {
      const confirm = document.querySelector<HTMLButtonElement>("button[class*='border-0 bg-danger']");
      expect(confirm).not.toBeNull();
      return confirm!;
    }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("thread-1", "u1", "img1"));
    await waitFor(() => expect(document.querySelector(".fixed.inset-0")).toBeNull());
  });

  it("the PENDING bubble's lightbox still has no controls", async () => {
    const view = renderWithActions(
      <AgentMessageBlock messageMarkup="plain" message={userMsg({ id: "__pending-user", content: "sending", attachments: [image] })} />,
    );
    fireEvent.click(view.getByRole("button"));
    await waitFor(() => {
      expect(document.querySelector(".fixed.inset-0")).not.toBeNull();
    });
    expect(document.querySelector("img")).not.toBeNull();
    expect(document.querySelector('[title="regenerate_description_title"]')).toBeNull();
    expect(document.querySelector('[title="delete_attachment_title"]')).toBeNull();
    expect(document.querySelector('[title="Edit description"], [title="Add description"]')).toBeNull();
  });

  it("summarize calls the agent client with the picker's profile + model", async () => {
    const summarize = spyOn(client, "summarizeAgentAttachment").mockResolvedValue({ ...textFile, description: "Short." });
    spies.push(summarize);
    const userEvent = (await import("@testing-library/user-event")).default;
    const view = renderWithActions(<AgentMessageBlock messageMarkup="plain" message={userMsg({ attachments: [textFile] })} />);
    await userEvent.setup().click(view.getByRole("button", { name: "attachment_file_actions" }));
    await waitFor(() => expect(view.getByRole("menuitem", { name: "attachment_summarize" })).toBeDefined());
    await userEvent.setup().click(view.getByRole("menuitem", { name: "attachment_summarize" }));
    await waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    expect(summarize.mock.calls[0]!.slice(0, 4)).toEqual(["thread-1", "u1", "att1", { providerProfileId: "p1", model: "m1" }]);
  });
});
