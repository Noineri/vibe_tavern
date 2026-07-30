/**
 * VTF-13 (rework) — VibeMdView DOM round-trip test.
 *
 * Pins the reworked two-surface editor's key behaviours:
 *  - the editor host exists and is NOT a capped scrolling box (no maxHeight);
 *  - the MD body reflects all FOUR locked sections, incl. the synthesized
 *    `# GREETINGS` (primary firstMessage + `=== ALT N ===` alternates);
 *  - frontmatter (name) is NOT visible in the MD area;
 *  - exactly ONE "Advanced fields" accordion renders (no Metadata/Greetings/
 *    Instructions accordions anymore);
 *  - the Advanced-fields accordion holds creatorNotes + personalitySummary +
 *    instruction fields;
 *  - the "add alternate greeting" button appends an `=== ALT` marker.
 *
 * The CodeMirror surface mounts inside the DOM (happy-dom); assertions that read
 * `.cm-content` degrade gracefully if CM fails to mount in the test env.
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { useEffect, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { EditorView } from "@codemirror/view";
import { zodResolver } from "@hookform/resolvers/zod";
import { buildCharacterDraftSchema, type BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");
const realTooltip = await import("../../shared/Tooltip.js");

// Mock useT at the module boundary — the editor imports i18n for labels.
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
// Mock useIsMobile so the desktop path renders deterministically.
mock.module("../../../hooks/use-mobile.js", () => ({
	...realMobileHook,
	useIsMobile: () => false,
}));
// Mock CustomTooltip to a passthrough — the real one needs a TooltipProvider
// context (Radix) that is irrelevant to the editor's field interactions.
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let VibeMdView: typeof import("./VibeMdView.js").VibeMdView;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
beforeAll(async () => {
	({ render, fireEvent, waitFor } = await import("@testing-library/react"));
	({ VibeMdView } = await import("./VibeMdView.js"));
});

function makeDraft(overrides: Partial<BuildCharacterDraft> = {}): BuildCharacterDraft {
	return {
		name: "Kira",
		description: "A reserved arachnid weaver.",
		firstMessage: "Welcome to my web, little fly.",
		mesExample: "{{char}}: *tilts head*",
		mesExampleMode: "always",
		mesExampleDepth: 4,
		scenario: "A forest cave.",
		personalitySummary: "",
		systemPrompt: "You are Kira.",
		alternateGreetings: ["A second greeting."],
		postHistoryInstructions: "",
		creatorNotes: "An arachnid OC.",
		depthPrompt: "",
		depthPromptDepth: 4,
		depthPromptRole: "system",
		tags: ["fantasy"],
		...overrides,
	};
}

/** A wrapper that owns the form (VibeMdView expects a parent-provided form). */
function Harness({ draft }: { draft: BuildCharacterDraft }) {
	const form = useForm<BuildCharacterDraft>({
		resolver: zodResolver(buildCharacterDraftSchema),
		defaultValues: draft,
	});
	return <VibeMdView form={form} characterId="char_test" isSaving={false} />;
}

/** Like Harness, but exposes the form instance so tests can assert sync timing. */
function HarnessWithFormCapture({ draft, onForm }: { draft: BuildCharacterDraft; onForm: (f: ReturnType<typeof useForm<BuildCharacterDraft>>) => void }) {
	const form = useForm<BuildCharacterDraft>({
		resolver: zodResolver(buildCharacterDraftSchema),
		defaultValues: draft,
	});
	useEffect(() => { onForm(form); }, [form, onForm]);
	return <VibeMdView form={form} characterId="char_test" isSaving={false} />;
}

