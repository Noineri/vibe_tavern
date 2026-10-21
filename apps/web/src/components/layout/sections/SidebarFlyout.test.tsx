/**
 * SidebarFlyout — two coverage families share this file.
 *
 * SC-21 (delete-branch confirm): the delete-branch derivation itself is
 * pinned without DOM in `lib/branch-sidechat-confirm.test.ts` (with/without
 * sessions, failure fallback); the SC-21 describe below pins that THIS site
 * opens the confirm through that same shared helper — with sessions the body
 * carries the warning, without sessions it is today's sentence.
 *
 * RAIL_DRILL_IN RD-2 (characterization): RD-2 moved the «can the active
 * branch be deleted» rule out of the flyout's inline lines into
 * `canDeleteActiveBranch` (sidebar-utils.ts). The branch-actions describe
 * pins the surface that rule drives: the branch badge opens the block,
 * «Delete» is `aria-disabled` + muted on the root branch / with a single
 * branch and raises the confirm otherwise, and «Branch» forks. (The
 * pre-existing flyout had no test; these assertions were run against the
 * pre-extraction source first, then the extracted one.)
 *
 * The Radix `Popover` (virtual anchor, portaled) mounts under happy-dom; the
 * tooltip primitive is replaced by a pass-through so the branch buttons are
 * queried directly. `useT` is mocked at its module boundary (keys verbatim,
 * `...real` spread).
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import type { ReactNode } from "react";
import { brandId, type ChatBranch, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { CharacterTab } from "../app-shell-types.js";
import type { TFn } from "./section-types.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");

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

// ─── SC-21: the sidechat-aware delete confirm through the shared helper ──────

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

function renderSc21Flyout(setConfirmDestroy: ReturnType<typeof mock>) {
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
    const view = renderSc21Flyout(setConfirmDestroy);
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
    const view = renderSc21Flyout(setConfirmDestroy);
    await clickDeleteBranch(view);
    await waitFor(() => expect(setConfirmDestroy).toHaveBeenCalledTimes(1));
    expect(setConfirmDestroy.mock.calls[0][0].body).toBe("sidebar_delete_branch_body");
    view.unmount();
  });
});

// ─── RD-2: the extracted delete rule, characterized through the flyout ───────

const CHAT_1 = brandId<ChatId>("chat-1");
const BR_ROOT = brandId<ChatBranchId>("br-root");
const BR_ALT = brandId<ChatBranchId>("br-alt");

const TAB: CharacterTab = {
	id: "char-1",
	name: "Aria",
	subtitle: "",
	chatId: CHAT_1,
	avatarAssetId: null,
	avatarCropJson: null,
	avatarExt: null,
	updatedAt: "2026-01-01T00:00:00Z",
};

const CHAT = {
	id: CHAT_1,
	title: "Moonlit Harbor",
	characterId: "char-1",
	characterName: "Aria",
	subtitle: "",
	activeBranchLabel: "",
	mode: "rp",
	messageCount: 5,
	lastMessageAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
} as unknown as ChatListItem;

function makeBranch(id: ChatBranchId, label: string, parentBranchId: ChatBranchId | null): ChatBranch {
	return { id, chatId: CHAT_1, parentBranchId, forkedFromMessageId: null, label, createdAt: "2026-01-01T00:00:00Z", messageCount: 5 } as ChatBranch;
}

const t: TFn = (key) => key;

const TWO_BRANCHES = [makeBranch(BR_ROOT, "main", null), makeBranch(BR_ALT, "alt", BR_ROOT)];

async function renderFlyout(opts: { activeBranchId?: ChatBranchId; branches?: ChatBranch[] } = {}) {
	const chat = {
		handleSwitchChat: mock(async (_id: ChatId): Promise<void> => {}),
		handleActivateBranch: mock(async (_id: ChatBranchId): Promise<void> => {}),
		handleRenameBranch: mock(async (_id: ChatBranchId, _label: string): Promise<void> => {}),
		handleFork: mock(async (_messageId?: string): Promise<void> => {}),
		handleDeleteActiveBranch: mock(async (): Promise<void> => {}),
	};
	const setConfirmDestroy = mock();
	// Radix Popper positions asynchronously after mount: render inside an async act so those
	// state updates settle before the assertions (and do not leak as act warnings).
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(
			<SidebarFlyout
				flyoutCharId="char-1"
				sidebarCollapsed={true}
				characterTabs={[TAB]}
				flyoutChats={[CHAT]}
				chatQuery=""
				setChatQuery={() => {}}
				activeChatId={CHAT_1}
				chat={chat as unknown as ChatControllerActions}
				character={{ handleCreateChat: mock() } as unknown as CharacterControllerActions}
				setConfirmDestroy={setConfirmDestroy}
				branches={opts.branches ?? TWO_BRANCHES}
				activeBranchId={opts.activeBranchId ?? BR_ROOT}
				setFlyoutCharId={() => {}}
				flyoutAvatarPos={{ top: 10, bottom: 50 }}
				t={t}
			/>,
		);
	});
	return { ...view, chat, setConfirmDestroy };
}

type FlyoutView = Awaited<ReturnType<typeof renderFlyout>>;

/** The portaled flyout content lives outside the render container — query the whole document body. */
function badge(view: FlyoutView): HTMLElement {
	const el = view.baseElement.querySelector<HTMLElement>('button[aria-label="sidebar_chat_branches"]');
	if (!el) throw new Error("no branch badge");
	return el;
}

