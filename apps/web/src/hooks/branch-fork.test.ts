/**
 * forkBranchFlow (SC-21) — the single fork gate all three fork call sites
 * share (extracted out of `use-chat-controller` per the file-size ratchet).
 *
 * Pins the behavior contract: no sessions on the source branch ⇒ exactly
 * today's fork, no confirm, no extra UI; a failed summary NEVER blocks the
 * fork either. With sessions the fork waits for the calm three-button
 * confirm: cancel leaves everything untouched, the plain button forks
 * without the copy, the primary forks AND copies (source = the pre-fork
 * active branch, target = the new branch — pinned at the action seam in
 * `chat-actions.test.ts`, here pinned as the flag passed through).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../api/types.js";

import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { waitFor } = await import("@testing-library/react");

const forkBranchActionMock = mock();

const realChatActions = await import("../stores/api-actions/chat-actions.js");
const realLocaleHelpers = await import("../i18n/locale-helpers.js");

mock.module("../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  forkBranchAction: forkBranchActionMock,
}));

// Stable key-fallback i18n: dialog assertions read the raw keys.
mock.module("../i18n/locale-helpers.js", () => ({
  ...realLocaleHelpers,
  getT: () => (key: string) => key,
}));

const { forkBranchFlow } = await import("./branch-fork.js");
const { useCharacterStore } = await import("../stores/character-store.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");

const originalFetch = globalThis.fetch;

type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

const chatId = (id: string) => id as ChatId;

function respondSummary(status: number, body: unknown): void {
  globalThis.fetch = Object.assign(
    mock<FetchImplementation>(async () => {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
    { preconnect: originalFetch.preconnect },
  );
}

function seedActiveBranch(branchId: string | null): void {
  useSnapshotStore.getState().ingestSnapshot({
    ...(branchId ? { activeBranch: { id: branchId, chatId: chatId("chat-1") } } : {}),
  } as unknown as AppSnapshot);
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  forkBranchActionMock.mockReset();
  useSnapshotStore.getState().clear();
  useCharacterStore.getState().setConfirmDestroy(null);
  useChatStore.getState().setMessageActionId(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("forkBranchFlow (SC-21)", () => {
  test("no active branch ⇒ today's fork, no summary fetch, no confirm", async () => {
    seedActiveBranch(null);
    let fetched = false;
    globalThis.fetch = Object.assign(
      mock<FetchImplementation>(async () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      }),
      { preconnect: originalFetch.preconnect },
    );
    await forkBranchFlow(chatId("chat-1"), "msg-1");
    expect(fetched).toBe(false);
    expect(forkBranchActionMock).toHaveBeenCalledTimes(1);
    expect(forkBranchActionMock).toHaveBeenCalledWith(chatId("chat-1"), "msg-1", undefined);
    expect(useCharacterStore.getState().confirmDestroy).toBeNull();
  });

  test("no sessions ⇒ today's fork, no confirm", async () => {
    seedActiveBranch("br-1");
    respondSummary(200, { hasSessions: false, count: 0 });
    await forkBranchFlow(chatId("chat-1"), "msg-1");
    expect(forkBranchActionMock).toHaveBeenCalledTimes(1);
    expect(forkBranchActionMock).toHaveBeenCalledWith(chatId("chat-1"), "msg-1", undefined);
    expect(useCharacterStore.getState().confirmDestroy).toBeNull();
  });

  test("failed summary ⇒ the fork proceeds as today, no confirm", async () => {
    seedActiveBranch("br-1");
    respondSummary(500, { error: "boom" });
    await forkBranchFlow(chatId("chat-1"));
    expect(forkBranchActionMock).toHaveBeenCalledTimes(1);
    expect(forkBranchActionMock).toHaveBeenCalledWith(chatId("chat-1"), undefined, undefined);
    expect(useCharacterStore.getState().confirmDestroy).toBeNull();
  });

  test("with sessions ⇒ calm three-button confirm opens, the fork waits", async () => {
    seedActiveBranch("br-1");
    respondSummary(200, { hasSessions: true, count: 2 });
    await forkBranchFlow(chatId("chat-1"), "msg-1");
    expect(forkBranchActionMock).not.toHaveBeenCalled();
    const dialog = useCharacterStore.getState().confirmDestroy;
    expect(dialog).not.toBeNull();
    expect(dialog?.title).toBe("sidechat_fork_confirm_title");
    expect(dialog?.body).toBe("sidechat_fork_confirm_body");
    expect(dialog?.confirmLabel).toBe("sidechat_fork_confirm_with");
    expect(dialog?.secondaryLabel).toBe("sidechat_fork_confirm_plain");
    expect(dialog?.tone).toBe("calm");
  });

  test("primary button ⇒ fork WITH the sidechat copy", async () => {
    seedActiveBranch("br-1");
    respondSummary(200, { hasSessions: true, count: 1 });
    await forkBranchFlow(chatId("chat-1"), "msg-1");
    const dialog = useCharacterStore.getState().confirmDestroy;
    dialog?.onConfirm();
    await waitFor(() => expect(forkBranchActionMock).toHaveBeenCalledTimes(1));
    expect(forkBranchActionMock).toHaveBeenCalledWith(chatId("chat-1"), "msg-1", { copySidechat: true });
  });

  test("secondary button ⇒ plain fork, no copy", async () => {
    seedActiveBranch("br-1");
    respondSummary(200, { hasSessions: true, count: 1 });
    await forkBranchFlow(chatId("chat-1"), "msg-1");
    const dialog = useCharacterStore.getState().confirmDestroy;
    dialog?.onSecondary?.();
    await waitFor(() => expect(forkBranchActionMock).toHaveBeenCalledTimes(1));
    expect(forkBranchActionMock).toHaveBeenCalledWith(chatId("chat-1"), "msg-1", undefined);
  });

  test("no button pressed ⇒ nothing happens (cancel closes via the shell, covered in the modal test)", async () => {
    seedActiveBranch("br-1");
    respondSummary(200, { hasSessions: true, count: 1 });
    await forkBranchFlow(chatId("chat-1"), "msg-1");
    expect(useCharacterStore.getState().confirmDestroy).not.toBeNull();
    expect(forkBranchActionMock).not.toHaveBeenCalled();
  });
});
