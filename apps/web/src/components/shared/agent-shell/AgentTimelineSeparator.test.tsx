/**
 * SC-19b — sidechat timeline separators: the four event kinds render as
 * one-line separators at their anchors (null anchor → at the end), the three
 * content-carrying kinds expand to the frozen content the assistant saw
 * (`branch_forked` never expands), the rp_sync label pluralizes 1 / 3 / 5 in
 * RU, and a host without `transport.listEvents` renders exactly as today.
 *
 * Real RU i18n (the AgentActivityCard.test.tsx precedent — `initI18n` in
 * `beforeAll`, language restored in `afterAll`, so no sibling file in the
 * shared worker can observe it); the Tooltip mock mirrors the shell's other
 * list tests (Radix never anchors under happy-dom).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { LocaleProvider } from "../../../i18n/context.js";
import type { ReactElement } from "react";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";

useDomEnv();

// CustomTooltip (Radix) never anchors under happy-dom — the ask card the list
// may render is wrapped in it. Render children inline; this pins the
// separator wiring, not tooltip internals (same mock as the list test).
mock.module("../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentMessageList: typeof import("./AgentMessageList.js").AgentMessageList;
let AgentDigestSeparator: typeof import("./AgentTimelineSeparator.js").AgentDigestSeparator;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  // Real RU resources (bundled — synchronously available after init).
  // `initI18n` is first-wins process-wide: a co-loaded file that already
  // initialized the global instance (i18n.test.ts pins the production
  // options with `initI18n("en")`) would lock EN and turn this call into a
  // no-op. The explicit change makes this suite order-independent — it owns
  // RU for its duration (the afterAll below restores EN, the R13 contract).
  const { initI18n, i18next: i18nInstance } = await import("../../../i18n/i18n.js");
  initI18n("ru");
  await i18nInstance.changeLanguage("ru");
  // All three built-in hosts: only the sidechat wires `listEvents`.
  await import("../../build/editors/copilot/experience-agent-host.js");
  await import("../../build/editors/script-agent-host.js");
  await import("../../chat/sidechat/sidechat-host.js");
  ({ AgentMessageList } = await import("./AgentMessageList.js"));
  ({ AgentDigestSeparator } = await import("./AgentTimelineSeparator.js"));
});

afterAll(async () => {
  // R13: the process-global i18n singleton is shared per worker — restore
  // the default language so no later assertion can observe RU.
  const { i18next } = await import("../../../i18n/i18n.js");
  await i18next.changeLanguage("en");
});

beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
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

function rpSyncMessage(id: string, text: string, authorName: string | null = null) {
  return { id, position: 1, role: "assistant" as const, authorName, variantId: null, model: null, preset: null, text };
}

function rpSyncEvent(
  id: string,
  texts: string[],
  beforeMessageId: string | null,
): AgentThreadEventWire {
  return {
    id,
    kind: "rp_sync",
    payload: {
      fromPosition: 1,
      toPosition: texts.length,
      messages: texts.map((text, index) => rpSyncMessage(`rp-${id}-${index}`, text)),
    },
    beforeMessageId,
  };
}

function variantsEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return {
    id,
    kind: "variants_attached",
    payload: {
      position: 5,
      variants: [
        { text: "frozen variant one", selected: false, number: null, model: null, preset: null },
        { text: "frozen variant two", selected: true, number: null, model: null, preset: null },
      ],
    },
    beforeMessageId,
  };
}

function selectionEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return {
    id,
    kind: "selection_changed",
    payload: {
      messageId: "rp-msg-1",
      position: 7,
      previous: { variantId: "v-prev", text: "the previous reply", model: null, preset: null },
      current: { variantId: "v-cur", text: "the current reply", model: null, preset: null },
    },
    beforeMessageId,
  };
}

function forkEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return { id, kind: "branch_forked", payload: { at: 9 }, beforeMessageId };
}

/** `useT()` without a provider is the identity (keys) — every render mounts
 *  the real provider pinned to RU so the copy assertions see translations. */
function renderRu(element: ReactElement) {
  return render(<LocaleProvider initialLocale="ru">{element}</LocaleProvider>);
}

/** Feed order as data markers: separators by kind, messages by role. */
function feedOrder(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll('[data-testid="timeline-separator"], [data-role="user"], [data-role="assistant"]'),
  ].map((el) => el.getAttribute("data-kind") ?? el.getAttribute("data-role") ?? "?");
}

