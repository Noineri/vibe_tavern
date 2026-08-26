import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";
import type { ServicePromptProfile } from "@vibe-tavern/api-contracts";

const realI18n = await import("../../../i18n/context.js");
const realApi = await import("../../../api/service-prompt-api.js");
const stableT = (key: string, opts?: Record<string, unknown>) => {
	if (opts && typeof opts.count === "number") return `${key} ${opts.count}`;
	return key;
};
const stableTDynamic = (key: string, opts?: Record<string, unknown>) => {
	if (opts && typeof opts.count === "number") return `${key} ${opts.count}`;
	return key;
};
const realTooltip = await import("../../shared/Tooltip.js");

const listMock = mock(async () => ({ profiles: [] as ServicePromptProfile[], activeProfileId: null as string | null }));
const getDetailMock = mock(async (_id: string) => null as unknown as Awaited<ReturnType<typeof realApi.getServicePromptProfileDetail>>);
const createMock = mock(async (body: { name: string; overrides: Record<string, string> }) => ({ id: "new_id", name: body.name, isDefault: false, overrides: body.overrides, createdAt: "", updatedAt: "" } as ServicePromptProfile));
const updateMock = mock(async (id: string, body: { name?: string; overrides?: Record<string, string> }) => ({ id, name: body.name ?? "Renamed", isDefault: false, overrides: body.overrides ?? {}, createdAt: "", updatedAt: "" } as ServicePromptProfile));
const deleteMock = mock(async (_id: string) => undefined);
const setActiveMock = mock(async (_id: string | null) => undefined);

