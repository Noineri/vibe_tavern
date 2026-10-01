/**
 * CharacterFilterPicker tests (LB-3B).
 *
 * Layer 1 — CHARACTERIZATION (written BEFORE the search/order/mobile change
 * and required to stay green WITHOUT edits after it): pins today's picker
 * contract — "+ Add" excludes already-added characters and appends on pick,
 * the ghost chip binds ITS index, the chip ✕ removes an entry, the all-added
 * empty message, and the exclude checkbox wiring.
 *
 * Layer 2 — NEW behavior: search row above MAX_VISIBLE_ITEMS candidates,
 * case-insensitive + Cyrillic matching, no-results line, query reset on
 * reopen, updatedAt-desc candidate order, lazy avatar imgs, and the mobile
 * BottomSheet shell (flippable useIsMobile mock, message-ai-editor-controls
 * pattern).
 *
 * Test-infra contract (found in LB-3A, see BuildCharacterSwitcher.test.tsx):
 * @testing-library/react is imported DYNAMICALLY after useDomEnv() — a static
 * import binds react-dom's environment before the DOM registers and silently
 * breaks input/change delegation into portals.
 *
 * Cyrillic names are written via \u escapes — the code repo is Cyrillic-free
 * and the commit guard blocks literal Cyrillic in staged lines.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

// --- House mocks ---------------------------------------------------------
const realI18nContext = await import("../../../i18n/context.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");

let __isMobile = false;
mock.module("../../../hooks/use-mobile.js", () => ({
	...realMobileHook,
	useIsMobile: () => __isMobile,
}));

// RTL loads AFTER the DOM registration (see header).
const { render, fireEvent, act, waitFor, within } = await import("@testing-library/react");
const { useForm, FormProvider } = await import("react-hook-form");
const { useSnapshotStore } = await import("../../../stores/snapshot-store.js");
const { wireLoreEntry } = await import("../../../../test/wire-fixtures.js");
const { CharacterFilterPicker } = await import("./character-filter-picker.js");

import type { UseFormReturn } from "react-hook-form";
import type { LoreEntryDraft } from "./use-lorebook-editor-state.js";
import type { AppCharacterEntry } from "../../../api/types.js";

// --- Fixtures ------------------------------------------------------------

function makeEntry(id: string, name: string, updatedAt: string): AppCharacterEntry {
	return {
		id,
		name,
		subtitle: "",
		tags: [],
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		updatedAt,
	};
}

const CHARS = [
	makeEntry("c1", "Alpha", "2026-10-01T10:00:00.000Z"),
	makeEntry("c2", "Bree", "2026-10-01T09:00:00.000Z"),
	makeEntry("c3", "Cory", "2026-10-01T08:00:00.000Z"),
];

function seedCharacters(chars: AppCharacterEntry[]): void {
	useSnapshotStore.setState({ allCharacters: chars });
}

/** Render the picker inside a real RHF form; returns the live form handle. */
function renderPicker(filter: Array<{ id: string | null; name: string }>, exclude = false) {
	const handle: { form: UseFormReturn<LoreEntryDraft> | null } = { form: null };
	function Harness() {
		const form = useForm<LoreEntryDraft>({
			defaultValues: {
				...wireLoreEntry(),
				characterFilter: filter,
				characterFilterExclude: exclude,
			},
		});
		handle.form = form;
		return (
			<FormProvider {...form}>
				<CharacterFilterPicker t={(key) => key} />
			</FormProvider>
		);
	}
	const view = render(<Harness />);
	return { view, handle };
}

function openAdd(): void {
	const add = within(document.body).getByText("+ lore_char_filter_placeholder");
	act(() => {
		fireEvent.pointerDown(add);
		fireEvent.click(add);
	});
}

/** The Radix popover list container in document.body — scopes queries to the
 *  LIST (the bound chips in the anchor row live outside it and would
 *  otherwise shadow the same names). */
function listRoot(): HTMLElement {
	const el = document.body.querySelector("[data-radix-popper-content-wrapper]");
	if (!(el instanceof HTMLElement)) throw new Error("popover list not open");
	return el;
}

const list = () => within(listRoot());

const filterValue = (handle: { form: UseFormReturn<LoreEntryDraft> | null }) =>
	handle.form?.getValues("characterFilter") ?? [];

// ── Characterization ─────────────────────────────────────────────────────

