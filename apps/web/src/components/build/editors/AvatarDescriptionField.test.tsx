/**
 * AvatarDescriptionField — characterization tests.
 *
 * Pins the CURRENT observable behavior of the avatar-description UI so the
 * extraction into shared/generation-feedback.tsx cannot regress it:
 *   - idle vs regenerate button labels (driven by committed avatarDescription)
 *   - click "Describe via vision" → onDescribe receives an AbortSignal, the
 *     textarea locks, the "Describing…" overlay appears, the button morphs
 *     to "Cancel"
 *   - cancel → signal aborted, NO toast.error (silent abort path)
 *   - onDescribe rejects with non-AbortError → toast.error with the message
 *   - blur commits a trimmed draft via onPatch (null when emptied); no-op
 *     when the draft is unchanged
 *   - include-in-prompt toggle → onPatch({ includeAvatarInPrompt })
 *   - no avatar → textarea + button disabled, hint copy visible
 *
 * Runner: bun:test with scoped happy-dom. Mirrors the
 * LoreEntryEditor.test.tsx harness shape.
 */
import { describe, it, expect, mock, beforeAll, beforeEach } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const toastError = mock();
const realI18nContext = await import("../../../i18n/context.js");
const realSonner = await import("sonner");
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		t: (k: string) => k,
		tDynamic: (k: string) => k,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));
mock.module("sonner", () => ({
	...realSonner,
	toast: { ...realSonner.toast, error: toastError },
}));

let AvatarDescriptionField: typeof import("./AvatarDescriptionField.js").AvatarDescriptionField;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
	({ render, fireEvent, waitFor } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ AvatarDescriptionField } = await import("./AvatarDescriptionField.js"));
});

/** Deferred promise — lets the test park the component mid-generation. */
function deferred<T = void>() {
	let resolve: (v: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function renderField(overrides: Partial<Parameters<typeof AvatarDescriptionField>[0]> = {}) {
	const props = {
		kind: "character" as const,
		includeAvatarInPrompt: false,
		avatarDescription: null as string | null,
		hasAvatar: true,
		onPatch: mock(),
		onDescribe: mock(() => Promise.resolve()),
		...overrides,
	};
	return render(<AvatarDescriptionField {...props} />);
}

beforeEach(() => {
	toastError.mockClear();
});

describe("AvatarDescriptionField (characterization)", () => {
	it("(a) idle label = avatar_describe_via_vision when avatarDescription is empty", () => {
		const { getByText } = renderField({ avatarDescription: null });
		expect(getByText("avatar_describe_via_vision")).not.toBeNull();
	});

	it("(b) shows avatar_describe_regenerate when avatarDescription is provided", () => {
		const { getByText } = renderField({ avatarDescription: "a portrait" });
		expect(getByText("avatar_describe_regenerate")).not.toBeNull();
	});

	it("(c) click generate → onDescribe(AbortSignal), textarea disabled, overlay shows avatar_describing, button becomes avatar_describe_cancel", async () => {
		const { promise } = deferred();
		const onDescribe = mock((_signal: AbortSignal) => promise);
		const { getByText, container } = renderField({ onDescribe });

		fireEvent.click(getByText("avatar_describe_via_vision"));
		await waitFor(() => expect(onDescribe).toHaveBeenCalledTimes(1));

		const signal = onDescribe.mock.calls[0]?.[0];
		expect(signal).toBeInstanceOf(AbortSignal);
		if (!signal) throw new Error("onDescribe did not receive an AbortSignal");

		await waitFor(() => expect(getByText("avatar_describing")).not.toBeNull());
		expect(getByText("avatar_describe_cancel")).not.toBeNull();

		const textarea = container.querySelector("textarea")!;
		expect(textarea.disabled).toBe(true);
	});

	it("(d) click cancel → signal aborted, toast.error NOT called", async () => {
		const { promise } = deferred();
		const onDescribe = mock((_signal: AbortSignal) => promise);
		const { getByText } = renderField({ onDescribe });

		fireEvent.click(getByText("avatar_describe_via_vision"));
		await waitFor(() => expect(onDescribe).toHaveBeenCalledTimes(1));
		const signal = onDescribe.mock.calls[0]?.[0];
		if (!signal) throw new Error("onDescribe did not receive an AbortSignal");

		fireEvent.click(getByText("avatar_describe_cancel"));
		expect(signal.aborted).toBe(true);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("(e) onDescribe rejects (non-abort) → toast.error called with the message", async () => {
		const onDescribe = mock(() => Promise.reject(new Error("boom")));
		const { getByText } = renderField({ onDescribe });

		fireEvent.click(getByText("avatar_describe_via_vision"));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
	});

	it("(f) blur after typing → onPatch({ avatarDescription: trimmed })", async () => {
		const onPatch = mock();
		const { container } = renderField({ avatarDescription: null, onPatch });
		const textarea = container.querySelector("textarea")!;

		await userEvent.setup().type(textarea, "  hello  ");
		fireEvent.blur(textarea);
		expect(onPatch).toHaveBeenCalledWith({ avatarDescription: "hello" });
	});

	it("(g) blur with unchanged draft → no onPatch", () => {
		const onPatch = mock();
		const { container } = renderField({ avatarDescription: "same", onPatch });
		const textarea = container.querySelector("textarea")!;

		// Draft seeded from prop; blur without editing.
		fireEvent.blur(textarea);
		expect(onPatch).not.toHaveBeenCalled();
	});

	it("(h) toggle click → onPatch({ includeAvatarInPrompt: true })", () => {
		const onPatch = mock();
		const { getByRole } = renderField({ includeAvatarInPrompt: false, onPatch });
		// Radix Switch = role="switch".
		fireEvent.click(getByRole("switch"));
		expect(onPatch).toHaveBeenCalledWith({ includeAvatarInPrompt: true });
	});

	it("(i) hasAvatar=false → textarea + button disabled, no-avatar hint visible", () => {
		const { getByText, container } = renderField({ hasAvatar: false });
		const textarea = container.querySelector("textarea")!;
		expect(textarea.disabled).toBe(true);

		const button = getByText("avatar_describe_via_vision").closest("button")!;
		expect(button.disabled).toBe(true);

		expect(getByText("avatar_description_no_avatar_char")).not.toBeNull();
	});
});
