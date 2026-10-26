/**
 * The ONE shared `stores/api-actions/bootstrap-actions.js` seam for every
 * apps/web test file that mocks ANY export of the module — the action-only
 * mockers AND the store-narrowing mockers — plus every suite that needs the
 * REAL `useBootstrapStore` zustand hook.
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts,
 * test/i18n-context-seam.ts): `mock.module` is process-global and
 * last-write-wins, and a hand-bundled run shares the module registry — so a
 * file that narrows `useBootstrapStore` to a plain selector function
 * (ScriptEditor: `selector({ personas: [] })`, LorebookEditor, TopBar,
 * CoauthorTurnShell) leaves that plain function live for EVERY later file in
 * the process. The real-store suites (AgentProfileModal, AgentSettingsModal)
 * reset and seed state through `useBootstrapStore.setState(...)` and die
 * wholesale when they inherit the plain function (`TypeError:
 * useBootstrapStore.setState is not a function`, 46/46 in the reproduced
 * ScriptEditor × AgentProfileModal pair, 2026-10-27 co-load unit).
 *
 * THE CROSS-FILE DELEGATION-CAPTURE TRAP: a victim CANNOT un-poison itself
 * with the R4 spread — `const real = await import(...)` executed AFTER a
 * poisoning registration returns the module namespace whose `useBootstrapStore`
 * slot ALREADY holds the plain function (bun replaces export slots in place;
 * see the react-markdown seam header), so `{ ...real, myAction }` re-registers
 * the POISON. The seam fixes this the same way the other seams do: the real
 * namespace — and the real `useBootstrapStore` as a bare function reference —
 * are captured ONCE, at the seam module's first import. Every family member
 * imports the seam BEFORE any of them registers, so the capture is always
 * clean (the only narrow-store registrations come from seam members, all of
 * which import the seam first).
 *
 * Registration shapes:
 *  - action-only mockers (the majority): `installBootstrapActionsSeam({
 *    patchUiSettingsAction })` — the real store is restored implicitly, their
 *    action overrides apply. This is a strict improvement over the inline R4
 *    mock: the inline form's `...real` spread PROPAGATES whatever store slot
 *    was live at its capture (the poison, if a narrow mocker ran first).
 *  - store-narrowing mockers: `installBootstrapActionsSeam({
 *    useBootstrapStore: mySelectorFn })` — their own narrow semantics for
 *    their own run, every other export real.
 *  - real-store victims: `installBootstrapActionsSeam({ myAction })` — same
 *    as action-only; the real hook (with `setState`/`getState`) is live again
 *    from this registration on.
 *
 * EVERY file that mocks the module must register through the seam — a file
 * that mocks it inline re-introduces the propagation trap for everyone after
 * it. Call `installBootstrapActionsSeam(...)` in the test-file body BEFORE
 * importing the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

/* A LOAD-TIME COPY of the real namespace: bun rewrites a module namespace's export slots IN PLACE on every registration, so spreading the live namespace inside a factory would re-register whatever the PREVIOUS registration left there (self-poisoning by alias). The copy is immune — the load-time slots stay pristine forever. */
const realBootstrapActions = { ...(await import("../src/stores/api-actions/bootstrap-actions.js")) };
/** The real zustand hook, captured as a bare reference BEFORE any registration — see the header. */
const realUseBootstrapStore = realBootstrapActions.useBootstrapStore;

/** Per-file overrides on top of the real namespace; the real store is the default. Keys are checked against the real module (a typo is a TS error); values are loose — they are test doubles (narrow selector fns, `mock()` actions with fixture returns), not the real signatures. */
export type BootstrapActionsSeamOverrides = {
	[K in keyof typeof realBootstrapActions]?: unknown;
};

/** Register the shared bootstrap-actions seam (re-registration simply owns the process until the next one). */
export function installBootstrapActionsSeam(overrides: BootstrapActionsSeamOverrides = {}): void {
	mock.module("../src/stores/api-actions/bootstrap-actions.js", () => ({
		...realBootstrapActions,
		useBootstrapStore: realUseBootstrapStore,
		...overrides,
	}));
}