describe("CharacterFilterPicker — characterization (LB-3B)", () => {
	beforeEach(() => {
		__isMobile = false;
		seedCharacters(CHARS);
	});

	it("+ Add opens the list; already-added characters are excluded; pick appends and closes", async () => {
		const { handle } = renderPicker([{ id: "c1", name: "Alpha" }]);
		openAdd();
		// c1 is already bound → absent from the list; the others present.
		expect(list().queryByText("Alpha")).toBeNull();
		expect(list().getByText("Bree")).toBeTruthy();
		expect(list().getByText("Cory")).toBeTruthy();
		await act(async () => {
			fireEvent.click(list().getByText("Bree"));
		});
		expect(filterValue(handle)).toEqual([
			{ id: "c1", name: "Alpha" },
			{ id: "c2", name: "Bree" },
		]);
		await waitFor(() =>
			expect(document.body.querySelector("[data-radix-popper-content-wrapper]")).toBeNull(),
		);
	});

	it("ghost chip click opens the list; picking binds THAT index only", async () => {
		const { handle } = renderPicker([
			{ id: "c1", name: "Alpha" },
			{ id: null, name: "?" },
			{ id: "c3", name: "Cory" },
		]);
		// The ghost chip is the dashed pill (title = lore_char_filter_bind).
		const ghost = within(document.body).getByTitle("lore_char_filter_bind");
		act(() => {
			fireEvent.pointerDown(ghost);
			fireEvent.click(ghost);
		});
		await waitFor(() => expect(list().getByText("Bree")).toBeTruthy());
		await act(async () => {
			fireEvent.click(list().getByText("Bree"));
		});
		expect(filterValue(handle)).toEqual([
			{ id: "c1", name: "Alpha" },
			{ id: "c2", name: "Bree" },
			{ id: "c3", name: "Cory" },
		]);
	});

	it("the ✕ on a bound chip removes that entry", async () => {
		const { handle } = renderPicker([{ id: "c1", name: "Alpha" }, { id: "c3", name: "Cory" }]);
		const removeCory = within(document.body)
			.getAllByText("Cory")
			.map((el) => el.parentElement?.querySelector("button"))
			.find((b): b is HTMLButtonElement => b instanceof HTMLButtonElement);
		expect(removeCory).toBeTruthy();
		await act(async () => {
			fireEvent.click(removeCory as HTMLButtonElement);
		});
		expect(filterValue(handle)).toEqual([{ id: "c1", name: "Alpha" }]);
	});

	it("every character already added → the empty message, no rows", () => {
		renderPicker(CHARS.map((c) => ({ id: c.id, name: c.name })));
		openAdd();
		expect(list().getByText("lore_char_filter_empty")).toBeTruthy();
		expect(list().queryByText("Bree")).toBeNull();
	});

	it("the exclude checkbox toggles characterFilterExclude", async () => {
		const { handle } = renderPicker([]);
		const checkbox = within(document.body).getByText("lore_char_filter_exclude");
		await act(async () => {
			fireEvent.click(checkbox);
		});
		expect(handle.form?.getValues("characterFilterExclude")).toBe(true);
		await act(async () => {
			fireEvent.click(checkbox);
		});
		expect(handle.form?.getValues("characterFilterExclude")).toBe(false);
	});
});

// ── New behavior: search, order, lazy imgs, mobile sheet ───────────────

/** 8 characters with descending updatedAt: newer-first order must hold. */
function makeEight(): AppCharacterEntry[] {
	return [
		makeEntry("c1", "Alpha", "2026-10-01T01:00:00.000Z"),
		makeEntry("c2", "bree", "2026-10-01T08:00:00.000Z"),
		makeEntry("c3", "Cory", "2026-10-01T07:00:00.000Z"),
		makeEntry("c4", "\u0410\u043d\u043d\u0430", "2026-10-01T06:00:00.000Z"),
		makeEntry("c5", "Dana", "2026-10-01T05:00:00.000Z"),
		makeEntry("c6", "Eli", "2026-10-01T04:00:00.000Z"),
		makeEntry("c7", "Finn", "2026-10-01T03:00:00.000Z"),
		makeEntry("c8", "Gale", "2026-10-01T02:00:00.000Z"),
	];
}

const searchInput = (): HTMLInputElement | null =>
	document.body.querySelector('input[aria-label="link_binding_search_placeholder"]');

function typeQuery(value: string): void {
	const input = searchInput();
	if (!(input instanceof HTMLInputElement)) throw new Error("search input not found");
	act(() => {
		fireEvent.change(input, { target: { value } });
	});
}

function rowNames(): string[] {
	return Array.from(listRoot().querySelectorAll("button[type=\"button\"] > span.truncate"))
		.map((el) => el.textContent ?? "");
}

