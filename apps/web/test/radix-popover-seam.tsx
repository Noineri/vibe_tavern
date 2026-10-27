/**
 * The ONE shared `@radix-ui/react-popover` seam for every apps/web test file
 * that mocks the Radix popover surface (topbar-regex-indicator,
 * AgentSessionSwitcher, AgentShellPlan, ExperienceCopilotShell) — and the
 * guarantee that real-arm riders (AgentContextRing, QuotaIndicator, TopBar,
 * CoauthorTopBar — every suite that renders popovers through the REAL Radix)
 * keep real behavior no matter whose registration is live.
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts and
 * test/i18n-context-seam.ts): `mock.module` is process-global and
 * last-write-wins, and a hand-bundled run shares the module registry — so a
 * passthrough popover mock stays live for EVERY later file in the process.
 * The passthrough renders `Popover.Content` children UNCONDITIONALLY, which
 * erases the closed-state contract of every controlled popover: reproduced
 * 2026-10-27 (co-load unit), topbar-regex-indicator × AgentContextRing — the
 * ring pins `queryByTestId("copilot-context-meter")` to be null until the
 * trigger opens the popover, and the live passthrough made the meter render
 * at rest (2/15 red while each file was green alone).
 *
 * PER-RENDER DELEGATION (the i18n seam's provider trick, applied to Radix):
 * every app call site but ONE renders a CONTROLLED `<Popover.Root open={…}
 * onOpenChange={…}>` (the grep-clean inventory: AgentContextRing,
 * QuotaIndicator, MediaMenu, DicePanel, AppShell, DropdownSelect, …). Only
 * AgentSessionSwitcher renders an uncontrolled bare `<Popover.Root>`. So the
 * seam's Root decides per render:
 *  - CONTROLLED (`open` prop provided) → DELEGATE to the real Radix Root —
 *    real closed/open semantics, real portal, for every real-arm rider;
 *  - UNCONTROLLED → the deterministic stub: children always rendered inline
 *    (the legacy passthrough semantics the stub suites' pins were written
 *    against — AgentSessionSwitcher's session rows are queried at rest).
 * Trigger/Portal/Content/Anchor follow their Root via a context flag
 * (explicitly re-set by every Root, so nested Roots each get their own arm).
 * The flag DEFAULTS to stub: an ORPHAN popover part — no Root above it —
 * stubs too. This is load-bearing for TopBar: its settings Trigger
 * (TopBar.tsx:282) is an orphan BY DESIGN (the owning Root lives in
 * AppShell around `{shell.topBar}`), so a TopBar rendered alone — as
 * topbar-regex-indicator's harness does — throws «PopoverTrigger must be
 * used within Popover» under a real Trigger. Only a Root that took the real
 * branch (Provider value false) switches its subtree to the real Radix.
 * A suite whose pins read CONTROLLED popover content at rest
 * (ExperienceCopilotShell's ring-meter pins) registers with
 * `stubAllRoots: true` — its own registration is live for its own run only
 * (sequential hand-bundle: each file registers at its load, after the
 * previous file's tests), so it poisons nobody.
 *
 * The factory keeps the mandatory R4 shape: the real namespace is spread
 * (`Arrow`, `Close` and every other export stay real — the former inline
 * stubs in AgentSessionSwitcher/AgentShellPlan/ExperienceCopilotShell
 * returned ONLY five exports, so every other export was `undefined` for all
 * later files in a shared process).
 *
 * The DELEGATION CAPTURE RULE applies: the real parts are captured as bare
 * references BEFORE any registration — bun's `mock.module` replaces the
 * module's export slots in place, so reading `realPopover.Root` after
 * registration would re-enter the mock forever (test/react-markdown-seam.ts
 * header).
 *
 * Call `installRadixPopoverSeam(...)` in the test-file body BEFORE importing
 * the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

/* A LOAD-TIME COPY of the real namespace (bun rewrites export slots in place on
 * every registration; spreading the LIVE namespace inside the factory would
 * re-register the previous registration's values for every non-overridden
 * export — self-poisoning by alias; see test/snapshot-store-seam.ts). */
const realPopover = { ...(await import("@radix-ui/react-popover")) };
/** The real parts, captured as bare references BEFORE any registration — see the header. */
const RealRoot = realPopover.Root;
const RealTrigger = realPopover.Trigger;
const RealPortal = realPopover.Portal;
const RealContent = realPopover.Content;
const RealAnchor = realPopover.Anchor;

type RootProps = ComponentProps<typeof RealRoot>;
type TriggerProps = ComponentProps<typeof RealTrigger>;
type PortalProps = ComponentProps<typeof RealPortal>;
type ContentProps = ComponentProps<typeof RealContent>;
type AnchorProps = ComponentProps<typeof RealAnchor>;

/** True inside a Root the seam stubbed AND for Root-less (orphan) parts; only an explicit REAL Root sets it false. */
const StubRootContext = createContext(true);

/** Per-suite registration spec. */
export interface RadixPopoverSeamSpec {
	/**
	 * Stub CONTROLLED Roots too (the legacy passthrough-everything semantics)
	 * — for suites whose pins read controlled popover content at rest. The
	 * registration is live only for the registering file's own run.
	 */
	readonly stubAllRoots?: boolean;
}

/** Register the shared radix-popover seam (re-registration simply owns the process until the next one). */
export function installRadixPopoverSeam(spec: RadixPopoverSeamSpec = {}): void {
	const stubAllRoots = spec.stubAllRoots ?? false;
	const seamParts = new Map<object, object>([
		[
			RealRoot,
			function RadixPopoverSeamRoot(props: RootProps) {
				const stub = stubAllRoots || props.open === undefined;
				return (
					<StubRootContext.Provider value={stub}>
						{stub ? ((props.children as ReactNode) ?? null) : <RealRoot {...props} />}
					</StubRootContext.Provider>
				);
			},
		],
		[
			RealTrigger,
			function RadixPopoverSeamTrigger(props: TriggerProps) {
				return useContext(StubRootContext) ? ((props.children as ReactNode) ?? null) : <RealTrigger {...props} />;
			},
		],
		[
			RealPortal,
			function RadixPopoverSeamPortal(props: PortalProps) {
				return useContext(StubRootContext) ? ((props.children as ReactNode) ?? null) : <RealPortal {...props} />;
			},
		],
		[
			RealContent,
			function RadixPopoverSeamContent(props: ContentProps) {
				return useContext(StubRootContext) ? <div>{props.children as ReactNode}</div> : <RealContent {...props} />;
			},
		],
		[
			RealAnchor,
			function RadixPopoverSeamAnchor(props: AnchorProps) {
				return useContext(StubRootContext) ? null : <RealAnchor {...props} />;
			},
		],
	]);
	// Radix ≥1.3 exports each part under two names bound to ONE local
	// (`PopoverContent as Content`, `PopoverContent`), and bun's in-place slot
	// rewrite goes through that shared binding — a by-name override is undone
	// by whichever alias is written last. Swap every export by identity.
	mock.module("@radix-ui/react-popover", () =>
		Object.fromEntries(Object.entries(realPopover).map(([name, value]) => [name, seamParts.get(value) ?? value])),
	);
}
