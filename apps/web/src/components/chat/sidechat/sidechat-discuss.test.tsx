/**
 * SC-18 — the sidechat host's discuss wiring + the composer's chips + the
 * send body + the entry icon.
 *
 * Pins:
 *   - buildSendOptions maps the CURRENT chat+branch pending chips to
 *     `attachedVariants` as plain pairs (no `selected` marker — the schema
 *     rejects it); empty pending sends no key at all;
 *   - onSendSettled clears on success and keeps on failure;
 *   - composerTopSlot renders the chips (`#N · …`, removable per chip);
 *   - the controller carries opts.attachedVariants into the stream body
 *     (both absent and failure cases pinned);
 *   - the Ic.sidechatDiscuss glyph matches the owner-picked paths exactly.
 */
import { afterAll, beforeEach, describe, expect, test, mock, spyOn } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type {
  ExperienceCopilotContextLink,
  ExperienceCopilotStreamRequest,
} from "@vibe-tavern/api-contracts";
import type { CopilotStreamOpts } from "../../../api/experience-copilot-api.js";
import type {
  AgentHostBridge,
  AgentHostContext,
  AgentHostTransport,
} from "../../../lib/agent-host-registry.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// The controller's failure path toasts through the i18n singleton — echo it
// (a spy, not a real init) and restore in afterAll (R13).
const { i18next } = await import("../../../i18n/i18n.js");
const translate = spyOn(i18next, "t").mockImplementation(
  ((key: string) => String(key)) as typeof i18next.t,
);
const { toast } = await import("sonner");
const toastError = spyOn(toast, "error");

const { render, act, fireEvent, cleanup } = await import("@testing-library/react");
const { renderHook } = await import("@testing-library/react");
const { Ic } = await import("../../shared/icons.js");
const { getAgentHost } = await import("../../../lib/agent-host-registry.js");
// The sidechat host self-registers (registerAgentHost("sidechat-ooc")) as a
// module side effect — without this import the shell cannot resolve it by kind.
await import("./sidechat-host.js");
const {
  useSidechatVariantAttachmentsStore,
} = await import("../../../stores/sidechat-variant-attachments-store.js");
const { SIDECHAT_AGENT_KIND } = await import("../../../api/agent-kind-served-modes.js");
const { useAgentController } = await import("../../shared/agent-shell/use-agent-controller.js");

const OWNER: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "b1", agentKind: SIDECHAT_AGENT_KIND };

function hostCtx(): AgentHostContext {
  const bridge: AgentHostBridge = { session: null, setInputPrefill: () => {} };
  return { owner: OWNER, threadId: null, isSending: false, hostProps: undefined, bridge };
}

beforeEach(() => {
  useSidechatVariantAttachmentsStore.setState({ pendingByChatBranch: {} });
  toastError.mockClear();
});

afterAll(() => {
  translate.mockRestore();
  toastError.mockRestore();
});