describe("AgentTimelineSeparator (SC-19b)", () => {
  it("renders the four kinds at their anchors — before the anchor message, null anchor at the end", () => {
    const { container, getByText } = renderRu(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "user says hi" }),
          message({ id: "a1", role: "assistant", content: "assistant replies" }),
        ]}
        events={[
          // Two consecutive events share one anchor — both land before it, in order.
          rpSyncEvent("e-rp", ["frozen one", "frozen two"], "a1"),
          variantsEvent("e-var", "a1"),
          selectionEvent("e-sel", null),
          forkEvent("e-fork", null),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    // Two frozen messages → the RU `few` form (2, 3, 4 — never «2 сообщений»).
    expect(getByText("── РП продвинулся на 2 сообщения ──")).toBeDefined();
    expect(getByText("── Прикреплено вариантов: 2 ──")).toBeDefined();
    expect(getByText("── Выбранный ответ сменился ──")).toBeDefined();
    expect(getByText("── Новая ветка ──")).toBeDefined();
    expect(feedOrder(container)).toEqual([
      "user",
      "rp_sync",
      "variants_attached",
      "assistant",
      "selection_changed",
      "branch_forked",
    ]);
  });

  it("the three content kinds expand to the frozen content; branch_forked has no toggle", async () => {
    const { container, getByText, queryByText } = renderRu(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "a1", role: "assistant", content: "assistant replies" })]}
        events={[
          rpSyncEvent("e-rp", ["frozen one", "frozen two"], "a1"),
          variantsEvent("e-var", null),
          selectionEvent("e-sel", null),
          forkEvent("e-fork", null),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const separators = [...container.querySelectorAll('[data-testid="timeline-separator"]')];
    expect(separators.map((el) => el.getAttribute("data-kind"))).toEqual([
      "rp_sync",
      "variants_attached",
      "selection_changed",
      "branch_forked",
    ]);
    // Only the three content kinds render a toggle — branch_forked is a static line.
    const toggles = container.querySelectorAll('[data-testid="timeline-separator-toggle"]');
    expect(toggles).toHaveLength(3);

    // Bodies are hidden until clicked, then show exactly the frozen payload.
    expect(queryByText("frozen one")).toBeNull();
    fireEvent.click(toggles[0]!);
    expect(getByText("frozen one")).toBeDefined();
    expect(getByText("frozen two")).toBeDefined();

    fireEvent.click(toggles[1]!);
    expect(getByText("frozen variant one")).toBeDefined();
    expect(getByText("frozen variant two")).toBeDefined();
    // The selected variant carries the chip's selected marker (the feed's own copy).
    expect(getByText("#2 · выбран")).toBeDefined();

    fireEvent.click(toggles[2]!);
    expect(getByText("the previous reply")).toBeDefined();
    expect(getByText("the current reply")).toBeDefined();

    // The expanded body scrolls inside itself (the digest card precedent) —
    // it never stretches the feed.
    const bodies = container.querySelectorAll('[data-testid="timeline-separator-body"]');
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.className).toContain("max-h-64");
      expect(body.className).toContain("overflow-y-auto");
    }

    // A second click collapses again — the exit animation keeps the body
    // in the DOM a moment (AP-29 AnimatedDisclosure), so the test WAITS
    // for its removal (never weakened, never keepMounted).
    fireEvent.click(toggles[0]!);
    await waitFor(() => expect(queryByText("frozen one")).toBeNull());
  });

  it("the rp_sync label pluralizes 1 / 3 / 5 in RU", () => {
    const { getByText } = renderRu(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "a1", role: "assistant", content: "assistant replies" })]}
        events={[
          rpSyncEvent("e-1", ["one"], null),
          rpSyncEvent("e-3", ["one", "two", "three"], null),
          rpSyncEvent("e-5", ["one", "two", "three", "four", "five"], null),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(getByText("── РП продвинулся на 1 сообщение ──")).toBeDefined();
    expect(getByText("── РП продвинулся на 3 сообщения ──")).toBeDefined();
    expect(getByText("── РП продвинулся на 5 сообщений ──")).toBeDefined();
  });

  it("only the sidechat host wires listEvents; a host without it renders as before", async () => {
    const { getAgentHost } = await import("../../../lib/agent-host-registry.js");
    expect(getAgentHost("experience").transport.listEvents).toBeUndefined();
    expect(getAgentHost("script").transport.listEvents).toBeUndefined();
    expect(getAgentHost(SIDECHAT_AGENT_KIND).transport.listEvents).toBeDefined();

    const { container, getByText, queryByTestId } = renderRu(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "user says hi" }),
          message({ id: "a1", role: "assistant", content: "assistant replies" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryByTestId("timeline-separator")).toBeNull();
    expect(getByText("user says hi")).toBeDefined();
    expect(getByText("assistant replies")).toBeDefined();
    expect(feedOrder(container)).toEqual(["user", "assistant"]);
  });
});

