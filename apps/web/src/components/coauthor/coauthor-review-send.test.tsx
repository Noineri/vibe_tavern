/**
 * RO-5 controller-chain evidence.
 *
 * These cases deliberately use the real useChatController, action layer, chat
 * API client, and stream client. Only fetch is replaced: the assertion is that
 * each actual HTTP body still carries the retained review after its own early
 * clearTurn boundary.
 *
 * L1: all paths are repo-relative imports; fetch is restored between tests and
 * after the suite; waits are controller settlements; no platform assumptions,
 * module mocks, or shared-worker ordering; assertions read terminal request
 * bodies and the cleared turn store directly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";

import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { act, renderHook } = await import("@testing-library/react");

import { useChatController } from "../../hooks/use-chat-controller.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useCoauthorTurnStore } from "../../stores/coauthor-turn-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import {
  buildCoauthorAwaitingReview,
  clearCoauthorEditorSnapshotStateForTests,
  publishCoauthorPendingReview,
  registerCoauthorEditor,
  restoreCoauthorEditorSnapshotStateForTests,
  snapshotCoauthorEditorSnapshotStateForTests,
  type CoauthorReviewInput,
} from "../../lib/coauthor-editor-snapshot.js";

const CHAT = brandId<ChatId>("chat-review-send");
const CHARACTER = "char-review-send";
const originalSnapshotState = snapshotCoauthorEditorSnapshotStateForTests();
const realFetch = globalThis.fetch;

const reviewInput: CoauthorReviewInput = {
  card: {
    base: "base body",
    proposed: "proposed body",
    hunkIds: [0, 1],
    selectedHunkIds: new Set([0]),
    hasProposal: true,
  },
  lore: {
    identity: "offered lore",
    offeredIds: ["book:lore"],
    selectedIds: new Set(["book:lore"]),
  },
  tracker: { identity: "tracker", selected: true },
};

function seed(streamResponse: boolean): () => void {
  useSnapshotStore.setState({
    character: { id: CHARACTER, name: "Saved" } as unknown as ReturnType<typeof useSnapshotStore.getState>["character"],
    activeChat: { id: CHAT, mode: "coauthor" } as unknown as ReturnType<typeof useSnapshotStore.getState>["activeChat"],
  });
  useChatStore.setState({ activeChatId: CHAT, draft: "send review", draftAttachments: [], generations: {} });
  useProviderStore.setState((state) => ({ connection: { ...state.connection, streamResponse } }));
  useProviderDataStore.setState({
    profiles: [{ id: "profile-review", isActive: true, defaultModel: "review-model" } as unknown as ReturnType<typeof useProviderDataStore.getState>["profiles"][number]],
    coauthorSettingsByProfile: {},
  });
  useBootstrapStore.setState({
    data: {
      uiSettings: { coauthorProviderId: "profile-review" },
    } as unknown as ReturnType<typeof useBootstrapStore.getState>["data"],
  });
  const unregister = registerCoauthorEditor(CHAT, CHARACTER, () => ({
    name: "Live editor",
    body: "Current unsaved editor body",
    greetings: ["", "Alternative greeting"],
    cardClean: false,
  }));
  publishCoauthorPendingReview(CHAT, CHARACTER, buildCoauthorAwaitingReview(reviewInput));
  useCoauthorTurnStore.getState().upsertActivity(CHAT, {
    toolCallId: "will-clear",
    toolName: "write_profile",
    status: "done",
    target: "profile",
    proposed: "proposal held only in the ephemeral turn store",
  });
  return unregister;
}

function expectRetainedReview(body: Record<string, unknown>): void {
  const state = body.coauthorEditorState as {
    card: { name: string; body: string; greetings: string[]; cardClean: boolean };
    review: { targets: Array<{ target: string; outcome: string }> };
  };
  expect(state.card).toEqual({
    name: "Live editor",
    body: "Current unsaved editor body",
    greetings: ["", "Alternative greeting"],
    cardClean: false,
  });
  expect(state.review.targets).toEqual(expect.arrayContaining([
    expect.objectContaining({ target: "card", outcome: "awaiting" }),
    expect.objectContaining({ target: "lore", outcome: "awaiting" }),
    expect.objectContaining({ target: "tracker_template", outcome: "awaiting" }),
  ]));
}

describe("coauthor review send through useChatController", () => {
  beforeEach(() => {
    clearCoauthorEditorSnapshotStateForTests();
    useCoauthorTurnStore.setState({ turnsByChat: {} });
    globalThis.fetch = realFetch;
  });

  afterEach(() => {
    clearCoauthorEditorSnapshotStateForTests();
    useCoauthorTurnStore.setState({ turnsByChat: {} });
    useSnapshotStore.getState().clear();
    useChatStore.setState({ activeChatId: null, draft: "", draftAttachments: [], generations: {} });
    useBootstrapStore.setState({ data: null });
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    restoreCoauthorEditorSnapshotStateForTests(originalSnapshotState);
    globalThis.fetch = realFetch;
  });

  it("keeps awaiting choices in the real non-stream HTTP body after sendChatMessageAction clears the turn", async () => {
    const unregister = seed(false);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(useCoauthorTurnStore.getState().getActivities(CHAT)).toEqual([]);
    expect(requests).toHaveLength(1);
    expectRetainedReview(requests[0]!);
    unregister();
  });

  it("keeps awaiting choices in the real stream HTTP body after executeStreamAction clears the turn", async () => {
    const unregister = seed(true);
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response('event: finish\ndata: {"finishReason":"stop"}\n\n', { status: 200 });
    }) as typeof fetch;
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(useCoauthorTurnStore.getState().getActivities(CHAT)).toEqual([]);
    expect(requests).toHaveLength(1);
    expectRetainedReview(requests[0]!);
    unregister();
  });
});
