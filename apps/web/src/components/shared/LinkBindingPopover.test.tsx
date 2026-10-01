/**
 * LinkBindingPopover — responsive resource-row coverage.
 *
 * Pins the single-row contract fixed in BOUND_RESOURCES_FIELD_RESPONSIVE_LAYOUT:
 * bound pills and the add-trigger are peers inside ONE flex-wrap resource row
 * (no separate add-row), the pill name is never hard-capped to 80px (ellipsis
 * only when the row is actually tight), and the mobile trigger keeps a 44px hit
 * target. The toggle semantics (click pill → unlink; popover chip → link) and
 * the empty state (trigger stays an obvious bind action) are also pinned.
 *
 * Consumer-level coverage lives in CoauthorCharacterForm.test.tsx.
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ComponentProps, ReactNode } from "react";
import type { LinkTarget } from "./LinkBindingPopover.js";

useDomEnv();
const { render, fireEvent, within, act, waitFor } = await import("@testing-library/react");

let LinkBindingPopover: typeof import("./LinkBindingPopover.js").LinkBindingPopover;
let TooltipProvider: typeof import("./Tooltip.js").TooltipProvider;

beforeAll(async () => {
	({ LinkBindingPopover } = await import("./LinkBindingPopover.js"));
	({ TooltipProvider } = await import("./Tooltip.js"));
});

const t = (k: string) => k;

function makeTarget(id: string, name: string): LinkTarget {
	return { id, name, avatarAssetId: null };
}

// CustomTooltip (Radix Tooltip) needs a TooltipProvider ancestor; in the app it
// lives in AppShell, here we provide it per render via the RTL wrapper option.
const withTooltip = ({ children }: { children: ReactNode }) => (
	<TooltipProvider>{children}</TooltipProvider>
);
type RenderReturn = ReturnType<typeof render>;
function renderRow(props: ComponentProps<typeof LinkBindingPopover>): RenderReturn {
	return render(<LinkBindingPopover {...props} />, { wrapper: withTooltip });
}

const baseProps = {
	characters: [] as LinkTarget[],
	personas: [] as LinkTarget[],
	scripts: [] as LinkTarget[],
	onSetLinks: () => {},
	t,
} satisfies Partial<ComponentProps<typeof LinkBindingPopover>>;

describe("LinkBindingPopover — responsive resource row", () => {
	it("renders bound pills and the add-trigger as peers inside ONE resource row (desktop)", () => {
		const { getByTestId, getByRole, getByText } = renderRow({
			...baseProps,
			links: [{ targetType: "lorebook", targetId: "lb1" }],
			lorebooks: [makeTarget("lb1", "Silk Kingdom")],
			isMobile: false,
		});
		const row = getByTestId("resource-row");
		expect(row).toBeTruthy();
		// The bound pill text lives inside the row.
		expect(row.contains(getByText("Silk Kingdom"))).toBe(true);
		// The add-trigger is a peer inside the SAME row (not a separate add-row).
		const trigger = getByRole("button", { name: "lore_link_targets" });
		expect(trigger.closest('[data-testid="resource-row"]')).toBe(row);
	});

	it("renders exactly one resource row (no separate add-row) on mobile too", () => {
		const { getAllByTestId, getByRole } = renderRow({
			...baseProps,
			links: [{ targetType: "script", targetId: "sc1" }],
			scripts: [makeTarget("sc1", "Dice Roller")],
			isMobile: true,
		});
		expect(getAllByTestId("resource-row")).toHaveLength(1);
		const trigger = getByRole("button", { name: "lore_link_targets" });
		expect(trigger.closest('[data-testid="resource-row"]')).toBeTruthy();
	});

	it("multiple pills and the trigger share one flex-wrap row", () => {
		const { getByTestId, getByRole } = renderRow({
			...baseProps,
			links: [
				{ targetType: "lorebook", targetId: "lb1" },
				{ targetType: "lorebook", targetId: "lb2" },
				{ targetType: "lorebook", targetId: "lb3" },
			],
			lorebooks: [
				makeTarget("lb1", "Alpha"),
				makeTarget("lb2", "Beta"),
				makeTarget("lb3", "Gamma"),
			],
			isMobile: false,
		});
		const row = getByTestId("resource-row");
		expect(row.className).toContain("flex-wrap");
		expect(row.textContent).toContain("Alpha");
		expect(row.textContent).toContain("Beta");
		expect(row.textContent).toContain("Gamma");
		// The trigger is inside the same flex-wrap row, so wrapping carries it
		// together with the pills instead of stranding it on its own block line.
		expect(row.contains(getByRole("button", { name: "lore_link_targets" }))).toBe(true);
	});

	it("clicking a bound pill unlinks it (toggle-off)", () => {
		const onSetLinks = mock();
		const { getByText } = renderRow({
			...baseProps,
			links: [{ targetType: "lorebook", targetId: "lb1" }],
			lorebooks: [makeTarget("lb1", "Silk Kingdom")],
			onSetLinks,
			isMobile: false,
		});
		fireEvent.click(getByText("Silk Kingdom"));
		expect(onSetLinks).toHaveBeenCalledTimes(1);
		expect(onSetLinks).toHaveBeenLastCalledWith([]);
	});

	// RX-12: preset/regex target types render bound pills and unlink exactly
	// like the pre-existing kinds — the union extension must not fork pill
	// behavior. (Popover chip sections can't mount in happy-dom — see the
	// skipped toggle-on test below — so coverage here is the pill row.)
	it("renders a bound preset pill and unlinks it on click", () => {
		const onSetLinks = mock();
		const { getByText } = renderRow({
			...baseProps,
			links: [
				{ targetType: "preset", targetId: "pp1" },
				{ targetType: "character", targetId: "c1" },
			],
			characters: [makeTarget("c1", "Seraphina")],
			presets: [makeTarget("pp1", "Deep RP")],
			onSetLinks,
			isMobile: false,
		});
		fireEvent.click(getByText("Deep RP"));
		expect(onSetLinks).toHaveBeenCalledTimes(1);
		// Only the preset link is removed; the character link survives.
		expect(onSetLinks).toHaveBeenLastCalledWith([{ targetType: "character", targetId: "c1" }]);
	});

	it("renders a bound regex pill and unlinks it on click", () => {
		const onSetLinks = mock();
		const { getByText } = renderRow({
			...baseProps,
			links: [{ targetType: "regex", targetId: "rx1" }],
			regexes: [makeTarget("rx1", "No Italics")],
			onSetLinks,
			isMobile: false,
		});
		fireEvent.click(getByText("No Italics"));
		expect(onSetLinks).toHaveBeenCalledTimes(1);
		expect(onSetLinks).toHaveBeenLastCalledWith([]);
	});

	it("empty state: no pills but the add-trigger stays visible in the row", () => {
		const { getByTestId, getByRole } = renderRow({
			...baseProps,
			links: [],
			lorebooks: [],
			isMobile: false,
		});
		const row = getByTestId("resource-row");
		expect(row.contains(getByRole("button", { name: "lore_link_targets" }))).toBe(true);
	});

	it("does not hard-cap the pill name width; a long name renders in full when there is room", () => {
		const longName = "Шёлковое королевство Abendstern";
		const { getByText } = renderRow({
			...baseProps,
			links: [{ targetType: "lorebook", targetId: "lb1" }],
			lorebooks: [makeTarget("lb1", longName)],
			isMobile: false,
		});
		const span = getByText(longName);
		// The unconditional 80px cap is gone — neither the name span nor its pill
		// carries max-w-[80px]. The name spans its natural width and ellipses
		// only when the row is actually tight (via min-w-0 + truncate).
		expect(span.className).not.toContain("max-w-[80px]");
		const pill = span.parentElement;
		expect(pill?.className).not.toContain("max-w-[80px]");
		expect(pill?.className).toContain("min-w-0");
	});

	it("desktop trigger is a compact 22px circle", () => {
		const { getByRole } = renderRow({
			...baseProps,
			links: [],
			lorebooks: [],
			isMobile: false,
		});
		const trigger = getByRole("button", { name: "lore_link_targets" });
		expect(trigger.className).toContain("h-[22px]");
		expect(trigger.className).toContain("w-[22px]");
	});

	it("mobile trigger keeps a 44px hit target", () => {
		const { getByRole } = renderRow({
			...baseProps,
			links: [],
			lorebooks: [],
			isMobile: true,
		});
		const trigger = getByRole("button", { name: "lore_link_targets" });
		expect(trigger.className).toContain("h-11");
		expect(trigger.className).toContain("w-11");
	});

		// NOTE: skipped under bun:test + happy-dom. Radix Popover.Content is mounted
	// via a Popper that anchors through getBoundingClientRect; in happy-dom every
	// element reports a 0x0 box, so the content never anchors and never mounts, so
	// the chip never renders and the toggle-on (add) path cannot be asserted
	// here. This is the SAME limitation already accepted for DropdownSelect's
	// keyboard-nav test (see its header). The toggle-OFF (unlink) path IS covered
	// by the passing "clicking a bound pill unlinks it" test above; the toggle-ON
	// path is covered by manual browser verification (open the popover, click a
	// chip, the binding is added). Kept as living documentation of the contract.
	it.skip("opening the popover and clicking a chip toggles it on (add)", async () => {
		const onSetLinks = mock();
		const { getByRole } = renderRow({
			...baseProps,
			links: [],
			lorebooks: [makeTarget("lb1", "Silk Kingdom")],
			onSetLinks,
			isMobile: false,
		});
		const trigger = getByRole("button", { name: "lore_link_targets" });
		// Radix Popover opens on a pointer interaction.
		fireEvent.pointerDown(trigger);
		// The chip appears in the portal (document.body); clicking it toggles on.
		const chip = await within(document.body).findByText("Silk Kingdom");
		fireEvent.click(chip);
		expect(onSetLinks).toHaveBeenCalled();
		expect(onSetLinks).toHaveBeenLastCalledWith([{ targetType: "lorebook", targetId: "lb1" }]);
	});
});

// ── Variant-A picker (LB-2C) ────────────────────────────────────────────────
// The picker body (search + collapsed sections + «show N more») renders from
// deriveLinkSections; these tests open the popover the way the ImageGen
// FineTuning chip harness does (pointerDown + click — Radix mounts the
// portal content in happy-dom, contrary to the old skip note above) and
// assert behavior on the desktop shell plus the mobile BottomSheet fork.
// `t` here interpolates {count} so the «show N more» chip is addressable.
const tNum = (k: string, opts?: Record<string, unknown>) =>
	opts && typeof opts.n === "number" ? `${k}:${opts.n}` : k;

function makeTargetAt(id: string, name: string, updatedAt: string): LinkTarget {
	return { id, name, avatarAssetId: null, updatedAt };
}

/** 11 characters: `bound` (newest, pre-linked) + u10..u1 by recency desc. */
function elevenCharacters(): LinkTarget[] {
	const targets = [
		makeTargetAt("bound", "Bound One", "2026-10-11T00:00:00.000Z"),
	];
	for (let i = 10; i >= 1; i--) {
		targets.push(makeTargetAt(`u${i}`, `Char ${String(i).padStart(2, "0")}`, `2026-10-${String(i).padStart(2, "0")}T00:00:00.000Z`));
	}
	return targets;
}

