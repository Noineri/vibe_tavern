import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";
import type { ServicePromptProfile } from "@vibe-tavern/api-contracts";

const realApi = await import("../../../api/service-prompt-api.js");
const stableT = (key: string, opts?: Record<string, unknown>) => {
	if (opts && typeof opts.count === "number") return `${key} ${opts.count}`;
	// ML-13 sentinel: identity t returns the key itself, so it cannot
	// distinguish "the pane passed the RAW key" from "the pane called
	// t(key)". This one key maps to a distinct sentinel — the lock-tooltip
	// pin asserts the sentinel, proving t() was called (the sibling pane's
	// pattern), not that the key merely appears.
	if (key === "promptManager.servicePrompts.liveTooltip") return "TRANSLATED-LIVE-TOOLTIP";
	return key;
};
const stableTDynamic = (key: string, opts?: Record<string, unknown>) => {
	if (opts && typeof opts.count === "number") return `${key} ${opts.count}`;
	return key;
};
const realTooltip = await import("../../shared/Tooltip.js");

const listMock = mock(async () => ({ profiles: [] as ServicePromptProfile[], activeProfileId: null as string | null }));
// Typed to the API's own return (detail | null): the default answers the
// "not found" null member, and tests re-implement full details on it.
const getDetailMock = mock(async (_id: string): Promise<Awaited<ReturnType<typeof realApi.getServicePromptProfileDetail>>> => null);
const createMock = mock(async (body: { name: string; overrides: Record<string, string> }) => ({ id: "new_id", name: body.name, isDefault: false, sortOrder: 1, overrides: body.overrides, createdAt: "", updatedAt: "" } as ServicePromptProfile));
const updateMock = mock(async (id: string, body: { name?: string; overrides?: Record<string, string> }) => ({ id, name: body.name ?? "Renamed", isDefault: false, sortOrder: 0, overrides: body.overrides ?? {}, createdAt: "", updatedAt: "" } as ServicePromptProfile));
const deleteMock = mock(async (_id: string) => undefined);
const setActiveMock = mock(async (_id: string | null) => undefined);
const reorderMock = mock(async (updates: Array<{ id: string; sortOrder: number }>) => ({ profiles: [] as ServicePromptProfile[], activeProfileId: null as string | null }));

// Hand port onto the shared seam: the suite's named `stableT`/`stableTDynamic`
// run verbatim (the pane's callbacks depend on `t`/`tDynamic` identity — the
// spec's functions are created once, at install time, so identity holds).
installI18nContextSeam({
	custom: { t: stableT, tDynamic: stableTDynamic },
});

mock.module("../../../api/service-prompt-api.js", () => ({
	...realApi,
	listServicePromptProfiles: listMock,
	getServicePromptProfileDetail: getDetailMock,
	createServicePromptProfile: createMock,
	updateServicePromptProfile: updateMock,
	deleteServicePromptProfile: deleteMock,
	setActiveServicePromptProfile: setActiveMock,
	reorderServicePromptProfiles: reorderMock,
}));

mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	// ML-13 was: `({ children }) => children` — the passthrough dropped
	// `content`, so nothing could see what the pane passed to the tooltip.
	// Now content renders inline with a testid, mirroring the real component's
	// `if (!content) return <>{children}</>` guard; children still render —
	// the family stays shape-identical (`...realTooltip` above).
	CustomTooltip: ({ children, content }: { children: React.ReactNode; content?: React.ReactNode }) => (
		<>
			{content ? <span data-testid="svc-lock-tooltip">{content}</span> : null}
			{children}
		</>
	),
}));

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
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
	reorderMock.mockReset();
	listMock.mockResolvedValue({ profiles: [], activeProfileId: null });
	getDetailMock.mockResolvedValue(null);
	createMock.mockImplementation(async (body: { name: string; overrides: Record<string, string> }) => ({ id: "new_id", name: body.name, isDefault: false, sortOrder: 1, overrides: body.overrides, createdAt: "", updatedAt: "" } as ServicePromptProfile));
	updateMock.mockImplementation(async (id: string, body: { name?: string; overrides?: Record<string, string> }) => ({ id, name: body.name ?? "Renamed", isDefault: false, sortOrder: 0, overrides: body.overrides ?? {}, createdAt: "", updatedAt: "" } as ServicePromptProfile));
	deleteMock.mockResolvedValue(undefined);
	setActiveMock.mockResolvedValue(undefined);
	reorderMock.mockResolvedValue({ profiles: [], activeProfileId: null });
});

