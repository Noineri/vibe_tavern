/**
 * Branch-sidechat confirm helpers (SC-21) — the single source behind BOTH
 * delete-branch confirm sites (`RichChatRow`, `SidebarFlyout`).
 *
 * Pins: the summary read is best-effort (a failed summary NEVER blocks the
 * confirm — it opens without the append), and the warning derivation (base
 * body unchanged without sessions, base + warning sentence with sessions).
 * The fork confirm needs no helper test: all three fork call sites go
 * through `forkBranchFlow`, whose own test file covers the gate.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  deleteBranchConfirmBody,
  fetchBranchHasSidechat,
  openDeleteBranchConfirm,
} from "./branch-sidechat-confirm.js";

const originalFetch = globalThis.fetch;

type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let capturedUrl = "";

function respondWith(status: number, body: unknown): void {
  capturedUrl = "";
  globalThis.fetch = Object.assign(
    mock<FetchImplementation>(async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
    { preconnect: originalFetch.preconnect },
  );
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const t = (key: string) => key;

describe("fetchBranchHasSidechat", () => {
  test("true when the branch owns active sessions", async () => {
    respondWith(200, { hasSessions: true, count: 2 });
    await expect(fetchBranchHasSidechat("chat-1", "br-1")).resolves.toBe(true);
    expect(capturedUrl).toContain("sidechat-summary");
  });

  test("false when the branch owns no sessions", async () => {
    respondWith(200, { hasSessions: false, count: 0 });
    await expect(fetchBranchHasSidechat("chat-1", "br-1")).resolves.toBe(false);
  });

  test("false on a failed summary (best-effort: never blocks the confirm)", async () => {
    respondWith(500, { error: "boom" });
    await expect(fetchBranchHasSidechat("chat-1", "br-1")).resolves.toBe(false);
  });

  test("false without a network call when chat or branch is unknown", async () => {
    respondWith(200, { hasSessions: true, count: 1 });
    await expect(fetchBranchHasSidechat(null, "br-1")).resolves.toBe(false);
    await expect(fetchBranchHasSidechat("chat-1", null)).resolves.toBe(false);
    expect(capturedUrl).toBe("");
  });
});

describe("deleteBranchConfirmBody", () => {
  test("without sessions returns today's body byte-identical", () => {
    expect(deleteBranchConfirmBody(t, "base body.", false)).toBe("base body.");
  });

  test("with sessions appends the warning sentence after a space", () => {
    expect(deleteBranchConfirmBody(t, "base body.", true)).toBe(
      "base body. sidebar_delete_branch_sidechat_warning",
    );
  });
});

describe("openDeleteBranchConfirm", () => {
  test("with sessions the confirm opens with the appended body; onConfirm passes through", async () => {
    respondWith(200, { hasSessions: true, count: 1 });
    const setConfirmDestroy = mock();
    const onConfirm = mock();
    await openDeleteBranchConfirm({
      t,
      chatId: "chat-1",
      branchId: "br-2",
      setConfirmDestroy,
      onConfirm,
    });
    expect(setConfirmDestroy).toHaveBeenCalledTimes(1);
    const dialog = setConfirmDestroy.mock.calls[0][0];
    expect(dialog.title).toBe("sidebar_delete_branch");
    expect(dialog.body).toBe("sidebar_delete_branch_body sidebar_delete_branch_sidechat_warning");
    expect(dialog.confirmLabel).toBe("sidebar_delete_branch");
    expect(dialog.tone).toBeUndefined();
    dialog.onConfirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("without sessions the confirm body is today's sentence", async () => {
    respondWith(200, { hasSessions: false, count: 0 });
    const setConfirmDestroy = mock();
    await openDeleteBranchConfirm({
      t,
      chatId: "chat-1",
      branchId: "br-1",
      setConfirmDestroy,
      onConfirm: () => {},
    });
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe("sidebar_delete_branch_body");
  });

  test("on summary failure the confirm still opens, without the append", async () => {
    respondWith(500, { error: "boom" });
    const setConfirmDestroy = mock();
    await openDeleteBranchConfirm({
      t,
      chatId: "chat-1",
      branchId: "br-1",
      setConfirmDestroy,
      onConfirm: () => {},
    });
    expect(setConfirmDestroy).toHaveBeenCalledTimes(1);
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe("sidebar_delete_branch_body");
  });
});