// ─── Page translation (owner follow-up 2026-10-24) ───────────────────────
// behavior change: was → now, basis: AGENT_SHELL_POLISH_PLAN owner follow-up
// 2026-10-24 (page translation). The frozen RP texts are user/model text —
// they opt back in; the separator labels and author captions stay out.
describe("AgentTimelineSeparator — page translation (follow-up 2026-10-24)", () => {
  it("expanded frozen texts carry translate=yes, chrome labels do not", () => {
    const { container, getByText } = renderRu(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "a1", role: "assistant", content: "assistant replies" })]}
        events={[
          rpSyncEvent("e-rp", ["frozen one"], "a1"),
          variantsEvent("e-var", null),
          selectionEvent("e-sel", null),
          forkEvent("e-fork", null),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const toggles = container.querySelectorAll('[data-testid="timeline-separator-toggle"]');
    fireEvent.click(toggles[0]!);
    expect(getByText("frozen one").getAttribute("translate")).toBe("yes");
    fireEvent.click(toggles[1]!);
    expect(getByText("frozen variant one").getAttribute("translate")).toBe("yes");
    fireEvent.click(toggles[2]!);
    expect(getByText("the previous reply").getAttribute("translate")).toBe("yes");
    // Chrome: the separator labels and the toggle itself stay untranslated.
    expect(getByText("── РП продвинулся на 1 сообщение ──").getAttribute("translate")).toBeNull();
    expect(toggles[0]!.getAttribute("translate")).toBeNull();
  });
});

// ─── AP-34: the compaction digest as a timeline separator ─────────────────
// WAS (CM-9, basis: the block suite's old card pins): a dark bordered card at
// 85% width with a title + caption + relative-time header. NOW: the same
// shared frame as the event separators above (centered muted line, caret,
// shared AnimatedDisclosure body) — «── Контекст сжат: N сообщений ──»,
// expanding to the full summary text.
describe("AgentDigestSeparator (AP-34)", () => {
  function digestMessage(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
    return message({
      id: "d1",
      role: "digest",
      content: "the compacted summary",
      toolCallId: "u1",
      ...over,
    });
  }

  it("labels 1 covered message in RU (one)", () => {
    const { getByText, queryByTestId } = renderRu(
      <AgentDigestSeparator message={digestMessage()} coveredCount={1} />,
    );

    expect(getByText("── Контекст сжат: 1 сообщение ──")).toBeDefined();
    // Collapsed by default — the summary body is absent.
    expect(queryByTestId("timeline-separator-body")).toBeNull();
  });

  it("labels 3 covered messages in RU (few)", () => {
    const { getByText } = renderRu(
      <AgentDigestSeparator message={digestMessage()} coveredCount={3} />,
    );

    expect(getByText("── Контекст сжат: 3 сообщения ──")).toBeDefined();
  });

  it("labels 5 covered messages in RU (many)", () => {
    const { getByText } = renderRu(
      <AgentDigestSeparator message={digestMessage()} coveredCount={5} />,
    );

    expect(getByText("── Контекст сжат: 5 сообщений ──")).toBeDefined();
  });

  it("a digest without a count labels the bare title", () => {
    const { getByText } = renderRu(
      <AgentDigestSeparator message={digestMessage()} coveredCount={null} />,
    );

    expect(getByText("── Контекст сжат ──")).toBeDefined();
  });

  it("expands on click to the full summary and collapses again", async () => {
    const { getByTestId, queryByTestId, getByText } = renderRu(
      <AgentDigestSeparator message={digestMessage()} coveredCount={3} />,
    );

    fireEvent.click(getByTestId("timeline-separator-toggle"));
    expect(getByText("the compacted summary")).toBeDefined();

    fireEvent.click(getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(queryByTestId("timeline-separator-body")).toBeNull());
  });

  it("the relative time is the body's first line, never a label suffix", async () => {
    const { formatRelativeTime } = await import("../../layout/sidebar-utils.js");
    const createdAt = new Date(Date.now() - 7 * 60 * 1000).toISOString();
    const { getByTestId, getByText } = renderRu(
      <AgentDigestSeparator message={digestMessage({ createdAt })} coveredCount={3} />,
    );

    // The toggle reads exactly the label — no quiet suffix beside it.
    expect(getByTestId("timeline-separator-toggle").textContent).toBe("── Контекст сжат: 3 сообщения ──");
    fireEvent.click(getByTestId("timeline-separator-toggle"));
    const body = getByTestId("timeline-separator-body");
    // First line: the relative time (Intl-formatted chrome, untranslated).
    expect(body.firstElementChild!.textContent).toBe(formatRelativeTime(createdAt));
    expect(body.firstElementChild!.getAttribute("translate")).toBeNull();
    // Then the summary (model text, opted into page translation).
    expect(getByText("the compacted summary").getAttribute("translate")).toBe("yes");
  });

  it("the expanded body scrolls internally and carries the feed's digest markers", () => {
    const { container, getByTestId } = renderRu(
      <AgentDigestSeparator message={digestMessage()} coveredCount={3} />,
    );

    fireEvent.click(getByTestId("timeline-separator-toggle"));
    const body = getByTestId("timeline-separator-body");
    expect(body.className).toContain("max-h-64");
    expect(body.className).toContain("overflow-y-auto");
    // The feed's digest-row pins (order, regenerate keep) read these — and
    // no card chrome is left anywhere in the render.
    const frame = getByTestId("timeline-separator");
    expect(frame.getAttribute("data-kind")).toBe("digest");
    expect(frame.getAttribute("data-role")).toBe("digest");
    expect(container.querySelector('[data-testid="copilot-digest-card"]')).toBeNull();
  });
});