mock.module("../../../i18n/context.js", () => ({
	...realI18n,
	useT: () => ({
		t: stableT,
		tDynamic: stableTDynamic,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

mock.module("../../../api/service-prompt-api.js", () => ({
	...realApi,
	listServicePromptProfiles: listMock,
	getServicePromptProfileDetail: getDetailMock,
	createServicePromptProfile: createMock,
	updateServicePromptProfile: updateMock,
	deleteServicePromptProfile: deleteMock,
	setActiveServicePromptProfile: setActiveMock,
}));

mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
let ServicePromptsPane: typeof import("./ServicePromptsPane.js").ServicePromptsPane;

beforeAll(async () => {
	({ ServicePromptsPane } = await import("./ServicePromptsPane.js"));
});

afterEach(async () => {
	await act(async () => {});
	listMock.mockReset();
	getDetailMock.mockReset();
	createMock.mockReset();
	updateMock.mockReset();
	deleteMock.mockReset();
	setActiveMock.mockReset();
	listMock.mockResolvedValue({ profiles: [], activeProfileId: null });
	getDetailMock.mockResolvedValue(null);
	createMock.mockImplementation(async (body: { name: string; overrides: Record<string, string> }) => ({ id: "new_id", name: body.name, isDefault: false, overrides: body.overrides, createdAt: "", updatedAt: "" } as ServicePromptProfile));
	updateMock.mockImplementation(async (id: string, body: { name?: string; overrides?: Record<string, string> }) => ({ id, name: body.name ?? "Renamed", isDefault: false, overrides: body.overrides ?? {}, createdAt: "", updatedAt: "" } as ServicePromptProfile));
	deleteMock.mockResolvedValue(undefined);
	setActiveMock.mockResolvedValue(undefined);
});

function makeProfile(overrides: Partial<ServicePromptProfile> = {}): ServicePromptProfile {
	return {
		id: "p1",
		name: "My Profile",
		isDefault: false,
		overrides: {},
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function makeDefaultProfile(): ServicePromptProfile {
	return { id: "default", name: "Default", isDefault: true, overrides: {}, createdAt: "", updatedAt: "" };
}

function makeResolved(overrides: Record<string, string> = {}): Record<string, { override: string | null; default: string }> {
	const map: Record<string, { override: string | null; default: string }> = {};
	for (const k of SERVICE_PROMPT_FIELD_KEYS) {
		map[k] = { override: overrides[k] ?? null, default: `default-${k}-value` };
	}
	return map;
}

function Harness({ active = true }: { active?: boolean }) {
	return (
		<ServicePromptsPane active={active}>
			{({ master, detail, footer }) => (
				<div>
					<div data-testid="master">{master}</div>
					<div data-testid="detail">{detail}</div>
					<div data-testid="footer">{footer}</div>
				</div>
			)}
		</ServicePromptsPane>
	);
}

describe("ServicePromptsPane", () => {
	test("active=true loads list and renders Default pinned first with lock", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha" });
		const p3 = makeProfile({ id: "p3", name: "Beta" });
		listMock.mockResolvedValue({ profiles: [p3, def, p2], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId, getByText } = render(<Harness active={true} />);
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		await waitFor(() => expect(getByTestId("master").textContent).toContain("Default"));

		const master = getByTestId("master");
		const rows = Array.from(master.querySelectorAll("[data-testid^='service-row-']"));
		expect(rows.length).toBe(3);
		expect(rows[0].getAttribute("data-testid")).toBe("service-row-default");
		expect(master.innerHTML).toContain("<svg");
		expect(getByText("promptManager.servicePrompts.liveBadge")).toBeTruthy();
	});

	test("detail of non-Default renders all 21 fields grouped", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", overrides: { summary: "hello" } });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved({ summary: "hello" }) };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());

		await act(async () => { fireEvent.click(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		await waitFor(() => {
			const detail = getByTestId("detail");
			const textareas = detail.querySelectorAll("textarea");
			expect(textareas.length).toBe(SERVICE_PROMPT_FIELD_KEYS.length);
		});
		const detail = getByTestId("detail");
		expect(detail.textContent).toContain("promptManager.servicePrompts.family.assistant");
		expect(detail.textContent).toContain("promptManager.servicePrompts.family.summary");
		expect(detail.textContent).toContain("promptManager.servicePrompts.family.insights");
		expect(detail.textContent).toContain("promptManager.servicePrompts.family.bases");
	});

	test("Default detail: textareas disabled, duplicate button, no reset", async () => {
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId, queryByText } = render(<Harness active={true} />);
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		await waitFor(() => expect(getDetailMock).toHaveBeenCalled());
		await waitFor(() => {
			const detail = getByTestId("detail");
			const tas = detail.querySelectorAll("textarea");
			expect(tas.length).toBeGreaterThan(0);
			for (const ta of Array.from(tas)) {
				expect((ta as HTMLTextAreaElement).disabled).toBe(true);
			}
		});
		const footer = getByTestId("footer");
		expect(footer.textContent).toContain("promptManager.servicePrompts.duplicateButton");
		expect(queryByText("promptManager.servicePrompts.reset")).toBeNull();
	});

	test("reset clears override and enables save", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", overrides: { summary: "hello world" } });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved({ summary: "hello world" }) };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.click(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		await waitFor(() => expect(getByTestId("detail").querySelectorAll("textarea").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));

		const detail = getByTestId("detail");
		const resetButtons = Array.from(detail.querySelectorAll("button")).filter((b) => b.textContent?.includes("promptManager.servicePrompts.reset"));
		expect(resetButtons.length).toBeGreaterThan(0);
		await act(async () => { fireEvent.click(resetButtons[0]!); });
		await waitFor(() => {
			const after = Array.from(getByTestId("detail").querySelectorAll("textarea")) as HTMLTextAreaElement[];
			const t = after.find((ta) => ta.placeholder?.includes("default-summary-value"));
			expect(t?.value).toBe("");
		});
		await waitFor(() => {
			const save = getByTestId("footer").querySelector("button");
			expect(save?.textContent).toContain("save_btn");
			expect((save as HTMLButtonElement).disabled).toBe(false);
		});
	});

	test("radio click calls setActive with correct id (and null for Default)", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha" });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());

		const radios = Array.from(getByTestId("master").querySelectorAll('[role="radio"]'));
		expect(radios.length).toBe(2);
		expect(radios[0].getAttribute("aria-checked")).toBe("true");

		await act(async () => { fireEvent.click(radios[1]); });
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledWith("p2"));

		setActiveMock.mockClear();
		await act(async () => { fireEvent.click(radios[0]); });
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledWith(null));
	});

	test("duplicate calls create with (copy) suffix", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", overrides: { summary: "hi" } });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});
		createMock.mockResolvedValue({ id: "p_new", name: "Alpha (copy)", isDefault: false, overrides: { summary: "hi" }, createdAt: "", updatedAt: "" } as ServicePromptProfile);

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());

		const dupBtn = getByTestId("duplicate-p2");
		expect(dupBtn).toBeTruthy();
		await act(async () => { fireEvent.click(dupBtn); });
		await waitFor(() => expect(createMock).toHaveBeenCalled());
		expect((createMock.mock.calls[0][0] as { name: string }).name).toBe("Alpha (copy)");
	});

	test("placeholder contains resolved default preview", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", overrides: {} });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.click(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		await waitFor(() => {
			const tas = Array.from(getByTestId("detail").querySelectorAll("textarea")) as HTMLTextAreaElement[];
			const withPlaceholder = tas.filter((ta) => ta.placeholder && ta.placeholder.length > 0);
			expect(withPlaceholder.length).toBeGreaterThan(0);
			expect(withPlaceholder[0].placeholder).toContain("default-");
		});
	});

	// Pins the Rules-of-Hooks contract: every hook (incl. the ordered-profiles
	// memo) must run BEFORE the `!active` early return. Toggling the tab off
	// once the pane has loaded must not crash React with "Rendered more hooks
	// than during the previous render" — slots go null, state stays intact.
	test("toggling active off after load does not crash and nulls the slots", async () => {
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId, rerender } = render(<Harness active={true} />);
		await waitFor(() => expect(getDetailMock).toHaveBeenCalled());
		await waitFor(() => expect(getByTestId("detail").querySelectorAll("textarea").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));

		rerender(<Harness active={false} />);
		expect(getByTestId("master").textContent).toBe("");
		expect(getByTestId("detail").textContent).toBe("");
		expect(getByTestId("footer").textContent).toBe("");

		// And back on — previously loaded state is kept, no refetch needed.
		const callsBefore = getDetailMock.mock.calls.length;
		rerender(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("detail").querySelectorAll("textarea").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));
		expect(getDetailMock.mock.calls.length).toBe(callsBefore);
	});

	test("renderRowDrillDown is called per row with (id, selectRow)", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha" });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });
		const calls: Array<[string, () => void]> = [];
		const { getByTestId } = render(
			<ServicePromptsPane
				active={true}
				renderRowDrillDown={(id, selectRow) => {
					calls.push([id, selectRow]);
					return <button key={id} data-testid={"drill-" + id} onClick={selectRow}>drill-{id}</button>;
				}}
			>
				{({ master, detail, footer }) => (
					<div>
						<div data-testid="master">{master}</div>
						<div data-testid="detail">{detail}</div>
						<div data-testid="footer">{footer}</div>
					</div>
				)}
			</ServicePromptsPane>,
		);
		await waitFor(() => expect(getByTestId("master").textContent).toContain("Default"));
		expect(getByTestId("drill-default")).toBeTruthy();
		expect(getByTestId("drill-p2")).toBeTruthy();
		// Called at least once per row (React may render twice in test env).
		expect(new Set(calls.map(([id]) => id))).toEqual(new Set(["default", "p2"]));
		// The selectRow callback selects the row — clicking the drill for p2
		// should make p2 the selected detail.
		await act(async () => { fireEvent.click(getByTestId("drill-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
	});

	// Pins the detail-retry path: the retry button must actually re-run the
	// fetch effect (a same-value setSelectedId would be a silent no-op).
	test("detail error → retry refetches and recovers", async () => {
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		let failFirst = true;
		getDetailMock.mockImplementation(async () => {
			if (failFirst) {
				failFirst = false;
				return null;
			}
			return { profile: def, resolved: makeResolved() };
		});

		const { getByTestId, getByText } = render(<Harness active={true} />);
		await waitFor(() => expect(getByText("promptManager.servicePrompts.detailError")).toBeTruthy());

		fireEvent.click(getByText("retry"));
		await waitFor(() => expect(getByTestId("detail").querySelectorAll("textarea").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));
	});
});