function makeProfile(overrides: Partial<ServicePromptProfile> = {}): ServicePromptProfile {
	return {
		id: "p1",
		name: "My Profile",
		isDefault: false,
		sortOrder: 0,
		overrides: {},
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function makeDefaultProfile(): ServicePromptProfile {
	return { id: "default", name: "Default", isDefault: true, sortOrder: 0, overrides: {}, createdAt: "", updatedAt: "" };
}

function makeResolved(overrides: Record<string, string> = {}): Record<string, { override: string | null; default: string }> {
	const map: Record<string, { override: string | null; default: string }> = {};
	for (const k of SERVICE_PROMPT_FIELD_KEYS) {
		map[k] = { override: overrides[k] ?? null, default: `default-${k}-value` };
	}
	return map;
}

function Harness({ active = true, onClose }: { active?: boolean; onClose?: () => void }) {
	return (
		<ServicePromptsPane active={active} onClose={onClose}>
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

// Row selection rides the primitive's pointer-down (a tap selects; drag starts
// from the handle only) — fireEvent.click never fires pointerdown, so every row
// tap below uses pointerDown. Clicks on buttons (edit, retry, confirm, drill)
// keep fireEvent.click: those are real click handlers.
async function openAllFamilies(detailEl: HTMLElement) {
	// Request invocation can precede the resolved detail commit. An empty
	// button snapshot silently skipped every accordion under full-suite load.
	const buttons = await waitFor(() => {
		const families = Array.from(detailEl.querySelectorAll("button")).filter((button) =>
			button.textContent?.includes("promptManager.servicePrompts.family."),
		);
		expect(families.length).toBeGreaterThan(0);
		return families;
	});
	for (const btn of buttons) {
		await act(async () => { fireEvent.click(btn); });
	}
}

describe("ServicePromptsPane", () => {
	test("active=true loads list and renders Default pinned first with lock", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		const p3 = makeProfile({ id: "p3", name: "Beta", sortOrder: 2 });
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

	test("Default row lock tooltip shows the translated text, not the i18n key (ML-13)", async () => {
		// Red-first pin (ML-13): the pane passed the RAW key
		// `content="promptManager.servicePrompts.liveTooltip"` — the tooltip
		// showed the key itself. The sibling pane (ImagePromptTemplatesPane)
		// wraps it in t(). stableT maps this one key to a sentinel (see its
		// header comment), so t() output is distinguishable from the raw key
		// even under identity i18n.
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });
		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-default")).toBeTruthy());
		expect(getByTestId("svc-lock-tooltip").textContent).toBe("TRANSLATED-LIVE-TOOLTIP");
	});

	test("detail of non-Default renders all fields grouped (accordions)", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1, overrides: { summary: "hello" } });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved({ summary: "hello" }) };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());

		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		const detail = getByTestId("detail");
		expect(detail.textContent).toContain("promptManager.servicePrompts.family.assistant");
		expect(detail.textContent).toContain("promptManager.servicePrompts.family.summary");
		await openAllFamilies(detail);
		await waitFor(() => {
			const textareas = detail.querySelectorAll("textarea");
			expect(textareas.length).toBe(SERVICE_PROMPT_FIELD_KEYS.length);
		});
	});

	test("Default detail: values shown read-only, duplicate in footer, no reset", async () => {
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId, queryByText } = render(<Harness active={true} />);
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		await waitFor(() => expect(getDetailMock).toHaveBeenCalled());
		const detail = getByTestId("detail");
		await openAllFamilies(detail);
		// FS-6: default texts render as codeQuoteCls displays — the boundary is
		// "the default profile is read-only": zero editable textareas, and every
		// field's default value is visible in the detail pane.
		const resolved = makeResolved();
		await waitFor(() => {
			expect(detail.querySelectorAll("textarea").length).toBe(0);
			for (const key of SERVICE_PROMPT_FIELD_KEYS.slice(0, 3)) {
				expect(detail.textContent).toContain(resolved[key].default.slice(0, 20));
			}
		});
		const footer = getByTestId("footer");
		expect(footer.textContent).toContain("promptManager.servicePrompts.duplicateButton");
		expect(queryByText("promptManager.servicePrompts.reset")).toBeNull();
	});

	test("Default-detail canon quotes ride the thin ScrollArea lane with the cap on the root (CNR-8i)", async () => {
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId } = render(<Harness active={true} />);
		const detail = getByTestId("detail");
		// A request being called is not its resolved detail being committed —
		// wait for the real family controls before expanding them.
		await waitFor(() => expect(detail.textContent).toContain("promptManager.servicePrompts.family.assistant"));
		await openAllFamilies(detail);
		// Every field's canon quote is a thin-lane ScrollArea; the frame +
		// max-h-40 cap sit on the ROOT (border fixed at the cap), the quote
		// body (padding + text) on the content element.
		const lanes = await waitFor(() => {
			const found = Array.from(detail.querySelectorAll("[data-scroll-area='thin']"));
			expect(found.length).toBe(SERVICE_PROMPT_FIELD_KEYS.length);
			return found as HTMLElement[];
		});
		for (const lane of lanes) {
			expect(lane.className).toContain("max-h-40");
			expect(lane.className).toContain("border");
			const content = lane.querySelector("[data-scroll-content]");
			expect(content?.className).toContain("whitespace-pre-wrap");
			expect(content?.className).toContain("p-2");
		}
		// The canon bytes ride INSIDE the lanes' viewports, not beside them.
		const viewportText = Array.from(detail.querySelectorAll("[data-scroll-area='thin'] [data-scroll-viewport]"))
			.map((node) => node.textContent ?? "")
			.join("");
		expect(viewportText).toContain("default-summary-value");
	});

	test("reset clears override and enables save (footer Save on right)", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1, overrides: { summary: "hello world" } });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved({ summary: "hello world" }) };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		const detail = getByTestId("detail");
		await openAllFamilies(detail);
		await waitFor(() => expect(detail.querySelectorAll("textarea").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));

		const resetButtons = Array.from(detail.querySelectorAll("button")).filter((b) => b.textContent?.includes("promptManager.servicePrompts.reset"));
		expect(resetButtons.length).toBeGreaterThan(0);
		await act(async () => { fireEvent.click(resetButtons[0]!); });
		await waitFor(() => {
			const after = Array.from(getByTestId("detail").querySelectorAll("textarea")) as HTMLTextAreaElement[];
			const t = after.find((ta) => ta.placeholder?.includes("default-summary-value"));
			expect(t?.value).toBe("");
		});
		await waitFor(() => {
			const footer = getByTestId("footer");
			const save = Array.from(footer.querySelectorAll("button")).find((b) => b.textContent?.includes("save_btn") || b.getAttribute("aria-label")?.includes("save_btn"));
			expect(save).toBeTruthy();
			expect((save as HTMLButtonElement).disabled).toBe(false);
		});
	});

	test("clicking row selects AND activates (and null for Default), no radio", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		expect(getByTestId("master").querySelectorAll('[role="radio"]').length).toBe(0);

		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledWith("p2"));
		setActiveMock.mockClear();
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-default")); });
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledWith(null));
	});

	test("duplicate via footer calls create with (copy) suffix and activates", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1, overrides: { summary: "hi" } });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: "p2" });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});
		const dupProfile = { id: "p_new", name: "Alpha (copy)", isDefault: false, sortOrder: 2, overrides: { summary: "hi" }, createdAt: "", updatedAt: "" } as ServicePromptProfile;
		createMock.mockResolvedValue(dupProfile);

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		const footer = getByTestId("footer");
		const dupBtn = Array.from(footer.querySelectorAll("button, span")).find((el) => el.textContent?.includes("promptManager.servicePrompts.duplicateButton"));
		expect(dupBtn).toBeTruthy();
		await act(async () => { fireEvent.click(dupBtn as HTMLElement); });
		await waitFor(() => expect(createMock).toHaveBeenCalled());
		expect((createMock.mock.calls[0][0] as { name: string }).name).toBe("Alpha (copy)");
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledWith("p_new"));
	});

	test("placeholder contains resolved default preview", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1, overrides: {} });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		const detail = getByTestId("detail");
		await openAllFamilies(detail);
		await waitFor(() => {
			const tas = Array.from(detail.querySelectorAll("textarea")) as HTMLTextAreaElement[];
			const withPlaceholder = tas.filter((ta) => ta.placeholder && ta.placeholder.length > 0);
			expect(withPlaceholder.length).toBeGreaterThan(0);
			expect(withPlaceholder[0].placeholder).toContain("default-");
		});
	});

	test("initial selection follows live activeProfileId", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		const p3 = makeProfile({ id: "p3", name: "Beta", sortOrder: 2 });
		listMock.mockResolvedValue({ profiles: [def, p2, p3], activeProfileId: "p3" });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "p3") return { profile: p3, resolved: makeResolved() };
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});
		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p3")).toBe(true));
		expect(getByTestId("service-row-p3").className).toContain("border-l-accent");
	});

	test("toggling active off after load does not crash and nulls the slots", async () => {
		const def = makeDefaultProfile();
		listMock.mockResolvedValue({ profiles: [def], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });

		const { getByTestId, rerender } = render(<Harness active={true} />);
		await waitFor(() => expect(getDetailMock).toHaveBeenCalled());
		const detail = getByTestId("detail");
		// A request being called is not its resolved detail being committed.
		// Wait for the real family controls before attempting to expand them.
		await waitFor(() => expect(detail.textContent).toContain("promptManager.servicePrompts.family.assistant"));
		await openAllFamilies(detail);
		// FS-6: default-profile fields render as codeQuote displays (max-h-40
		// is the display block's scroll cap), not editable textareas.
		await waitFor(() => expect(detail.querySelectorAll(".max-h-40").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));

		rerender(<Harness active={false} />);
		expect(getByTestId("master").textContent).toBe("");
		expect(getByTestId("detail").textContent).toBe("");
		expect(getByTestId("footer").textContent).toBe("");

		const callsBefore = getDetailMock.mock.calls.length;
		rerender(<Harness active={true} />);
		const detail2 = getByTestId("detail");
		// The loaded pane retains its family expansion across inactive slots.
		// Toggling these controls again would CLOSE them and race their exit.
		await waitFor(() => expect(detail2.querySelectorAll(".max-h-40").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));
		for (const field of SERVICE_PROMPT_FIELD_KEYS) {
			expect(detail2.textContent).toContain(makeResolved()[field].default);
		}
		expect(getDetailMock.mock.calls.length).toBe(callsBefore);
	});

	test("renderRowDrillDown is called per row with (id, selectRow)", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
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
		expect(new Set(calls.map(([id]) => id))).toEqual(new Set(["default", "p2"]));
		await act(async () => { fireEvent.click(getByTestId("drill-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
	});

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

		await act(async () => { fireEvent.click(getByText("retry")); });
		await waitFor(() => expect(getDetailMock.mock.calls.length).toBeGreaterThanOrEqual(2));
		const detail = getByTestId("detail");
		await openAllFamilies(detail);
		await waitFor(() => expect(detail.querySelectorAll(".max-h-40").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length));
	});

	test("rows have DnD grip and no hover action cluster", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });
		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		const p2Row = getByTestId("service-row-p2");
		expect(p2Row.querySelector('[aria-label="drag"]')).toBeTruthy();
		expect(p2Row.querySelector('[data-testid="duplicate-p2"]')).toBeNull();
		expect(p2Row.querySelectorAll('[role="radio"]').length).toBe(0);
	});

	test("footer Save is on the right (inside ml-auto)", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1, overrides: {} });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});
		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		const footer = getByTestId("footer");
		const mlAuto = footer.querySelector(".ml-auto");
		expect(mlAuto).toBeTruthy();
		expect(mlAuto?.textContent).toContain("save_btn");
	});

	// IPT-6 retirement boundary: the service-profile editor owns text prompts
	// only. Image templates live in ImagePromptTemplatesPane and must not remain
	// reachable through this registry-driven surface.
	test("service surface renders only the four text families and no legacy image fields", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});

		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		const detail = getByTestId("detail");
		expect(SERVICE_PROMPT_FIELD_KEYS.some((key) => key.startsWith("image_"))).toBe(false);
		expect(detail.textContent).not.toContain("promptManager.servicePrompts.family.images");
		expect(detail.textContent).not.toContain("promptManager.servicePrompts.field.image_portrait");
		await openAllFamilies(detail);
		expect(detail.querySelectorAll("textarea").length).toBe(SERVICE_PROMPT_FIELD_KEYS.length);
	});

	// Pins the dirty-guard: switching rows with unsaved edits must open the
	// discard confirm, never silently drop the draft. The TARGET row here is a
	// sortable primitive row (not the pinned Default row) — this also guards
	// against a row holding a stale onSelect closure captured before the edit
	// made the pane dirty (the pre-ML-3 memoized row broke exactly here:
	// silent switch, no confirm).
	test("switching memoized rows while dirty opens discard confirm, confirm activates target", async () => {
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1, overrides: {} });
		const p3 = makeProfile({ id: "p3", name: "Beta", sortOrder: 2, overrides: {} });
		listMock.mockResolvedValue({ profiles: [def, p2, p3], activeProfileId: null });
		getDetailMock.mockImplementation(async (id: string) => {
			if (id === "default") return { profile: def, resolved: makeResolved() };
			if (id === "p3") return { profile: p3, resolved: makeResolved() };
			return { profile: p2, resolved: makeResolved() };
		});
		const { getByTestId, getByText, queryByText } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p2")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
		setActiveMock.mockClear();
		getDetailMock.mockClear();

		const detail = getByTestId("detail");
		await openAllFamilies(detail);
		const ta = await waitFor(() => {
			const enabled = Array.from(detail.querySelectorAll("textarea")).filter((x) => !(x as HTMLTextAreaElement).disabled);
			expect(enabled.length).toBeGreaterThan(0);
			return enabled[0] as HTMLTextAreaElement;
		});
		await act(async () => { fireEvent.change(ta, { target: { value: "edited draft" } }); });

		// Row switch with a dirty draft → confirm modal, no select yet.
		await act(async () => { fireEvent.pointerDown(getByTestId("service-row-p3")); });
		expect(getByText("promptManager.servicePrompts.discardTitle")).toBeTruthy();
		expect(getDetailMock.mock.calls.every((c) => c[0] !== "p3")).toBe(true);

		await act(async () => { fireEvent.click(getByText("confirm")); });
		await waitFor(() => expect(getDetailMock.mock.calls.some((c) => c[0] === "p3")).toBe(true));
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledWith("p3"));
		await waitFor(() => expect(queryByText("promptManager.servicePrompts.discardTitle")).toBeNull());
	});

	test("live profile is marked with the status-slot dot (never a whole-row color)", async () => {
		// Behavior change (was: an active-only 6px dot, then: ★ in the
		// primitive's status slot; now: the unified green dot — owner
		// follow-up 2026-10-24, ★ retired. Selection stays the primitive's
		// accent look).
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: "p2" });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });
		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		expect(getByTestId("service-row-p2").querySelector(".bg-success")).toBeTruthy();
	});

	test("row titles wrap instead of truncating", async () => {
		// Behavior change (was: `truncate` title in a tooltip; now: `break-words`
		// wrap per MASTER_LIST_PRIMITIVE_PLAN row rules — authored names are UI
		// copy, and UI copy is never truncated).
		const def = makeDefaultProfile();
		const p2 = makeProfile({ id: "p2", name: "Alpha", sortOrder: 1 });
		listMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
		getDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });
		const { getByTestId } = render(<Harness active={true} />);
		await waitFor(() => expect(getByTestId("service-row-p2")).toBeTruthy());
		const row = getByTestId("service-row-p2");
		expect(row.querySelector(".truncate")).toBeNull();
		expect(row.querySelector(".break-words")).toBeTruthy();
	});
});
