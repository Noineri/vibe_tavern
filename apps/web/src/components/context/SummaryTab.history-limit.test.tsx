import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

useDomEnv();

const originalFetch = globalThis.fetch;
const originalSnapshotState = useSnapshotStore.getState();
const originalBootstrapState = useBootstrapStore.getState();
const hadOwnMatchMedia = Object.prototype.hasOwnProperty.call(window, "matchMedia");
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const memorySettingsPatches: Array<{ messageHistoryLimit?: number }> = [];
const requests: string[] = [];
let mobileViewport = false;

const harnessProps = {
	isOpen: true,
	onClose: () => {},
	activeChatId: "chat" as ChatId,
	providers: [],
	contextWindow: { used: 0, limit: 1 },
	currentSummary: "",
	messageCount: 12,
	messageHistoryLimit: 4,
	autoSummaryConfig: undefined,
	onSummarize: async () => "",
	onSaveSummary: async () => "",
	onFetchModelsForProfile: async () => [],
};

function restoreMatchMedia(): void {
	if (hadOwnMatchMedia && originalMatchMedia) {
		Object.defineProperty(window, "matchMedia", originalMatchMedia);
	} else {
		delete (window as unknown as { matchMedia?: typeof window.matchMedia }).matchMedia;
	}
}

function matchMedia(query: string): MediaQueryList {
	return {
		matches: mobileViewport && query === "(max-width: 768px)",
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	};
}

async function routerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	const pathname = new URL(url, "http://localhost").pathname;
	const apiPath = pathname.startsWith("/null/api/") ? pathname.slice("/null".length) : pathname;
	requests.push(`${method} ${apiPath}`);

	if (method === "GET" && apiPath === "/api/chats/chat/summaries") {
		return Response.json([]);
	}
	if (method === "PATCH" && apiPath === "/api/chats/chat/memory-settings") {
		const body = input instanceof Request
			? await input.clone().json() as { messageHistoryLimit?: number }
			: JSON.parse(String(init?.body)) as { messageHistoryLimit?: number };
		memorySettingsPatches.push(body);
		return Response.json({});
	}

	throw new Error(`Unexpected fetch: ${method} ${apiPath}`);
}

const fetchRouter = Object.assign(routerFetch, { preconnect: originalFetch.preconnect });

let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let useSummaryTab: typeof import("./SummaryTab.js").useSummaryTab;

beforeAll(async () => {
	({ act, fireEvent, render, waitFor } = await import("@testing-library/react"));
	({ useSummaryTab } = await import("./SummaryTab.js"));
});

beforeEach(() => {
	globalThis.fetch = originalFetch;
	restoreMatchMedia();
	useSnapshotStore.setState(originalSnapshotState, true);
	useBootstrapStore.setState(originalBootstrapState, true);
	mobileViewport = false;
	memorySettingsPatches.length = 0;
	requests.length = 0;
	window.matchMedia = matchMedia;
	globalThis.fetch = fetchRouter;
	useSnapshotStore.setState({ messagesById: {}, messageOrder: [], activeBranch: null });
	useBootstrapStore.setState({ data: null });
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	restoreMatchMedia();
	useSnapshotStore.setState(originalSnapshotState, true);
	useBootstrapStore.setState(originalBootstrapState, true);
});

function Harness() {
	const tab = useSummaryTab(harnessProps);
	return <>{tab.detailEditor}{tab.footer}</>;
}

async function expectHistoryLimitCommit(value: "7" | "9"): Promise<void> {
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(<Harness />);
	});
	const range = view.getByLabelText("summary_messages_in_prompt") as HTMLInputElement;
	expect(range.closest("[data-slider-root]")?.querySelectorAll('input[type="range"]')).toHaveLength(1);

	await act(async () => {
		fireEvent.change(range, { target: { value } });
	});
	expect(range.value).toBe(value);
	await waitFor(() => { expect(memorySettingsPatches, requests.join(", ")).toHaveLength(1); });
	expect(memorySettingsPatches[0]?.messageHistoryLimit).toBe(Number(value));
}

describe("SummaryTab history limit", () => {
	for (const mobile of [false, true]) {
		it(`renders the ${mobile ? "mobile" : "desktop"} message range as a labeled field without captions or an extra box`, async () => {
			mobileViewport = mobile;
			let view!: ReturnType<typeof render>;
			await act(async () => { view = render(<Harness />); });
			const range = view.getByTestId("range-start-input");
			const shell = range.closest<HTMLElement>("[data-slider-field-shell]");
			if (!shell) throw new Error("Missing message range field");
			const section = shell.closest("section");
			expect(view.getByText("summary_range_label").parentElement).toBe(section);
			expect(shell.querySelector("[data-slider-field-label]")?.textContent).toBe("summary_range_field_label");
			expect(shell.querySelector("[data-slider-field-value]")?.textContent).toBe("summary_range_value");
			expect(shell.parentElement).toBe(section);
			expect(section?.querySelector(".bg-input-bg, .p-4, .rounded-full")).toBeNull();
			expect(view.queryByText(/summary_msg_label|summary_messages_count/)).toBeNull();
		});
	}

	it("keeps desktop slider ticks local and persists through the real memory-settings PATCH", async () => {
		await expectHistoryLimitCommit("7");
	});

	it("keeps mobile slider ticks local and persists through the real memory-settings PATCH", async () => {
		mobileViewport = true;
		await expectHistoryLimitCommit("9");
	});
});
