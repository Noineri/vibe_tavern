/**
 * CanvasCard — structural characterization (APC-3b).
 *
 * Pins the unified card's render contract before Wave 4 migrates the per-type
 * cards (EditablePromptCard / EditableAuthorNoteCard / CharacterFieldCard /
 * InjectionRowView / PromptOrderMarker) onto it:
 *
 *   • collapsed — header always shows the category icon + label; the body
 *     editor (AutoTextarea) does NOT render until expanded.
 *   • expanded — the AutoTextarea binds to `value` and forwards `onChange`.
 *   • onRoleChange — the role SegmentedControl renders in the body (the custom-
 *     injection parity control the field cards lack).
 *   • nonExpandable — a marker row never opens a body (PromptOrderMarker parity).
 *   • onToggle — fires from the enable button without expanding the body.
 *
 * useT is mocked at the module boundary (safe `mock.module` pattern: capture
 * the real module first, spread it, override only `useT`) so the card renders
 * without a live i18n instance.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../../i18n/context.js");
// Mock useT at the module boundary (same relative path the component uses).
mock.module("../../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const { render, fireEvent } = await import("@testing-library/react");
const { TooltipProvider } = await import("../../../shared/Tooltip.js");
let CanvasCard: typeof import("./CanvasCard.js").CanvasCard;

beforeAll(async () => {
	({ CanvasCard } = await import("./CanvasCard.js"));
});

/** Wrap in TooltipProvider — CustomTooltip (Radix) requires the context. */
function renderCard(node: React.ReactElement) {
	return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe("CanvasCard — structural characterization", () => {
	it("collapsed: renders header (category icon + label) but NOT the body editor", () => {
		const { container, getByText } = renderCard(
			<CanvasCard identifier="main" category="standard" label="System Prompt" value="You are X" role="system" badge="editable" />,
		);
		expect(getByText("System Prompt")).toBeTruthy();
		// category icon is an inline svg in the header
		expect(container.querySelector("svg")).toBeTruthy();
		// the editor body is absent while collapsed
		expect(container.querySelector("textarea")).toBeNull();
	});

	it("expanding renders the AutoTextarea bound to `value` and forwards onChange", () => {
		const onChange = mock();
		const { container, getByText } = renderCard(
			<CanvasCard identifier="nsfw" category="standard" label="NSFW" value="rules" editable onChange={onChange} />,
		);
		// click the label text — bubbles to the header onClick → expands
		fireEvent.click(getByText("NSFW"));
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(ta).toBeTruthy();
		expect(ta.value).toBe("rules");
		fireEvent.change(ta, { target: { value: "new rules" } });
		expect(onChange).toHaveBeenCalledWith("new rules");
	});

	it("onRoleChange renders the role SegmentedControl (system/user/assistant) in the body", () => {
		const onRoleChange = mock();
		const { container, getByText } = renderCard(
			<CanvasCard identifier="custom1" category="custom" label="My Injection" value="c" role="user" onRoleChange={onRoleChange} />,
		);
		fireEvent.click(getByText("My Injection"));
		// the three role options render as radio labels in the body
		expect(container.textContent).toContain("system");
		expect(container.textContent).toContain("user");
		expect(container.textContent).toContain("assistant");
	});

	it("nonExpandable marker row never opens a body (PromptOrderMarker parity)", () => {
		const { container, getByText } = renderCard(
			<CanvasCard identifier="worldInfoBefore" category="anchor" label="World Info Before" nonExpandable badge="read-only" />,
		);
		expect(getByText("World Info Before")).toBeTruthy();
		fireEvent.click(getByText("World Info Before"));
		// still no editor after a header click
		expect(container.querySelector("textarea")).toBeNull();
	});

	it("onToggle fires from the enable button without expanding the body", () => {
		const onToggle = mock();
		const { container } = renderCard(
			<CanvasCard identifier="main" category="standard" label="System" value="x" onToggle={onToggle} />,
		);
		const toggle = container.querySelector('button[aria-label="cc_enabled"]') as HTMLButtonElement;
		expect(toggle).toBeTruthy();
		fireEvent.click(toggle);
		expect(onToggle).toHaveBeenCalledTimes(1);
		// the stopPropagation on the toggle keeps the body collapsed
		expect(container.querySelector("textarea")).toBeNull();
	});
});