function openDesktopPicker(): void {
	const trigger = document.body.querySelector('button[aria-label="lore_link_targets"]');
	if (!(trigger instanceof HTMLElement)) throw new Error("no add trigger");
	act(() => {
		fireEvent.pointerDown(trigger);
		fireEvent.click(trigger);
	});
}

/** Chip-cloud children of the section whose header text is exactly `header`. */
function sectionChildren(header: string): HTMLElement[] {
	const el = Array.from(document.body.querySelectorAll("div")).find(
		(d) => d.childElementCount === 0 && d.textContent === header,
	);
	if (!el) throw new Error(`no section header ${header}`);
	const cloud = el.parentElement?.children[1];
	if (!cloud) throw new Error(`no chip cloud under ${header}`);
	return Array.from(cloud.children) as HTMLElement[];
}

function chipNames(header: string): string[] {
	// Chips carry the avatar initial (leaf div) + a name span; the more/less
	// buttons hold plain text — read the span when present.
	return sectionChildren(header).map(
		(c) => c.querySelector("span")?.textContent ?? c.textContent ?? "",
	);
}

describe("LinkBindingPopover — variant-A picker (LB-2C)", () => {
	const pickerBase = {
		onSetLinks: () => {},
		t: tNum,
		isMobile: false,
		showPills: false,
		links: [{ targetType: "character" as const, targetId: "bound" }],
		characters: elevenCharacters(),
		personas: [] as LinkTarget[],
	};

	it("collapsed: bound chip first, then 6 unbound by recency, then «4 more»", async () => {
		renderRow({ ...pickerBase });
		openDesktopPicker();
		await waitFor(() => expect(chipNames("scope_char · 11")).toBeTruthy());
		expect(chipNames("scope_char · 11")).toEqual([
			"Bound One", // bound first
			"Char 10", "Char 09", "Char 08", "Char 07", "Char 06", "Char 05", // 6 newest unbound
			"link_binding_show_more:4", // u4..u1 hidden
		]);
	});

	it("«show more» expands to everything + «show less»; «show less» collapses again", async () => {
		renderRow({ ...pickerBase });
		openDesktopPicker();
		await waitFor(() => expect(chipNames("scope_char · 11")).toContain("link_binding_show_more:4"));
		await act(async () => {
			fireEvent.click(within(document.body).getByText("link_binding_show_more:4"));
		});
		await waitFor(() =>
			expect(chipNames("scope_char · 11")).toEqual([
				"Bound One",
				"Char 10", "Char 09", "Char 08", "Char 07", "Char 06", "Char 05",
				"Char 04", "Char 03", "Char 02", "Char 01",
				"link_binding_show_less",
			]),
		);
		await act(async () => {
			fireEvent.click(within(document.body).getByText("link_binding_show_less"));
		});
		await waitFor(() =>
			expect(chipNames("scope_char · 11")).toEqual([
				"Bound One",
				"Char 10", "Char 09", "Char 08", "Char 07", "Char 06", "Char 05",
				"link_binding_show_more:4",
			]),
		);
	});

	it("search row appears only above the MAX_VISIBLE_ITEMS threshold", async () => {
		const six = {
			...pickerBase,
			links: [],
			characters: [1, 2, 3, 4, 5, 6].map((i) => makeTargetAt(`c${i}`, `C${i}`, `2026-10-0${i}T00:00:00.000Z`)),
		};
		renderRow(six);
		openDesktopPicker();
		await waitFor(() => expect(chipNames("scope_char · 6")).toHaveLength(6));
		expect(document.body.querySelector('input[aria-label="link_binding_search_placeholder"]')).toBeNull();
	});

	it("typing filters across sections, hides empty ones, «Nothing found» on no match", async () => {
		renderRow({
			...pickerBase,
			links: [],
			characters: [
				makeTargetAt("a1", "Anna", "2026-10-07T00:00:00.000Z"),
				makeTargetAt("b1", "Boris", "2026-10-06T00:00:00.000Z"),
				makeTargetAt("c1", "Clara", "2026-10-05T00:00:00.000Z"),
				makeTargetAt("d1", "Dmitri", "2026-10-04T00:00:00.000Z"),
				makeTargetAt("e1", "Elena", "2026-10-03T00:00:00.000Z"),
				makeTargetAt("f1", "Fedor", "2026-10-02T00:00:00.000Z"),
			],
			lorebooks: [makeTargetAt("lb1", "Anna's lore", "2026-10-01T00:00:00.000Z")],
			scripts: [makeTargetAt("sc1", "Dice Roller", "2026-10-01T00:00:00.000Z")],
		});
		openDesktopPicker();
		const input = await waitFor(() =>
			document.body.querySelector('input[aria-label="link_binding_search_placeholder"]'),
		);
		expect(input).toBeTruthy();
		await act(async () => {
			fireEvent.change(input as HTMLElement, { target: { value: "an" } });
		});
		// Characters section keeps only Anna (header still counts ALL targets);
		// the lorebook match shows; the script section (no match) is omitted.
		expect(chipNames("scope_char · 6")).toEqual(["Anna"]);
		expect(chipNames("scope_lorebook · 1")).toEqual(["Anna's lore"]);
		const headers = Array.from(document.body.querySelectorAll("div"))
			.filter((d) => d.childElementCount === 0 && d.textContent?.startsWith("scope_script"));
		expect(headers).toHaveLength(0);
		// No match anywhere → the no-results line, every section omitted.
		await act(async () => {
			fireEvent.change(input as HTMLElement, { target: { value: "zzz" } });
		});
		await waitFor(() =>
			expect(within(document.body).getByText("link_binding_no_results")).toBeTruthy(),
		);
		expect(() => chipNames("scope_char · 6")).toThrow("no section header");
	});

	it("clicking an unbound chip links it; the visible order stays frozen while open", async () => {
		const onSetLinks = mock();
		const view = renderRow({ ...pickerBase, onSetLinks });
		openDesktopPicker();
		await waitFor(() => expect(chipNames("scope_char · 11")).toContain("Char 07"));
		const before = chipNames("scope_char · 11");
		await act(async () => {
			fireEvent.click(within(document.body).getByText("Char 07"));
		});
		expect(onSetLinks).toHaveBeenCalledTimes(1);
		expect(onSetLinks).toHaveBeenLastCalledWith([
			{ targetType: "character", targetId: "bound" },
			{ targetType: "character", targetId: "u7" },
		]);
		// The parent applies the new links → live active marks, SAME order
		// (openLinks snapshot still drives the derivation until close). The
		// bare element keeps RTL's auto-applied wrapper — a hand-wrapped
		// TooltipProvider would nest inside it and REMOUNT the component
		// (state reset, popover closes).
		view.rerender(
			<LinkBindingPopover
				{...pickerBase}
				onSetLinks={onSetLinks}
				links={[
					{ targetType: "character", targetId: "bound" },
					{ targetType: "character", targetId: "u7" },
				]}
			/>,
		);
		expect(chipNames("scope_char · 11")).toEqual(before);
		// The newly bound chip got its LIVE active look (accent border).
		const active = sectionChildren("scope_char · 11").find(
			(c) => c.querySelector("span")?.textContent === "Char 07",
		);
		expect(active?.className).toContain("border-accent");
	});

	it("close + reopen resets query and expansion", async () => {
		renderRow({ ...pickerBase });
		openDesktopPicker();
		// Expand first (empty query)…
		await act(async () => {
			fireEvent.click(within(document.body).getByText("link_binding_show_more:4"));
		});
		await waitFor(() => expect(within(document.body).getByText("link_binding_show_less")).toBeTruthy());
		// …then dirty the query (it hides every section — irrelevant here, the
		// point is only that reopen starts clean).
		const input = await waitFor(() =>
			document.body.querySelector('input[aria-label="link_binding_search_placeholder"]'),
		);
		await act(async () => {
			fireEvent.change(input as HTMLElement, { target: { value: "an" } });
		});
		// Close via Escape (Radix outside/escape handling).
		await act(async () => {
			fireEvent.keyDown(document.body, { key: "Escape" });
		});
		await waitFor(() =>
			expect(within(document.body).queryByText("link_binding_show_less")).toBeNull(),
		);
		// Reopen: query empty, section collapsed again.
		openDesktopPicker();
		const input2 = await waitFor(() =>
			document.body.querySelector('input[aria-label="link_binding_search_placeholder"]'),
		);
		expect((input2 as HTMLInputElement).value).toBe("");
		await waitFor(() =>
			expect(chipNames("scope_char · 11")).toEqual([
				"Bound One",
				"Char 10", "Char 09", "Char 08", "Char 07", "Char 06", "Char 05",
				"link_binding_show_more:4",
			]),
		);
	});

	it("mobile: the same body renders in a BottomSheet, not the desktop popover", async () => {
		renderRow({ ...pickerBase, isMobile: true });
		const trigger = document.body.querySelector('button[aria-label="lore_link_targets"]');
		if (!(trigger instanceof HTMLElement)) throw new Error("no trigger");
		await act(async () => {
			fireEvent.pointerDown(trigger);
			fireEvent.click(trigger);
		});
		// Sheet title + the shared body: search row and the chip cloud.
		await waitFor(() => expect(within(document.body).getByText("lore_link_targets")).toBeTruthy());
		await waitFor(() =>
			expect(
				document.body.querySelector('input[aria-label="link_binding_search_placeholder"]'),
			).toBeTruthy(),
		);
		await waitFor(() => expect(chipNames("scope_char · 11")).toContain("link_binding_show_more:4"));
		// The desktop Radix content is NOT rendered on mobile.
		expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
		// The 80dvh sheet cap must be a flex column: a block wrapper caps only
		// itself, the body grows past it and the chip list never scrolls — an
		// expanded section spills below the sheet (under Android's nav bar).
		const cap = document.body.querySelector('[class*="max-h-[80dvh]"]');
		if (!(cap instanceof HTMLElement)) throw new Error("no sheet cap");
		expect(cap.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0"]));
	});

	it("avatar images load lazily (loading=lazy, decoding=async)", async () => {
		renderRow({
			...pickerBase,
			links: [],
			characters: [{ id: "a1", name: "Anna", avatarAssetId: "asset-1" }],
		});
		openDesktopPicker();
		const img = await waitFor(() => {
			const el = document.body.querySelector("img");
			expect(el).toBeTruthy();
			return el as HTMLImageElement;
		});
		expect(img.getAttribute("loading")).toBe("lazy");
		expect(img.getAttribute("decoding")).toBe("async");
	});
});
