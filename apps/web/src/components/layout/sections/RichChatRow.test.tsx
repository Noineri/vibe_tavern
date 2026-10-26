/**
 * RichChatRow characterization test.
 *
 * Pins the interactive surface of the RP chat-list row that was extracted out
 * of Sidebar.tsx (SIDEBAR_GOD_OBJECT_AUDIT step 3c). The branch popover (a
 * plain `<div>`, NOT Radix) is driven directly: chip toggles it open/closed,
 * branch rows activate, fork/delete-branch fire their handlers, and an outside
 * mousedown closes it. The rename flow is pinned separately in
 * SidebarChatRename.test.tsx (the input is the only testable seam — see that
 * file's header for why).
 *
 * OUT OF REACH HERE (Radix limitation): the context menu is a Radix
 * `DropdownMenu` whose `Content` does not mount under happy-dom (same
 * limitation documented in DropdownSelect.test.tsx's skip note). So the
 * menu-triggered actions (rename entry, export-JSONL, clear/delete
 * chat confirm) are NOT unit-tested here; they are covered by the slice
 * typecheck gate + the end-of-slice live visual check.
 */
import { afterAll, beforeEach, describe, it, expect, mock } from "bun:test";

import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { ReactNode } from "react";

useDomEnv();

const { render, fireEvent, waitFor } = await import("@testing-library/react");

// SC-21: the delete-branch confirm now fetches the sidechat summary when it
// opens (best-effort — a failure opens today's confirm). Patched fetch is
// restored before every test and after the file (R3).

const realTooltip = await import("../../shared/Tooltip.js");
installI18nContextSeam();

mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ChatBranch, ChatBranchId } from "@vibe-tavern/domain";

const { RichChatRow } = await import("./RichChatRow.js");

const originalFetch = globalThis.fetch;

