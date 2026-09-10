import { beforeAll, describe, expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// auto-textarea reads `window.HTMLTextAreaElement` at module scope, so it
// must be imported only after useDomEnv() has registered happy-dom.
let AutoTextarea: typeof import("./auto-textarea.js").AutoTextarea;
let TextInput: typeof import("./text-input.js").TextInput;
let MaskedConnectionKeyField: typeof import("./masked-connection-key-field.js").MaskedConnectionKeyField;
beforeAll(async () => {
	({ AutoTextarea } = await import("./auto-textarea.js"));
	({ TextInput } = await import("./text-input.js"));
	({ MaskedConnectionKeyField } = await import("./masked-connection-key-field.js"));
});

/** FS-2 acceptance: a bare primitive IS the canon — the enforcement contract
 *  of the whole field-system unification. If these pins break, the canon
 *  drifted out of the primitives and back into call-site discipline. */
describe("FS-2 primitives carry the canon by default", () => {
	it("bare AutoTextarea renders the canonical textarea class", () => {
		const { getByRole } = render(<AutoTextarea minRows={2} />);
		const ta = getByRole("textbox") as HTMLTextAreaElement;
		expect(ta.className).toContain("rounded-[6px]");
		expect(ta.className).toContain("overflow-y-auto");
		expect(ta.className).toContain("resize-none");
		expect(ta.className).toContain("focus:border-accent");
		expect(ta.className).not.toContain("text-xs");
	});

	it("AutoTextarea mono variant composes the base + monoMod, still no own size", () => {
		const { getByRole } = render(<AutoTextarea mono minRows={2} />);
		const ta = getByRole("textbox") as HTMLTextAreaElement;
		expect(ta.className).toContain("font-mono");
		expect(ta.className).toContain("overflow-y-auto");
		expect(ta.className).not.toContain("text-xs");
	});

	it("AutoTextarea with an explicit className keeps full caller control (migration window)", () => {
		const { getByRole } = render(<AutoTextarea className="my-extension" minRows={2} />);
		expect((getByRole("textbox") as HTMLTextAreaElement).className).toContain("my-extension");
	});

	it("bare TextInput renders the canonical single-line shape", () => {
		const { getByRole } = render(<TextInput />);
		const el = getByRole("textbox") as HTMLInputElement;
		expect(el.className).toContain("h-11 sm:h-[38px]");
		expect(el.className).toContain("rounded-[6px]");
		expect(el.className).toContain("px-[13px]");
		expect(el.className).not.toContain("font-mono");
	});

	it("TextInput mono composes monoMod; readOnly appends readonlyMod automatically", () => {
		const { getByRole } = render(<TextInput mono readOnly />);
		const el = (getByRole("textbox") as HTMLInputElement);
		expect(el.className).toContain("font-mono");
		expect(el.className).toContain("!cursor-not-allowed");
		expect(el.className).toContain("!opacity-60");
		expect(el.className).not.toContain("text-xs");
	});

	it("TextInput spreads standard input props (controlled value + onChange)", () => {
		const { getByRole } = render(
			<TextInput value="abc" onChange={() => {}} placeholder="p" />,
		);
		const el = getByRole("textbox") as HTMLInputElement;
		expect(el.value).toBe("abc");
		expect(el.placeholder).toBe("p");
	});

	it("MaskedConnectionKeyField is built on the canonical shape (mono + eye gutter)", () => {
		const { getByTestId } = render(
			<MaskedConnectionKeyField
				value="sk-test"
				onChange={() => {}}
				fieldTestId="k"
				toggleTestId="t"
				statusTestId="s"
				storedPlaceholder="stored"
				storedStatus="stored"
				showLabel="show"
				hideLabel="hide"
			/>,
		);
		const field = getByTestId("k") as HTMLInputElement;
		expect(field.type).toBe("password");
		expect(field.className).toContain("h-11 sm:h-[38px]");
		expect(field.className).toContain("font-mono");
		expect(field.className).toContain("!pr-10");
		// toggle still flips the type; status line still appears for empty+stored
		fireEvent.click(getByTestId("t"));
		expect(field.type).toBe("text");
	});
});
