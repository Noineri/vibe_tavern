/**
 * SidebarFlyout — SC-21 delete-branch confirm coverage for the second delete
 * site.
 *
 * The delete-branch derivation itself is pinned without DOM in
 * `lib/branch-sidechat-confirm.test.ts` (with/without sessions, failure
 * fallback); this file pins that THIS site opens the confirm through that
 * same shared helper — with sessions the body carries the warning, without
 * sessions it is today's sentence.
 *
 * Radix note: the branch section lives inside `Popover.Content`, which (like
 * the `DropdownMenu` content documented in `RichChatRow.test.tsx`) was
 * suspected not to mount under happy-dom — it DOES mount here (the badge is
 * found and the confirm fires), so this file pins the full DOM path, not a
 * delegation seam.
 */
import { afterAll, beforeEach, describe, it, expect, mock } from "bun:test";

import { useDomEnv } from "../../../../test/dom-env.js";
import type { ReactNode } from "react";
import type { ChatBranch, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";

useDomEnv();

const { render, fireEvent, waitFor } = await import("@testing-library/react");

const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const { SidebarFlyout } = await import("./SidebarFlyout.js");

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
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function branchBadge(container: HTMLElement): HTMLElement | null {
  return container.querySelector('button[aria-label="sidebar_chat_branches"]');
}

function renderFlyout(setConfirmDestroy: ReturnType<typeof mock>) {
  const view = render(
    <SidebarFlyout
      flyoutCharId="char-1"
      sidebarCollapsed={true}
      characterTabs={[{ id: "char-1", name: "Aria", subtitle: "", chatId: null, avatarAssetId: null, avatarCropJson: null, avatarExt: null, updatedAt: "" }]}
      flyoutChats={[{ id: "chat-1", title: "Chat", characterId: "char-1", characterName: "Aria", subtitle: "", activeBranchLabel: "", mode: "rp", messageCount: 1, updatedAt: "" } as unknown as ChatListItem]}
      chatQuery=""
      setChatQuery={() => {}}
      activeChatId={"chat-1" as unknown as ChatId}
      chat={{ handleSwitchChat: mock(), handleActivateBranch: mock(), handleFork: mock(), handleDeleteActiveBranch: mock(), handleRenameBranch: mock() } as unknown as ChatControllerActions}
      character={{ handleCreateChat: mock(), getChatRemovalMode: mock(() => "keep") } as unknown as CharacterControllerActions}
      setConfirmDestroy={setConfirmDestroy}
      branches={[
        { id: "br-1", chatId: "chat-1", parentBranchId: null, forkedFromMessageId: null, label: "main", createdAt: "", messageCount: 1 },
        { id: "br-2", chatId: "chat-1", parentBranchId: "br-1", forkedFromMessageId: null, label: "alt", createdAt: "", messageCount: 1 },
      ] as unknown as ChatBranch[]}
      activeBranchId={"br-2" as unknown as ChatBranchId}
      setFlyoutCharId={() => {}}
      flyoutAvatarPos={{ top: 0, bottom: 10 }}
      t={(key: string) => key}
    />,
  );
  return view;
}

async function clickDeleteBranch(view: { baseElement: Element }): Promise<void> {
  const container = view.baseElement as HTMLElement;
  const badge = branchBadge(container) ?? branchBadge(document.body as unknown as HTMLElement);
  if (!badge) throw new Error("branch badge missing — Popover.Content did not mount");
  fireEvent.click(badge);
  const root = view.baseElement as HTMLElement;
  const delBtn = Array.from(root.querySelectorAll("button"))
    .concat(Array.from(document.body.querySelectorAll("button")))
    .find((b) => b.textContent?.includes("sidebar_delete_branch_short")) as HTMLElement;
  fireEvent.click(delBtn);
}

describe("SidebarFlyout SC-21 delete-branch confirm", () => {
  it("with sessions the confirm body carries the warning", async () => {
    respondSummary(200, { hasSessions: true, count: 1 });
    const setConfirmDestroy = mock();
    const view = renderFlyout(setConfirmDestroy);
    await clickDeleteBranch(view);
    await waitFor(() => expect(setConfirmDestroy).toHaveBeenCalledTimes(1));
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe(
      "sidebar_delete_branch_body sidebar_delete_branch_sidechat_warning",
    );
    view.unmount();
  });

  it("without sessions the confirm body is today's sentence", async () => {
    respondSummary(200, { hasSessions: false, count: 0 });
    const setConfirmDestroy = mock();
    const view = renderFlyout(setConfirmDestroy);
    await clickDeleteBranch(view);
    await waitFor(() => expect(setConfirmDestroy).toHaveBeenCalledTimes(1));
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe("sidebar_delete_branch_body");
    view.unmount();
  });
});
