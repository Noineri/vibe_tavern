import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useAgentPendingReviewStore } from "./agent-pending-review-store.js";
import { agentThreadKey } from "../lib/agent-host-registry.js";

const summariesBeforeSuite = useAgentPendingReviewStore.getState().summariesByThread;

beforeEach(() => useAgentPendingReviewStore.setState({ summariesByThread: {} }));
afterAll(() => useAgentPendingReviewStore.setState({ summariesByThread: summariesBeforeSuite }));

describe("agent pending-review summary store (AP-15)", () => {
  it("stores each kind's summary under its agentThreadKey — kinds never collide on one threadId", () => {
    const acceptAll = mock();
    const open = mock();
    useAgentPendingReviewStore.getState().publish("experience", "thread-1", {
      buffers: [{ labelKey: "agent_rules", pending: 3 }],
      acceptAll,
      open,
    });
    useAgentPendingReviewStore.getState().publish("script", "thread-1", {
      buffers: [{ labelKey: "script_code_label", pending: 1 }],
      acceptAll,
      open,
    });

    const summaries = useAgentPendingReviewStore.getState().summariesByThread;
    // The key derivation is the shared helper's, not a parallel one: the
    // experience kind keeps the legacy bare threadId, later kinds namespace.
    expect(summaries[agentThreadKey("experience", "thread-1")]?.buffers).toEqual([
      { labelKey: "agent_rules", pending: 3 },
    ]);
    expect(summaries[agentThreadKey("script", "thread-1")]?.buffers).toEqual([
      { labelKey: "script_code_label", pending: 1 },
    ]);
  });

  it("holds the consumer-registered callables verbatim — calling them fires the registered functions", () => {
    const acceptAll = mock();
    const open = mock();
    useAgentPendingReviewStore.getState().publish("experience", "thread-2", {
      buffers: [{ labelKey: "agent_visual", pending: 5 }],
      acceptAll,
      open,
    });

    const entry = useAgentPendingReviewStore.getState().summariesByThread["thread-2"];
    expect(entry).toBeDefined();
    entry!.acceptAll();
    entry!.open();
    expect(acceptAll).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("clear removes only the cleared thread's entry and is a no-op when nothing is stored", () => {
    useAgentPendingReviewStore.getState().publish("experience", "thread-a", {
      buffers: [{ labelKey: "agent_rules", pending: 2 }],
      acceptAll: mock(),
      open: mock(),
    });
    useAgentPendingReviewStore.getState().publish("script", "thread-b", {
      buffers: [{ labelKey: "script_code_label", pending: 1 }],
      acceptAll: mock(),
      open: mock(),
    });

    useAgentPendingReviewStore.getState().clear("experience", "thread-a");
    const summaries = useAgentPendingReviewStore.getState().summariesByThread;
    expect(summaries["thread-a"]).toBeUndefined();
    expect(summaries[agentThreadKey("script", "thread-b")]).toBeDefined();

    // No-op clear leaves the map identity untouched (zustand skips the
    // notification when the updater returns the same state).
    const before = useAgentPendingReviewStore.getState().summariesByThread;
    useAgentPendingReviewStore.getState().clear("experience", "thread-a");
    expect(useAgentPendingReviewStore.getState().summariesByThread).toBe(before);
  });
});