describe("sidechat-host discuss wiring (SC-18)", () => {
  test("buildSendOptions maps the pending chips to plain pairs (no selected marker)", () => {
    useSidechatVariantAttachmentsStore.getState().attachVariants("chat-1", "b1", [
      { messageId: "m1", variantId: "v1", variantNumber: 1, selected: false },
      { messageId: "m1", variantId: "v2", variantNumber: 2, selected: true },
    ]);
    const options = getAgentHost(SIDECHAT_AGENT_KIND).buildSendOptions(hostCtx());
    expect(options.attachedVariants).toEqual([
      { messageId: "m1", variantId: "v1" },
      { messageId: "m1", variantId: "v2" },
    ]);
    for (const pair of options.attachedVariants ?? []) {
      expect(Object.keys(pair).sort()).toEqual(["messageId", "variantId"]);
    }
  });

  test("buildSendOptions reads the CURRENT chat+branch only and sends no key when empty", () => {
    useSidechatVariantAttachmentsStore.getState().attachVariants("chat-9", "b9", [
      { messageId: "m9", variantId: "v9", variantNumber: 1, selected: true },
    ]);
    const options = getAgentHost(SIDECHAT_AGENT_KIND).buildSendOptions(hostCtx());
    expect("attachedVariants" in options).toBe(false);
    expect(options).toEqual({});
  });

  test("onSendSettled clears on success and keeps on failure", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    useSidechatVariantAttachmentsStore.getState().attachVariants("chat-1", "b1", [
      { messageId: "m1", variantId: "v1", variantNumber: 1, selected: true },
    ]);
    host.onSendSettled?.(hostCtx(), false);
    expect(useSidechatVariantAttachmentsStore.getState().pendingByChatBranch).not.toEqual({});
    host.onSendSettled?.(hostCtx(), true);
    expect(useSidechatVariantAttachmentsStore.getState().pendingByChatBranch).toEqual({});
  });

  test("composerTopSlot renders the chips with #N labels; the × removes one", () => {
    useSidechatVariantAttachmentsStore.getState().attachVariants("chat-1", "b1", [
      { messageId: "m1", variantId: "v1", variantNumber: 1, selected: false },
      { messageId: "m1", variantId: "v2", variantNumber: 2, selected: true },
    ]);
    const slot = getAgentHost(SIDECHAT_AGENT_KIND).composerTopSlot?.(hostCtx()) as ReactNode;
    const view = render(slot as ReactElement);
    expect(view.getByTestId("sidechat-variant-chip-m1-v1").textContent).toContain('sidechat_chip_alternative {"n":1}');
    expect(view.getByTestId("sidechat-variant-chip-m1-v2").textContent).toContain('sidechat_chip_selected {"n":2}');
    fireEvent.click(view.getByTestId("sidechat-variant-chip-remove-m1-v1"));
    expect(view.queryByTestId("sidechat-variant-chip-m1-v1")).toBeNull();
    expect(view.getByTestId("sidechat-variant-chip-m1-v2")).not.toBeNull();
    cleanup();
  });

  test("composerTopSlot renders nothing when empty", () => {
    const slot = getAgentHost(SIDECHAT_AGENT_KIND).composerTopSlot?.(hostCtx()) as ReactNode;
    const view = render(slot as ReactElement);
    expect(view.container.textContent).toBe("");
    cleanup();
  });
});