type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function respondSummary(status: number, body: unknown): void {
  globalThis.fetch = Object.assign(
    mock<FetchImplementation>(async () => {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
    { preconnect: originalFetch.preconnect },
  );
}

beforeEach(() => {
  // Default: no sidechat sessions — keeps the pre-SC-21 delete test on
  // today's body; the SC-21 cases below re-patch per test.
  respondSummary(200, { hasSessions: false, count: 0 });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const chatItem = {
  id: "chat-1",
  title: "My Chat",
  characterId: "char-1",
  characterName: "Aria",
  subtitle: "",
  activeBranchLabel: "",
  mode: "rp" as const,
  messageCount: 5,
  updatedAt: "2026-01-01T00:00:00Z",
} as unknown as ChatListItem;

function makeBranch(id: string, label: string, parent: string | null, count: number): ChatBranch {
  return {
    id,
    chatId: "chat-1",
    parentBranchId: parent,
    forkedFromMessageId: null,
    label,
    createdAt: "2026-01-01T00:00:00Z",
    messageCount: count,
  } as unknown as ChatBranch;
}

const TWO_BRANCHES = [
  makeBranch("br-1", "main", null, 5), // root
  makeBranch("br-2", "alt", "br-1", 2),
];

function renderRow(opts: { isActive?: boolean; activeBranchId?: string; branches?: ChatBranch[]; removalMode?: "keep" | "clear" } = {}) {
  const chat = {
    handleSwitchChat: mock(),
    handleActivateBranch: mock(),
    handleRenameBranch: mock(),
    handleFork: mock(),
    handleDeleteActiveBranch: mock(),
  };
  const character = {
    getChatRemovalMode: mock(() => opts.removalMode ?? "keep"),
    handleRenameChat: mock(),
    handleExportChatJsonl: mock(),
    handleRemoveChat: mock(),
  };
  const setConfirmDestroy = mock();
  const result = render(
    <RichChatRow
      chatItem={chatItem}
      isActive={opts.isActive ?? true}
      branches={opts.branches ?? TWO_BRANCHES}
      activeBranchId={(opts.activeBranchId ?? "br-1") as ChatBranchId}
      chat={chat as unknown as ChatControllerActions}
      character={character as unknown as CharacterControllerActions}
      setConfirmDestroy={setConfirmDestroy}
    />,
  );
  return { ...result, chat, character, setConfirmDestroy };
}

/** The branch chip is the only `.inline-flex.cursor-pointer.tabular-nums` element. */
function branchChip(container: HTMLElement): HTMLElement {
  return container.querySelector(".inline-flex.cursor-pointer.tabular-nums") as HTMLElement;
}

describe("RichChatRow", () => {
  it("renders the title, character name, and message count", () => {
    const { container } = renderRow();
    expect(container.textContent).toContain("My Chat");
    expect(container.textContent).toContain("Aria");
    expect(container.textContent).toContain("5");
    expect(container.textContent).toContain("msgs_short");
  });

  it("shows the branch chip with the branch count on an active row with branches", () => {
    const { container } = renderRow();
    const chip = branchChip(container);
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("2"); // TWO_BRANCHES.length
  });

  it("does NOT show a branch chip on a non-active row", () => {
    const { container } = renderRow({ isActive: false });
    expect(branchChip(container)).toBeFalsy();
  });

  it("clicking the row calls chat.handleSwitchChat with the chat id", () => {
    const { container, chat } = renderRow();
    // The clickable row surface is the first child div of the row root.
    const rowSurface = container.querySelector(".group > div") as HTMLElement;
    fireEvent.click(rowSurface);
    expect(chat.handleSwitchChat).toHaveBeenCalledWith("chat-1");
  });

  it("chip click opens the branch popover (timeline header appears)", () => {
    const { container } = renderRow();
    expect(container.textContent).not.toContain("sidebar_timeline_branches");
    fireEvent.click(branchChip(container));
    expect(container.textContent).toContain("sidebar_timeline_branches");
  });

  it("popover lists each branch with label + message count; active branch is highlighted", () => {
    const { container } = renderRow();
    fireEvent.click(branchChip(container));
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("alt");
    // active branch (br-1) row carries the accent background class
    const activeRow = Array.from(container.querySelectorAll(".group\\/branch")).find((el) => el.textContent?.includes("main"));
    expect(activeRow?.className).toContain("bg-accent-dim");
  });

  it("clicking a branch row calls chat.handleActivateBranch with that branch id", () => {
    const { container, chat } = renderRow();
    fireEvent.click(branchChip(container));
    const altRow = Array.from(container.querySelectorAll(".group\\/branch")).find((el) => el.textContent?.includes("alt")) as HTMLElement;
    fireEvent.click(altRow);
    expect(chat.handleActivateBranch).toHaveBeenCalledWith("br-2");
  });

  it("fork button calls chat.handleFork", () => {
    const { container, chat } = renderRow();
    fireEvent.click(branchChip(container));
    const forkBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("sidebar_fork_short")) as HTMLElement;
    fireEvent.click(forkBtn);
    expect(chat.handleFork).toHaveBeenCalled();
  });

  it("delete-branch is disabled when the active branch is the root", () => {
    const { container } = renderRow({ activeBranchId: "br-1", branches: TWO_BRANCHES });
    fireEvent.click(branchChip(container));
    const delBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("sidebar_delete_branch_short")) as HTMLElement;
    expect(delBtn.getAttribute("aria-disabled")).toBe("true");
    expect(delBtn.className).toContain("cursor-not-allowed");
  });

  it("delete-branch fires setConfirmDestroy when enabled (non-root active branch, >1 branch)", async () => {
    const { container, setConfirmDestroy } = renderRow({ activeBranchId: "br-2", branches: TWO_BRANCHES });
    fireEvent.click(branchChip(container));
    const delBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("sidebar_delete_branch_short")) as HTMLElement;
    expect(delBtn.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(delBtn);
    // SC-21: the confirm opens after the best-effort summary fetch.
    await waitFor(() => expect(setConfirmDestroy).toHaveBeenCalledTimes(1));
    expect(setConfirmDestroy.mock.calls[0][0]).toMatchObject({ title: "sidebar_delete_branch", confirmLabel: "sidebar_delete_branch" });
  });

  it("SC-21: delete-branch confirm appends the sidechat warning when the branch has sessions", async () => {
    respondSummary(200, { hasSessions: true, count: 2 });
    const { container, setConfirmDestroy } = renderRow({ activeBranchId: "br-2", branches: TWO_BRANCHES });
    fireEvent.click(branchChip(container));
    const delBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("sidebar_delete_branch_short")) as HTMLElement;
    fireEvent.click(delBtn);
    await waitFor(() => expect(setConfirmDestroy).toHaveBeenCalledTimes(1));
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe(
      "sidebar_delete_branch_body sidebar_delete_branch_sidechat_warning",
    );
  });

  it("SC-21: delete-branch confirm keeps today's body when the branch has no sessions", async () => {
    respondSummary(200, { hasSessions: false, count: 0 });
    const { container, setConfirmDestroy } = renderRow({ activeBranchId: "br-2", branches: TWO_BRANCHES });
    fireEvent.click(branchChip(container));
    const delBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("sidebar_delete_branch_short")) as HTMLElement;
    fireEvent.click(delBtn);
    await waitFor(() => expect(setConfirmDestroy).toHaveBeenCalledTimes(1));
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe("sidebar_delete_branch_body");
  });

  it("an outside mousedown closes the open branch popover", () => {
    const { container } = renderRow();
    fireEvent.click(branchChip(container));
    expect(container.textContent).toContain("sidebar_timeline_branches");
    // Simulate a click elsewhere: dispatch a mousedown on document.body.
    fireEvent.mouseDown(document.body);
    expect(container.textContent).not.toContain("sidebar_timeline_branches");
  });

  it("chip click closes the chat menu mutual-exclusion is a no-op here (menu is Radix) — chip toggle still closes popover on second click", () => {
    const { container } = renderRow();
    fireEvent.click(branchChip(container));
    expect(container.textContent).toContain("sidebar_timeline_branches");
    fireEvent.click(branchChip(container));
    expect(container.textContent).not.toContain("sidebar_timeline_branches");
  });
});
