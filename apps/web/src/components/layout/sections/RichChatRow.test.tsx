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
 * `DropdownMenu` whose `Content` does not mount under happy-dom (re-verified
 * under vitest — same limitation documented in DropdownSelect.test.tsx's skip
 * note). So the menu-triggered actions (rename entry, export-JSONL, clear/delete
 * chat confirm) are NOT unit-tested here; they are covered by the slice
 * typecheck gate + the end-of-slice live visual check.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

import { RichChatRow } from "./RichChatRow.js";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ChatBranch, ChatBranchId } from "@vibe-tavern/domain";

const NOOP = () => {};

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

interface RowHarness extends RenderResult {
  chat: Record<string, ReturnType<typeof vi.fn>>;
  character: Record<string, ReturnType<typeof vi.fn>>;
  setConfirmDestroy: ReturnType<typeof vi.fn>;
}

function renderRow(opts: { isActive?: boolean; activeBranchId?: string; branches?: ChatBranch[]; removalMode?: "keep" | "clear" } = {}): RowHarness {
  const chat = {
    handleSwitchChat: vi.fn(),
    handleActivateBranch: vi.fn(),
    handleRenameBranch: vi.fn(),
    handleFork: vi.fn(),
    handleDeleteActiveBranch: vi.fn(),
  };
  const character = {
    getChatRemovalMode: vi.fn(() => opts.removalMode ?? "keep"),
    handleRenameChat: vi.fn(),
    handleExportChatJsonl: vi.fn(),
    handleRemoveChat: vi.fn(),
  };
  const setConfirmDestroy = vi.fn();
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

  it("delete-branch fires setConfirmDestroy when enabled (non-root active branch, >1 branch)", () => {
    const { container, setConfirmDestroy } = renderRow({ activeBranchId: "br-2", branches: TWO_BRANCHES });
    fireEvent.click(branchChip(container));
    const delBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("sidebar_delete_branch_short")) as HTMLElement;
    expect(delBtn.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(delBtn);
    expect(setConfirmDestroy).toHaveBeenCalledTimes(1);
    expect(setConfirmDestroy.mock.calls[0][0]).toMatchObject({ title: "sidebar_delete_branch", confirmLabel: "sidebar_delete_branch" });
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

// Touch NOOP so the unused import alias is not flagged by tooling that scans for it.
void NOOP;
