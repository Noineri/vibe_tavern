/**
 * useAgentCallDirector (DIRECTOR_MODE_PLAN DR-12) — the shell's pending-call
 * consumption: a queued director call sends ONCE, exactly when the shell's
 * controller is ready (a live threadId, the bootstrap not loading, no turn
 * streaming), through the caller's send dispatch with the
 * `story_plan_call_director_message` key resolved by the shell's own `t`.
 *
 * Exactly-once is the store's remove-first consume — pinned here under
 * dep-churn rerenders (the effect refires, the entry is gone, no second
 * send).
 *
 * Runner: bun:test + happy-dom; a null-render harness (the hook has no
 * markup); the i18n seam's identity `t` pins WHICH key the hook resolves.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();
// Identity `t`: the send-content assertion pins the KEY.
installI18nContextSeam();

const { render } = await import("@testing-library/react");
const React = await import("react");
const { useSidechatCallDirectorStore } = await import("../../../stores/sidechat-call-director-store.js");

let useAgentCallDirector: typeof import("./use-agent-call-director.js").useAgentCallDirector;
beforeAll(async () => {
  ({ useAgentCallDirector } = await import("./use-agent-call-director.js"));
});

const OWNER_KEY = "chat:c1:b1:sidechat-ooc";

/** Null-render harness around the hook (the shell's args, spied send). */
function Harness(props: {
  ownerKey: string;
  threadId: string | null;
  sessionLoading: boolean;
  isSending: boolean;
  send: (content: string) => void;
}) {
  const t = (key: string) => key;
  useAgentCallDirector({ ...props, t });
  return null;
}

describe("useAgentCallDirector (DR-12)", () => {
  const send = mock((content: string) => {});

  beforeEach(() => {
    useSidechatCallDirectorStore.setState({ pending: {} });
    send.mockReset();
  });

  it("does not send while the bootstrap is unresolved (no thread, or still loading)", () => {
    useSidechatCallDirectorStore.setState({ pending: { [OWNER_KEY]: true } });
    render(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: null, sessionLoading: true, isSending: false, send }));
    expect(send).not.toHaveBeenCalled();
    // The queue entry survives — the call is waiting, not dropped.
    expect(useSidechatCallDirectorStore.getState().pending[OWNER_KEY]).toBe(true);
  });

  it("sends exactly once when ready, through the send dispatch, with the message key", () => {
    useSidechatCallDirectorStore.setState({ pending: { [OWNER_KEY]: true } });
    const view = render(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: false, send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("story_plan_call_director_message");
    // The entry is consumed — dep-churn rerenders never re-send.
    view.rerender(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: true, send }));
    view.rerender(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: false, send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(useSidechatCallDirectorStore.getState().pending[OWNER_KEY]).toBeUndefined();
  });

  it("waits out a streaming turn: the queued call sends only after isSending falls", () => {
    useSidechatCallDirectorStore.setState({ pending: { [OWNER_KEY]: true } });
    const view = render(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: true, send }));
    expect(send).not.toHaveBeenCalled();
    view.rerender(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: false, send }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("DK-6: a queued custom message key is resolved through the shell's t (the deck's refill)", () => {
    useSidechatCallDirectorStore.setState({
      pending: { [OWNER_KEY]: true },
      messages: { [OWNER_KEY]: "story_deck_call_director_message" },
    });
    render(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: false, send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("story_deck_call_director_message");
    // The entry AND its key are consumed together.
    expect(useSidechatCallDirectorStore.getState().messages[OWNER_KEY]).toBeUndefined();
  });

  it("no pending entry for this owner — byte-identical no-op (every non-sidechat host)", () => {
    render(React.createElement(Harness, { ownerKey: OWNER_KEY, threadId: "t1", sessionLoading: false, isSending: false, send }));
    expect(send).not.toHaveBeenCalled();
  });
});