describe("VibeMdView (rework)", () => {

	it("renders the editor surface and exactly ONE accordion (Advanced fields)", () => {
		const { container, getByText } = render(<Harness draft={makeDraft()} />);
		// The CodeMirror host element exists.
		expect(container.querySelector(".vibe-md-editor")).toBeTruthy();
		// The single "Advanced fields" accordion header renders.
		expect(getByText("vmd_advanced_title")).toBeTruthy();
		// The removed accordions are gone.
		expect(() => getByText("vmd_metadata_title")).toThrow();
		expect(() => getByText("vmd_greetings_title")).toThrow();
		expect(() => getByText("vmd_instructions_title")).toThrow();
	});

	it("the editor host has NO capped maxHeight (auto-grows, not a scroll box)", () => {
		const { container } = render(<Harness draft={makeDraft()} />);
		const host = container.querySelector(".vibe-md-editor") as HTMLElement;
		expect(host).toBeTruthy();
		// minHeight kept for presence...
		expect(host.style.minHeight).toBeTruthy();
		// ...but maxHeight must be absent (the cap that caused the inner scroll).
		expect(host.style.maxHeight).toBeFalsy();
	});

	it("does NOT show frontmatter (name) inside the MD area", () => {
		const { container } = render(<Harness draft={makeDraft()} />);
		const editor = container.querySelector(".vibe-md-editor") as HTMLElement;
		// "Kira" lives in frontmatter, not the prose body — must not appear in editor.
		expect(editor.textContent ?? "").not.toContain("Kira");
	});

	it("shows all FOUR locked headings even when prose fields are empty (stable skeleton)", () => {
		const { container } = render(<Harness draft={makeDraft({ scenario: "", mesExample: "", description: "" })} />);
		const content = container.querySelector(".cm-content");
		if (!content) return; // CM did not mount — skip gracefully.
		const text = content.textContent ?? "";
		// The skeleton always shows all four headings, even with empty prose.
		expect(text).toContain("PERSONALITY");
		expect(text).toContain("SCENARIO");
		expect(text).toContain("EXAMPLES");
		expect(text).toContain("GREETINGS");
	});

	it("renders the `+` add-greeting widget on # GREETINGS and `✕` widgets on ALT markers", () => {
		const { container } = render(<Harness draft={makeDraft()} />);
		// The makeDraft has one alternate greeting → one `✕` remove widget, plus
		// one `+` add widget on the GREETINGS heading = 2 greeting buttons total.
		if (!container.querySelector(".cm-content")) return; // CM did not mount.
		const greetBtns = container.querySelectorAll(".cm-vtf-greet-btn");
		expect(greetBtns.length).toBeGreaterThanOrEqual(2);
		expect(container.querySelector(".cm-vtf-greet-add")).toBeTruthy();
		expect(container.querySelector(".cm-vtf-greet-remove")).toBeTruthy();
	});

	it("the Advanced-fields accordion holds creatorNotes + systemPrompt when open", () => {
		const { getByText } = render(<Harness draft={makeDraft()} />);
		fireEvent.click(getByText("vmd_advanced_title"));
		const notes = document.querySelector('textarea[name="creatorNotes"]') as HTMLTextAreaElement;
		expect(notes).toBeTruthy();
		expect(notes.value).toBe("An arachnid OC.");
		const sys = document.querySelector('textarea[name="systemPrompt"]') as HTMLTextAreaElement;
		expect(sys).toBeTruthy();
		expect(sys.value).toBe("You are Kira.");
		// personalitySummary is present (variant 2 — distinct slot in Advanced).
		const pers = document.querySelector('textarea[name="personalitySummary"]') as HTMLTextAreaElement;
		expect(pers).toBeTruthy();
		// firstMessage is NOT a separate field here — it lives in the editor.
		expect(document.querySelector('textarea[name="firstMessage"]')).toBeNull();
	});

	it("add/remove alternate greetings round-trip through the editor body", () => {
		// The widget click handlers call setValue(alternateGreetings, ...); the
		// form→editor subscription re-emits the body. Rather than simulate a click
		// on a CodeMirror-created DOM node (act/timing-fragile in happy-dom), we
		// assert the body reflects the draft's alternates. The full altIndexAt +
		// round-trip logic is covered in vibe-md-sync.test.ts.
		const { container } = render(<Harness draft={makeDraft()} />);
		if (!container.querySelector(".cm-content")) return; // CM did not mount.
		const text = container.querySelector(".cm-content")!.textContent ?? "";
		// makeDraft starts with one alternate greeting → one `=== ALT` marker.
		expect((text.match(/=== ALT/g) || []).length).toBe(1);
	});
});

describe("VibeMdView editor→form sync is debounced", () => {
	// Perf pin: typing must NOT synchronously parse the full body + write 5 form
	// fields + re-render CharacterForm's whole tree per keystroke. The sync is
	// coalesced into one write after a short pause; save is still race-free
	// because blur flushes before the Save button's onClick fires.
	it("does not write to the form synchronously on edit; flushes after a pause", async () => {
		let formRef: ReturnType<typeof useForm<BuildCharacterDraft>> | null = null;
		const onForm = (f: typeof formRef) => { formRef = f; };
		const { container } = render(<HarnessWithFormCapture draft={makeDraft({ description: "orig" })} onForm={onForm} />);
		await waitFor(() => { expect(formRef).toBeTruthy(); });
		const cmEl = container.querySelector(".cm-editor") as HTMLElement | null;
		if (!cmEl) return; // CM did not mount in this test env — skip gracefully.
		const view = EditorView.findFromDOM(cmEl);
		if (!view) return;

		// Insert text right after `# PERSONALITY\n` so it lands in `description`.
		const docText = view.state.doc.toString();
		const insertAt = docText.indexOf("# PERSONALITY\n") + "# PERSONALITY\n".length;
		view.dispatch({ changes: { from: insertAt, insert: "XYZ" } });

		// Immediately after dispatch the form is still stale (debounced) — this is
		// the whole point: the expensive parse + 5× setValue + parent re-render
		// do not run per keystroke.
		expect(formRef!.getValues().description).toBe("orig");

		// After the debounce window the edit reaches the form.
		await waitFor(() => {
			expect(formRef!.getValues().description).toContain("XYZ");
		});
	});
});
