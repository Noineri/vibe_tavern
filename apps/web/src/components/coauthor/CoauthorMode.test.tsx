/**
 * CA-14 — mobile tab state machine (`useCoauthorMobileTab`).
 *
 * The contract under test (extracted from CoauthorMode so it's testable without
 * a viewport mock — mocking `use-mobile` collides with VibeMdView.test
 * process-globally, see AGENTS.md `mock.module` gotcha):
 *  - default tab is Chat;
 *  - on mobile, a false→true proposal edge auto-switches to Doc + arms a
 *    one-shot pulse (the highlight that draws the user to the diff);
 *  - the pulse self-clears after the animation window;
 *  - a user who taps back to Chat while a proposal is pending is NOT yanked
 *    back to Doc (the edge ref prevents re-triggering);
 *  - on desktop, or when a proposal is already pending on mount, no
 *    auto-switch happens (no jarring jump on chat open).
 */
import { describe, it, expect } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import { useCoauthorMobileTab } from "./CoauthorMode.js";

describe("useCoauthorMobileTab", () => {
	useDomEnv();
	it("defaults to the Chat tab", () => {
		const { result } = renderHook(() => useCoauthorMobileTab(false, false));
		expect(result.current.mobileTab).toBe("chat");
		expect(result.current.docPulse).toBe(false);
	});

	it("does NOT auto-switch on desktop even when a proposal lands", () => {
		const { result, rerender } = renderHook(({ m, p }) => useCoauthorMobileTab(m, p), {
			initialProps: { m: false, p: false },
		});
		rerender({ m: false, p: true });
		expect(result.current.mobileTab).toBe("chat");
		expect(result.current.docPulse).toBe(false);
	});

	it("auto-switches to Doc and arms the pulse on the proposal edge (mobile)", () => {
		const { result, rerender } = renderHook(({ m, p }) => useCoauthorMobileTab(m, p), {
			initialProps: { m: true, p: false },
		});
		expect(result.current.mobileTab).toBe("chat");
		rerender({ m: true, p: true });
		expect(result.current.mobileTab).toBe("doc");
		expect(result.current.docPulse).toBe(true);
	});

	it("does NOT auto-switch when a proposal is already pending on mount (mobile)", () => {
		// Opening a chat that already has a pending proposal must not yank the
		// user to Doc — the edge only fires on a mid-session false→true transition.
		const { result } = renderHook(() => useCoauthorMobileTab(true, true));
		expect(result.current.mobileTab).toBe("chat");
		expect(result.current.docPulse).toBe(false);
	});

	it("does NOT re-trigger after the user taps back to Chat mid-review", () => {
		const { result, rerender } = renderHook(({ m, p }) => useCoauthorMobileTab(m, p), {
			initialProps: { m: true, p: false },
		});
		// Proposal lands → auto-switch to Doc.
		rerender({ m: true, p: true });
		expect(result.current.mobileTab).toBe("doc");
		// User deliberately switches back to Chat while the proposal is still pending.
		act(() => result.current.setMobileTab("chat"));
		expect(result.current.mobileTab).toBe("chat");
		// hasProposal is unchanged (still true) → no new edge → no re-trigger.
		rerender({ m: true, p: true });
		expect(result.current.mobileTab).toBe("chat");
	});

	it("auto-switches again only on a fresh review cycle (true→false→true)", () => {
		const { result, rerender } = renderHook(({ m, p }) => useCoauthorMobileTab(m, p), {
			initialProps: { m: true, p: false },
		});
		// First proposal → Doc.
		rerender({ m: true, p: true });
		expect(result.current.mobileTab).toBe("doc");
		// Applied/rejected → no proposal → user returns to Chat.
		rerender({ m: true, p: false });
		act(() => result.current.setMobileTab("chat"));
		// A second proposal is a new edge → auto-switch fires again.
		rerender({ m: true, p: true });
		expect(result.current.mobileTab).toBe("doc");
		expect(result.current.docPulse).toBe(true);
	});
});
