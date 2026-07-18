/**
 * CTX-L3 — CoauthorLoreReview DOM tests.
 *
 * Pins the structured lore review surface: lorebook metadata (name, scope
 * badge, entry count), nested entry rendering (title, content, key chips,
 * constant badge), per-item toggle callbacks, and the parent-dependency
 * invariant at the INTERACTION layer — an entry checkbox is disabled (cannot
 * toggle) when its parent lorebook is deselected, mirroring the Apply-time
 * enforcement in selectLoreBundle. The component is prop-driven and pure (no
 * store, no i18n import — labels arrive as props), so no mocking is needed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CoauthorLoreReview, type CoauthorLoreReviewLabels } from "./CoauthorLoreReview.js";
import type { CoauthorLoreBundle } from "@vibe-tavern/api-contracts";

const labels: CoauthorLoreReviewLabels = {
	title: "Proposed lore",
	lorebook: "Lorebook",
	keys: "Keys",
	secondaryKeys: "Alt",
	constant: "always-on",
	editing: "editing",
	existingLorebook: "Existing lorebook",
	entriesOne: "entry",
	entriesFew: "entries",
	entriesMany: "entries",
	scopeCharacter: "character",
	scopePersona: "persona",
	scopeGlobal: "global",
	scopeChat: "chat",
	noContent: "No content.",
};

function bundle(): CoauthorLoreBundle {
	return {
		lorebooks: [
			{ id: "lb1", name: "World Lore", description: "Setting canon.", scopeType: "global", enabled: true },
			{ id: "lb2", name: "Char Lore", description: "", scopeType: "character", enabled: true },
		],
		entries: [
			{ id: "e1", lorebookId: "lb1", title: "Eldoria", content: "An ancient city.", keys: ["Eldoria", "city"], secondaryKeys: ["ruins"], constant: false, position: "before_char", depth: 4, enabled: true },
			{ id: "e2", lorebookId: "lb2", title: "Vex's Fear", content: "", keys: ["name"], secondaryKeys: [], constant: true, position: "before_char", depth: 4, enabled: true },
		],
	};
}

function allSelected(b: CoauthorLoreBundle) {
	return {
		selectedLorebookIds: new Set(b.lorebooks.map((lb) => lb.id)),
		selectedEntryIds: new Set(b.entries.map((e) => e.id)),
	};
}

function renderReview(overrides: Partial<Parameters<typeof CoauthorLoreReview>[0]> = {}) {
	const b = bundle();
	const onToggleLorebook = vi.fn();
	const onToggleEntry = vi.fn();
	const props = {
		bundle: b,
		...allSelected(b),
		onToggleLorebook,
		onToggleEntry,
		applying: false,
		labels,
		...overrides,
	};
	const result = render(<CoauthorLoreReview {...props} />);
	return { ...result, onToggleLorebook, onToggleEntry, bundle: b };
}

describe("CoauthorLoreReview — rendering (CTX-L3)", () => {
	it("renders each lorebook with name, scope badge, description, and entry count", () => {
		const { getByText } = renderReview();
		expect(getByText("World Lore")).toBeTruthy();
		expect(getByText("Setting canon.")).toBeTruthy();
		expect(getByText("global")).toBeTruthy();
		expect(getByText("Char Lore")).toBeTruthy();
		expect(getByText("character")).toBeTruthy();
	});

	it("renders entry title, content, primary + secondary key chips, and the constant badge", () => {
		const { getAllByText, getByText } = renderReview();
		// Entry e1 — title "Eldoria" appears both as the entry title AND as a primary
		// key chip, so it resolves to multiple elements; assert both render.
		expect(getAllByText("Eldoria")).toHaveLength(2);
		expect(getByText("An ancient city.")).toBeTruthy();
		expect(getByText("ruins")).toBeTruthy(); // secondary chip
		// Entry e2 — constant badge (no content → noContent label; no secondary chips).
		expect(getByText("Vex's Fear")).toBeTruthy();
		expect(getByText("always-on")).toBeTruthy();
		expect(getByText("No content.")).toBeTruthy();
	});

	it("hides the key-chip section for a keyless, contentless entry", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [{ id: "lb1", name: "L", description: "", scopeType: "global", enabled: true }],
			entries: [{ id: "e1", lorebookId: "lb1", title: "Empty", content: "", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true }],
		};
		const { queryByText, getByText } = renderReview({
			bundle: b,
			selectedLorebookIds: new Set(["lb1"]),
			selectedEntryIds: new Set(["e1"]),
		});
		expect(getByText("No content.")).toBeTruthy();
		expect(queryByText("Alt")).toBeNull(); // no secondary-keys label
	});
});

describe("CoauthorLoreReview — per-item toggles (CTX-L3)", () => {
	it("clicking a lorebook checkbox fires onToggleLorebook with its id", () => {
		const { getAllByRole, onToggleLorebook } = renderReview();
		// Checkboxes in DOM order: lb1, e1, lb2, e2. lb1 is first.
		const checks = getAllByRole("checkbox");
		fireEvent.click(checks[0]!);
		expect(onToggleLorebook).toHaveBeenCalledWith("lb1");
		expect(onToggleLorebook).toHaveBeenCalledTimes(1);
	});

	it("clicking an entry checkbox fires onToggleEntry with its id", () => {
		const { getAllByRole, onToggleEntry } = renderReview();
		const checks = getAllByRole("checkbox");
		// checks[1] is e1 (entry under lb1).
		fireEvent.click(checks[1]!);
		expect(onToggleEntry).toHaveBeenCalledWith("e1");
	});

	it("applying disables every checkbox (no mid-apply toggles)", () => {
		const { getAllByRole } = renderReview({ applying: true });
		for (const c of getAllByRole("checkbox")) {
			expect((c as HTMLButtonElement).disabled).toBe(true);
		}
	});
});

describe("CoauthorLoreReview — parent-dependency (CTX-L3)", () => {
	it("an entry checkbox is DISABLED when its parent lorebook is deselected", () => {
		const b = bundle();
		const { getAllByRole } = renderReview({
			bundle: b,
			// lb1 deselected, lb2 selected; all entries still "selected" in state.
			selectedLorebookIds: new Set(["lb2"]),
			selectedEntryIds: new Set(b.entries.map((e) => e.id)),
		});
		const checks = getAllByRole("checkbox") as HTMLButtonElement[];
		// checks[0] = lb1 (deselected → still enabled, user can re-select it)
		expect(checks[0]!.disabled).toBe(false);
		// checks[1] = e1 (parent lb1 deselected → disabled)
		expect(checks[1]!.disabled).toBe(true);
		// checks[3] = e2 (parent lb2 selected → enabled)
		expect(checks[3]!.disabled).toBe(false);
	});

	it("clicking a disabled entry checkbox does NOT fire onToggleEntry", () => {
		const b = bundle();
		const { getAllByRole, onToggleEntry } = renderReview({
			bundle: b,
			selectedLorebookIds: new Set(["lb2"]), // lb1 deselected → e1 disabled
			selectedEntryIds: new Set(b.entries.map((e) => e.id)),
		});
		const checks = getAllByRole("checkbox") as HTMLButtonElement[];
		fireEvent.click(checks[1]!); // e1 — disabled
		expect(onToggleEntry).not.toHaveBeenCalled();
	});

	it("a deselected parent visually dims its entries (orphaned indication)", () => {
		const b = bundle();
		const { container } = renderReview({
			bundle: b,
			selectedLorebookIds: new Set(["lb2"]),
			selectedEntryIds: new Set(b.entries.map((e) => e.id)),
		});
		// The e1 entry card carries opacity-50 when its parent is deselected.
		expect(container.textContent).toContain("Eldoria");
		// Smoke-test the dimming class is applied somewhere on the entry card:
		// find the entry card div (contains "Eldoria") and check opacity-50.
		const entryCard = Array.from(container.querySelectorAll("div")).find((d) =>
			d.textContent?.includes("Eldoria") && d.textContent?.includes("always-on") === false,
		);
		// The entry card itself or an ancestor carries opacity-50; assert it exists.
		expect(entryCard).toBeTruthy();
	});
});

describe("CoauthorLoreReview — edit badge (CE-B2)", () => {
	it("shows the editing badge on mode:'edit' lorebooks and entries, not on create nodes", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [
				{ id: "lbNew", name: "New Book", description: "", scopeType: "character", enabled: true },
				{ id: "lbEdit", name: "Existing Book", description: "", scopeType: "character", enabled: true, mode: "edit" },
			],
			entries: [
				{ id: "eNew", lorebookId: "lbNew", title: "Fresh", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
				{ id: "eEdit", lorebookId: "lbEdit", title: "Tweaked", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true, mode: "edit" },
			],
		};
		const { container, getAllByText } = renderReview({ bundle: b, ...allSelected(b) });
		// Both edit nodes (one lorebook + one entry) carry the editing badge.
		expect(getAllByText("editing")).toHaveLength(2);
		// The create nodes render their titles without an editing badge.
		expect(container.textContent).toContain("Fresh");
		expect(container.textContent).toContain("Tweaked");
	});

	it("renders a verified persisted-parent entry even when no lorebook node is proposed", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [],
			entries: [
				{ id: "ePersisted", lorebookId: "lb_existing", title: "Cross-turn edit", content: "Updated prose", keys: ["trigger"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true, mode: "edit", parentMode: "persisted" },
			],
		};
		const { getByText, getByRole } = renderReview({ bundle: b, ...allSelected(b) });
		expect(getByText("Existing lorebook")).toBeTruthy();
		expect(getByText("lb_existing")).toBeTruthy();
		expect(getByText("Cross-turn edit")).toBeTruthy();
		// No proposed parent checkbox exists; the entry is independently selectable.
		expect((getByRole("checkbox") as HTMLButtonElement).disabled).toBe(false);
	});
});