function button(view: FlyoutView, text: string): HTMLButtonElement {
	const btn = view.getByText(text).closest("button");
	if (!btn) throw new Error(`no button for "${text}"`);
	return btn;
}

describe("SidebarFlyout — branch actions", () => {
	it("the branch block is collapsed until the badge is tapped, then shows the actions", async () => {
		const view = await renderFlyout();
		expect(view.queryByText("sidebar_timeline_branches")).toBeNull();
		fireEvent.click(badge(view));
		expect(view.getByText("sidebar_timeline_branches")).toBeTruthy();
		expect(view.getByText("main")).toBeTruthy();
		expect(view.getByText("alt")).toBeTruthy();
	});

	it("«Delete» on a side branch is enabled and raises the confirm; confirming deletes the active branch", async () => {
		// Was (RD-2): the confirm opened synchronously from the click. Now
		// (SC-21) the handler opens it through `openDeleteBranchConfirm`,
		// which resolves the best-effort summary first — park on the resolved
		// state (waitFor) with a deterministic mocked summary instead of a
		// synchronous assertion racing the fetch.
		respondSummary(200, { hasSessions: false, count: 0 });
		const view = await renderFlyout({ activeBranchId: BR_ALT });
		fireEvent.click(badge(view));
		const del = button(view, "sidebar_delete_branch_short");
		expect(del.getAttribute("aria-disabled")).toBe("false");
		expect(del.className).not.toContain("opacity-45");
		fireEvent.click(del);
		await waitFor(() => expect(view.setConfirmDestroy).toHaveBeenCalledTimes(1));
		const dialog = view.setConfirmDestroy.mock.calls[0][0];
		expect(dialog).toMatchObject({ title: "sidebar_delete_branch", body: "sidebar_delete_branch_body", confirmLabel: "sidebar_delete_branch" });
		dialog.onConfirm();
		expect(view.chat.handleDeleteActiveBranch).toHaveBeenCalledTimes(1);
	});

	it("«Delete» is aria-disabled and muted on the root branch and does nothing", async () => {
		const view = await renderFlyout({ activeBranchId: BR_ROOT });
		fireEvent.click(badge(view));
		const del = button(view, "sidebar_delete_branch_short");
		expect(del.getAttribute("aria-disabled")).toBe("true");
		expect(del.className).toContain("opacity-45");
		expect(del.className).toContain("cursor-not-allowed");
		fireEvent.click(del);
		expect(view.setConfirmDestroy).not.toHaveBeenCalled();
		expect(view.chat.handleDeleteActiveBranch).not.toHaveBeenCalled();
	});

	it("«Delete» is aria-disabled when the chat has a single branch", async () => {
		const view = await renderFlyout({ branches: [makeBranch(BR_ROOT, "main", null)], activeBranchId: BR_ROOT });
		fireEvent.click(badge(view));
		expect(button(view, "sidebar_delete_branch_short").getAttribute("aria-disabled")).toBe("true");
	});

	it("«Branch» forks the active chat from its tail", async () => {
		const view = await renderFlyout();
		fireEvent.click(badge(view));
		fireEvent.click(button(view, "sidebar_fork_short"));
		expect(view.chat.handleFork).toHaveBeenCalledTimes(1);
		expect(view.chat.handleFork).toHaveBeenCalledWith(undefined);
	});
});
