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

async function renderHistoryField() {
	let view!: ReturnType<typeof render>;
	await act(async () => { view = render(<Harness />); });
	const range = view.getByLabelText("summary_messages_in_prompt") as HTMLInputElement;
	const shell = range.closest<HTMLElement>("[data-slider-field-shell]");
	if (!shell) throw new Error("Missing history limit field");
	return { view, range, shell };
}

async function openHistoryEditor(range: HTMLInputElement, shell: HTMLElement): Promise<HTMLInputElement> {
	await act(async () => { fireEvent.keyDown(range, { key: "Enter" }); });
	const editor = shell.querySelector<HTMLInputElement>("[data-slider-field-editor] input");
	if (!editor) throw new Error("Missing inline history editor");
	expect(editor.tagName).toBe("INPUT");
	expect(editor.type).toBe("text");
	return editor;
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
		it(`renders one ${mobile ? "mobile" : "desktop"} history field with an inside label and Auto beside it`, async () => {
			mobileViewport = mobile;
			const { view, range, shell } = await renderHistoryField();
			expect(range.type).toBe("range");
			expect(shell.querySelectorAll("[data-slider-field]")).toHaveLength(1);
			expect(shell.querySelector("[data-slider-field-label]")?.textContent).toBe("summary_messages_in_prompt");
			expect(view.getAllByText("summary_messages_in_prompt")).toHaveLength(1);
			const row = shell.parentElement?.parentElement;
			if (!row) throw new Error("Missing history field row");
			expect(row.querySelectorAll("[data-slider-field-shell]")).toHaveLength(1);
			expect(row.querySelectorAll("input")).toHaveLength(1);
			expect(shell.querySelector("[data-slider-field-editor]")).toBeNull();
			const auto = view.getByRole("switch", { name: "summary_history_auto" });
			expect(auto.parentElement?.parentElement).toBe(row);
			expect(auto.parentElement?.title).toBe("summary_history_auto_hint");
			expect(view.getByText("summary_history_auto").parentElement).toBe(auto.parentElement);
			if (mobile) {
				const section = row.closest("section");
				expect(section?.classList.contains("bg-input-bg")).toBe(true);
				expect(section?.classList.contains("p-4")).toBe(true);
			}
		});

		for (const [typed, expected] of [["7.6", 8], ["999", harnessProps.messageCount]] as const) {
			it(`commits ${mobile ? "mobile" : "desktop"} typed ${typed} as ${expected} through one memory-settings PATCH`, async () => {
				mobileViewport = mobile;
				const { range, shell } = await renderHistoryField();
				const editor = await openHistoryEditor(range, shell);
				await act(async () => { fireEvent.change(editor, { target: { value: typed } }); });
				expect(memorySettingsPatches).toHaveLength(0);
				await act(async () => { fireEvent.keyDown(editor, { key: "Enter" }); });
				await waitFor(() => { expect(memorySettingsPatches, requests.join(", ")).toHaveLength(1); });
				expect(memorySettingsPatches[0]?.messageHistoryLimit).toBe(expected);
				expect(range.value).toBe(String(expected));
				expect(shell.querySelector("[data-slider-field-editor]")).toBeNull();
			});
		}

		it(`does not PATCH an untouched ${mobile ? "mobile" : "desktop"} inline history edit`, async () => {
			mobileViewport = mobile;
			const { range, shell } = await renderHistoryField();
			const editor = await openHistoryEditor(range, shell);
			await act(async () => { fireEvent.blur(editor); });
			expect(memorySettingsPatches).toHaveLength(0);
			expect(range.value).toBe("4");
			expect(shell.querySelector("[data-slider-field-editor]")).toBeNull();
		});

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

	it("keeps history pointer ticks local and sends one PATCH on release", async () => {
		const { range, shell } = await renderHistoryField();
		const field = shell.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing history scrub field");
		Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 110 }) });
		await act(async () => {
			fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 40, button: 0 });
		});
		expect(range.value).toBe("5");
		expect(memorySettingsPatches).toHaveLength(0);
		await act(async () => {
			fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 60 });
		});
		expect(range.value).toBe("7");
		expect(memorySettingsPatches).toHaveLength(0);
		await act(async () => {
			fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 60 });
		});
		await waitFor(() => { expect(memorySettingsPatches, requests.join(", ")).toHaveLength(1); });
		expect(memorySettingsPatches[0]?.messageHistoryLimit).toBe(7);
	});

	it("keeps desktop slider ticks local and persists through the real memory-settings PATCH", async () => {
		await expectHistoryLimitCommit("7");
	});

	it("keeps mobile slider ticks local and persists through the real memory-settings PATCH", async () => {
		mobileViewport = true;
		await expectHistoryLimitCommit("9");
	});
});
