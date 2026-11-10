/**
 * THE one typed React synthetic event factory for direct-handler tests
 * (step 8 batch 8b — TYPE_SAFETY_CAST_DEBT_REPORT).
 *
 * Hooks and toast actions are driven by calling their handlers DIRECTLY
 * (renderHook — no element to dispatch through), so tests hand-crafted
 * partial objects and erased them: `{ ... } as unknown as
 * React.MouseEvent<...>` — the erasure class the type-gate exists to kill.
 * This factory replaces the erasure with a member-for-member
 * `React.MouseEvent<HTMLButtonElement, MouseEvent>` literal: every required
 * BaseSyntheticEvent/UIEvent/MouseEvent member present with inert defaults,
 * a real happy-dom `MouseEvent` as `nativeEvent`, and a detached button as
 * the target (the shape React hands a toast-action `onClick`). The compiler
 * checks the member set at this one definition site; consumers cast nothing.
 *
 * Consumers: use-agent-run-events + use-chat-events (sonner toast `Action`
 * clicks — the type is sonner's `Action["onClick"]` param, not this file's
 * choice).
 */
import type React from "react";

/** The `view` member React synthetic UIEvents carry (`React.UIEvent["view"]`):
 *  it requires a `styleMedia` member happy-dom's window does not have, so the
 *  factory builds the view around the real document. */
export function inertView(): React.UIEvent["view"] {
	return {
		document: document,
		styleMedia: { type: "", matchMedium: () => false },
	};
}

export function toastClickEvent(): React.MouseEvent<HTMLButtonElement, MouseEvent> {
	const target = document.createElement("button");
	return {
		nativeEvent: new MouseEvent("click"),
		currentTarget: target,
		target,
		bubbles: false,
		cancelable: false,
		defaultPrevented: false,
		eventPhase: 0,
		isTrusted: false,
		preventDefault() {},
		isDefaultPrevented: () => false,
		stopPropagation() {},
		isPropagationStopped: () => false,
		persist() {},
		timeStamp: 0,
		type: "click",
		detail: 0,
		view: inertView(),
		altKey: false,
		button: 0,
		buttons: 0,
		clientX: 0,
		clientY: 0,
		ctrlKey: false,
		getModifierState: () => false,
		metaKey: false,
		movementX: 0,
		movementY: 0,
		pageX: 0,
		pageY: 0,
		relatedTarget: null,
		screenX: 0,
		screenY: 0,
		shiftKey: false,
	};
}
