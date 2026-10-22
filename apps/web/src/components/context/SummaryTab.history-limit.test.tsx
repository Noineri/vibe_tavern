import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const state = { mobile: false, writes: [] as Array<{ messageHistoryLimit: number }> };
const noModels = async () => [];
const noSummary = async () => "";
const snapshotState = { messagesById: {}, messageOrder: [], activeBranch: { id: "branch" } };
const bootstrapState = { data: null };
const harnessProps = {
	isOpen: true,
	onClose: () => {},
	activeChatId: "chat" as import("@vibe-tavern/domain").ChatId,
	providers: [],
	contextWindow: { used: 0, limit: 1 },
	currentSummary: "",
	messageCount: 12,
	messageHistoryLimit: 4,
	autoSummaryConfig: undefined,
	onSummarize: noSummary,
	onSaveSummary: noSummary,
	onFetchModelsForProfile: noModels,
};
const realMobile = await import("../../hooks/use-mobile.js");
const realSnapshot = await import("../../stores/snapshot-store.js");
const realBootstrap = await import("../../stores/api-actions/bootstrap-actions.js");
const realActions = await import("../../stores/api-actions/chat-actions.js");

mock.module("../../hooks/use-mobile.js", () => ({ ...realMobile, useIsMobile: () => state.mobile }));
mock.module("../../stores/snapshot-store.js", () => ({
	...realSnapshot,
	useSnapshotStore: (selector: (value: { messagesById: Record<string, never>; messageOrder: string[]; activeBranch: { id: string } }) => unknown) =>
		selector(snapshotState),
}));
mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({
	...realBootstrap,
	useBootstrapStore: (selector: (value: { data: null }) => unknown) => selector(bootstrapState),
}));
mock.module("../../stores/api-actions/chat-actions.js", () => ({
	...realActions,
	updateMemorySettingsAction: async (_chatId: string, value: { messageHistoryLimit: number }) => { state.writes.push(value); },
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let useSummaryTab: typeof import("./SummaryTab.js").useSummaryTab;

beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ useSummaryTab } = await import("./SummaryTab.js"));
});

beforeEach(() => { state.mobile = false; state.writes = []; });
afterAll(() => { state.mobile = false; state.writes = []; });

function Harness() {
	const tab = useSummaryTab(harnessProps);
	return <>{tab.detailEditor}{tab.footer}</>;
}

describe("SummaryTab history limit", () => {
	it("keeps desktop range ticks local and persists at the shared slider commit boundary", () => {
		const { getByLabelText } = render(<Harness />);
		const range = getByLabelText("summary_messages_in_prompt") as HTMLInputElement;
		fireEvent.change(range, { target: { value: "7" } });
		expect(range.value).toBe("7");
		expect(state.writes[0]?.messageHistoryLimit).toBe(7);
	});

	it("keeps mobile range ticks local and persists at the shared slider commit boundary", () => {
		state.mobile = true;
		const { getByLabelText } = render(<Harness />);
		const range = getByLabelText("summary_messages_in_prompt") as HTMLInputElement;
		fireEvent.change(range, { target: { value: "9" } });
		expect(range.value).toBe("9");
		expect(state.writes[0]?.messageHistoryLimit).toBe(9);
	});
});