describe("CharacterFilterPicker — search / order / mobile (LB-3B)", () => {
	beforeEach(() => {
		__isMobile = false;
		seedCharacters(makeEight());
	});

	it("no search row with ≤ 6 candidates, present with 7", () => {
		// 8 characters, 2 already bound → 6 candidates, no search.
		const first = renderPicker([{ id: "c1", name: "Alpha" }, { id: "c8", name: "Gale" }]);
		openAdd();
		expect(searchInput()).toBeNull();
		first.view.unmount();
		// 1 bound → 7 candidates → search row.
		renderPicker([]);
		openAdd();
		expect(searchInput() instanceof HTMLInputElement).toBe(true);
	});

	it("candidates are ordered by updatedAt desc", () => {
		renderPicker([]);
		openAdd();
		expect(rowNames()).toEqual(["bree", "Cory", "\u0410\u043d\u043d\u0430", "Dana", "Eli", "Finn", "Gale", "Alpha"]);
	});

	it("typing filters case-insensitively (incl. Cyrillic), order preserved", () => {
		renderPicker([]);
		openAdd();
		typeQuery("BREE");
		expect(rowNames()).toEqual(["bree"]);
		typeQuery("\u0410\u041d"); // upper-case Cyrillic query matches the mixed-case name
		expect(rowNames()).toEqual(["\u0410\u043d\u043d\u0430"]);
		typeQuery("zzz");
		expect(rowNames()).toEqual([]);
		expect(list().getByText("link_binding_no_results")).toBeTruthy();
	});

	it("query resets after close and reopen", () => {
		const { view } = renderPicker([]);
		openAdd();
		typeQuery("BREE");
		expect(rowNames()).toEqual(["bree"]);
		// Close via Escape on the content, then reopen.
		act(() => {
			fireEvent.keyDown(listRoot(), { key: "Escape" });
		});
		openAdd();
		const input = searchInput();
		expect(input instanceof HTMLInputElement).toBe(true);
		expect((input as HTMLInputElement).value).toBe("");
		expect(rowNames().length).toBe(8);
		void view;
	});

	it("ghost-bind works through a filtered list", async () => {
		const { handle } = renderPicker([
			{ id: "c1", name: "Alpha" },
			{ id: null, name: "?" },
		]);
		const ghost = within(document.body).getByTitle("lore_char_filter_bind");
		act(() => {
			fireEvent.pointerDown(ghost);
			fireEvent.click(ghost);
		});
		await waitFor(() => expect(searchInput() instanceof HTMLInputElement).toBe(true));
		typeQuery("FIN");
		expect(rowNames()).toEqual(["Finn"]);
		await act(async () => {
			fireEvent.click(list().getByText("Finn"));
		});
		expect(filterValue(handle)).toEqual([
			{ id: "c1", name: "Alpha" },
			{ id: "c7", name: "Finn" },
		]);
	});

	it("list imgs and chip imgs are lazy-decoded", () => {
		seedCharacters([
			{ ...makeEntry("c1", "Alpha", "2026-10-01T10:00:00.000Z"), avatarExt: "png", avatarAssetId: "a1" },
		]);
		// Chip img (bound entry with avatar).
		const first = renderPicker([{ id: "c1", name: "Alpha" }]);
		const chipImg = document.body.querySelector("span.rounded-full img");
		expect(chipImg?.getAttribute("loading")).toBe("lazy");
		expect(chipImg?.getAttribute("decoding")).toBe("async");
		first.view.unmount();
		// List row img.
		renderPicker([]);
		openAdd();
		const rowImg = listRoot().querySelector("button img");
		expect(rowImg?.getAttribute("loading")).toBe("lazy");
		expect(rowImg?.getAttribute("decoding")).toBe("async");
	});

	it("mobile: the picker opens as a BottomSheet (no desktop popper) and add works", async () => {
		__isMobile = true;
		const { handle } = renderPicker([]);
		openAdd();
		expect(document.body.querySelector("[data-radix-popper-content-wrapper]")).toBeNull();
		// BottomSheet renders the same body under the sheet title: the label
		// above the picker + the sheet's Drawer.Title both carry the section
		// name — two occurrences pin that the SHEET (not just the field) mounted.
		expect(within(document.body).getAllByText("lore_charfilter_section").length).toBe(2);
		await waitFor(() => expect(searchInput() instanceof HTMLInputElement).toBe(true));
		await act(async () => {
			fireEvent.click(within(document.body).getByText("Cory"));
		});
		expect(filterValue(handle)).toEqual([{ id: "c3", name: "Cory" }]);
		// Selection closes the sheet.
		await waitFor(() => expect(within(document.body).queryByText("bree")).toBeNull());
	});
});