describe("controller attachedVariants body (SC-18)", () => {
  // Fully typed fake (no casts): plain async fns satisfy the transport
  // memberwise, so no widening cast is needed.
  function fakeTransport(captured: { body?: ExperienceCopilotStreamRequest }, fail: boolean): AgentHostTransport {
    return {
      sendStream: async (_threadId: string, body: ExperienceCopilotStreamRequest, _opts: CopilotStreamOpts) => {
        captured.body = body;
        if (fail) throw new Error("provider down");
        return { finishReason: "stop", metrics: null };
      },
      answerAsk: async () => ({ finishReason: "stop", metrics: null }),
      getActiveThread: async () => null,
      listMessages: async () => [],
      startSession: async (): Promise<never> => { throw new Error("unused"); },
      listSessions: async (): Promise<never> => { throw new Error("unused"); },
      activateSession: async () => null,
      renameSession: async () => null,
      setContextLinks: async (_threadId: string, links: ExperienceCopilotContextLink[]) => links,
      deleteTurn: async () => ({ deletedMessageIds: [], deletedUserMessageId: null }),
    };
  }

  test("the send body carries the pairs and settles true", async () => {
    const captured: { body?: ExperienceCopilotStreamRequest } = {};
    const transport = fakeTransport(captured, false);
    const onTurnSettled = mock((_ok: boolean) => {});
    const { result } = renderHook(() =>
      useAgentController({
        kind: SIDECHAT_AGENT_KIND,
        transport,
        threadId: "thread-1",
        providerProfileId: "p1",
        onTurnSettled,
      }),
    );
    await act(async () => {
      await result.current.handleSend("compare them", {
        attachedVariants: [
          { messageId: "m1", variantId: "v1" },
          { messageId: "m1", variantId: "v2" },
        ],
      });
    });
    expect(captured.body).toMatchObject({
      content: "compare them",
      providerProfileId: "p1",
      attachedVariants: [
        { messageId: "m1", variantId: "v1" },
        { messageId: "m1", variantId: "v2" },
      ],
    });
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled.mock.calls[0]?.[0]).toBe(true);
  });

  test("no pending chips means no attachedVariants key", async () => {
    const captured: { body?: ExperienceCopilotStreamRequest } = {};
    const transport = fakeTransport(captured, false);
    const { result } = renderHook(() =>
      useAgentController({
        kind: SIDECHAT_AGENT_KIND,
        transport,
        threadId: "thread-1",
        providerProfileId: "p1",
      }),
    );
    await act(async () => {
      await result.current.handleSend("plain send");
    });
    expect(captured.body).toEqual({ content: "plain send", providerProfileId: "p1" });
  });

  test("a failed send keeps the chips (settles false)", async () => {
    const captured: { body?: ExperienceCopilotStreamRequest } = {};
    const transport = fakeTransport(captured, true);
    const onTurnSettled = mock((_ok: boolean) => {});
    const { result } = renderHook(() =>
      useAgentController({
        kind: SIDECHAT_AGENT_KIND,
        transport,
        threadId: "thread-1",
        providerProfileId: "p1",
        onTurnSettled,
      }),
    );
    await act(async () => {
      await result.current.handleSend("compare them", {
        attachedVariants: [{ messageId: "m1", variantId: "v1" }],
      });
    });
    // The pairs still rode the attempt…
    expect(captured.body).toMatchObject({ attachedVariants: [{ messageId: "m1", variantId: "v1" }] });
    // …but the outcome is failure, so the host keeps them.
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled.mock.calls[0]?.[0]).toBe(false);
  });
});

describe("sidechatDiscuss icon (SC-21c, owner 2026-10-22 re-pick)", () => {
  test("the glyph matches the re-picked dotless paths exactly", () => {
    const view = render(<Ic.sidechatDiscuss />);
    const svg = view.container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg?.getAttribute("fill")).toBe("none");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.getAttribute("stroke-width")).toBe("1.5");
    expect(svg?.getAttribute("stroke-linecap")).toBe("round");
    expect(svg?.getAttribute("stroke-linejoin")).toBe("round");
    // Two paths in order: the bubble (outlined — no own fill/stroke, it
    // inherits the wrapper's stroke) then the filled shoulders.
    const paths = [...(svg?.querySelectorAll("path") ?? [])].map((p) => ({
      d: p.getAttribute("d"),
      fill: p.getAttribute("fill"),
      stroke: p.getAttribute("stroke"),
    }));
    expect(paths).toEqual([
      { d: "M7 10.5H4.6L2 12.8V3.3A1.3 1.3 0 0 1 3.3 2h7.9A1.3 1.3 0 0 1 12.5 3.3V5", fill: null, stroke: null },
      { d: "M8.4 15.6A3.6 3.2 0 0 1 15.6 15.6Z", fill: "currentColor", stroke: "none" },
    ]);
    // The filled head is the ONLY circle — the dotless re-pick left no dot
    // circles anywhere in the glyph.
    const circles = [...(svg?.querySelectorAll("circle") ?? [])].map((c) => ({
      cx: c.getAttribute("cx"),
      cy: c.getAttribute("cy"),
      r: c.getAttribute("r"),
      fill: c.getAttribute("fill"),
      stroke: c.getAttribute("stroke"),
    }));
    expect(circles).toEqual([{ cx: "12", cy: "8.8", r: "2", fill: "currentColor", stroke: "none" }]);
    cleanup();
  });
});
