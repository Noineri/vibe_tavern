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
 * Runner: vitest (apps/web — vi.mock is file-scoped + hoisted). Mirrors the
 * LoreEntryEditor.test.tsx harness shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { AvatarDescriptionField } from "./AvatarDescriptionField.js";

vi.mock("../../../i18n/context.js", () => ({
	useT: () => ({
		t: (k: string) => k,
		tDynamic: (k: string) => k,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn() },
}));

// Imported AFTER the sonner mock so tests receive the mocked fn.
import { toast } from "sonner";

/** Deferred promise — lets the test park the component mid-generation. */
function deferred<T = void>() {
	let resolve!: (v: T | PromiseLike<T>) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function renderField(overrides: Partial<Parameters<typeof AvatarDescriptionField>[0]> = {}) {
	const props = {
		kind: "character" as const,
		includeAvatarInPrompt: false,
		avatarDescription: null as string | null,
		hasAvatar: true,
		onPatch: vi.fn(),
		onDescribe: vi.fn(),
		...overrides,
	};
	return render(<AvatarDescriptionField {...props} />);
}

beforeEach(() => {
	vi.clearAllMocks();
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
		const onDescribe = vi.fn<(signal: AbortSignal) => Promise<void>>(() => promise);
		const { getByText, container } = renderField({ onDescribe });

		fireEvent.click(getByText("avatar_describe_via_vision"));
		await waitFor(() => expect(onDescribe).toHaveBeenCalledTimes(1));

		const signal = onDescribe.mock.calls[0]![0];
		expect(signal).toBeInstanceOf(AbortSignal);

		await waitFor(() => expect(getByText("avatar_describing")).not.toBeNull());
		expect(getByText("avatar_describe_cancel")).not.toBeNull();

		const textarea = container.querySelector("textarea")!;
		expect(textarea.disabled).toBe(true);
	});

	it("(d) click cancel → signal aborted, toast.error NOT called", async () => {
		const { promise } = deferred();
		const onDescribe = vi.fn<(signal: AbortSignal) => Promise<void>>(() => promise);
		const { getByText } = renderField({ onDescribe });

		fireEvent.click(getByText("avatar_describe_via_vision"));
		await waitFor(() => expect(onDescribe).toHaveBeenCalledTimes(1));
		const signal = onDescribe.mock.calls[0]![0];

		fireEvent.click(getByText("avatar_describe_cancel"));
		expect(signal.aborted).toBe(true);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("(e) onDescribe rejects (non-abort) → toast.error called with the message", async () => {
		const onDescribe = vi.fn<() => Promise<void>>(() => Promise.reject(new Error("boom")));
		const { getByText } = renderField({ onDescribe });

		fireEvent.click(getByText("avatar_describe_via_vision"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
	});

	it("(f) blur after typing → onPatch({ avatarDescription: trimmed })", () => {
		const onPatch = vi.fn();
		const { container } = renderField({ avatarDescription: null, onPatch });
		const textarea = container.querySelector("textarea")!;

		fireEvent.change(textarea, { target: { value: "  hello  " } });
		fireEvent.blur(textarea);
		expect(onPatch).toHaveBeenCalledWith({ avatarDescription: "hello" });
	});

	it("(g) blur with unchanged draft → no onPatch", () => {
		const onPatch = vi.fn();
		const { container } = renderField({ avatarDescription: "same", onPatch });
		const textarea = container.querySelector("textarea")!;

		// Draft seeded from prop; blur without editing.
		fireEvent.blur(textarea);
		expect(onPatch).not.toHaveBeenCalled();
	});

	it("(h) toggle click → onPatch({ includeAvatarInPrompt: true })", () => {
		const onPatch = vi.fn();
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
