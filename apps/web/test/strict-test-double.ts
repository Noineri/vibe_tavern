/**
 * fork #1 of services/api/test/strict-test-double.ts — the web-side twin of
 * THE one strict test-double seam (Wave B step 7a — TYPE_SAFETY_CAST_DEBT_REPORT).
 *
 * apps/web cannot import services/api code, so the seam is a genuine fork of
 * that file, kept semantically identical (the Proxy, the labeled miss error,
 * the `then`-undefined exception, PartialMembers). Web store / props fixtures
 * that cannot be completed as literals reach their consumer through this
 * double instead of `as unknown as Store`.
 *
 * Collocated src tests already import helpers from apps/web/test/ (the
 * dom-env precedent), so this location is layer-legal. Web-side wire-record
 * factories live beside it in apps/web/test/wire-fixtures.ts.
 *
 * ── everything below mirrors the source file; see its header for the full
 *    rationale (why the erasure was a defect and why the one plain cast is
 *    legitimate here) ──
 *
 * A partial DI fixture used to reach its consumer through `as unknown as
 * Store` — the DK-9 erasure class: the cast hid BOTH (a) which members the
 * fixture actually provides and (b) missing required fields inside the
 * provided members. This seam replaces the erasure: the fixture is typed as
 * {@link PartialMembers} (each provided member checked against the REAL
 * member type, container members accepted as partials), the return type is
 * the consumer's real type, and every member the fixture did NOT provide
 * THROWS on access — a loud, labeled "this double was not wired for that"
 * instead of `undefined` reads and `TypeError: x.y is not a function` far
 * from the cause.
 *
 * The one non-erasure cast (`provided as T`) lives here, at this single
 * definition site, and is backed by a runtime invariant the type system
 * cannot express: the proxy makes every unprovided member a thrower, so the
 * returned value genuinely behaves as a `T` for the paths the fixture wires.
 * Consumers therefore cast nothing.
 *
 * Construction-time reference reads: some consumers read a member eagerly at
 * construction only to HOLD the reference. Provide those members explicitly
 * as inert doubles (another `strictTestDouble({}, …)`), or the constructor
 * itself will hit the throw.
 *
 * Semantics kept identical to the erased literals on every green path: a
 * provided member behaves exactly as written; an unprovided member failed at
 * runtime before, too (as `TypeError` at the call site).
 */
export type PartialMembers<T> = {
	[K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : Partial<T[K]>;
};

export function strictTestDouble<T extends object>(provided: PartialMembers<T>, label: string): T {
	return new Proxy(provided as T, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			// Promise-adoption probes `.then` on EVERY object an async function
			// returns — a plain object answers `undefined` (not a thenable), and
			// the double must answer the same way or `return strictTestDouble(…)`
			// inside an async factory rejects with this file's own miss error.
			// No consumer ever awaits a member named `then` on a store double.
			if (prop === "then") return undefined;
			// Same plain-object probe class, symbol flavor (7b): React/happy-dom
			// read `Symbol.toStringTag` off props objects during reconciliation —
			// a plain object answers undefined there (its tag resolves off the
			// prototype), so the double must answer the same.
			if (prop === Symbol.toStringTag) return undefined;
			throw new Error(
				`strictTestDouble(${label}): member '${String(prop)}' was not provided by this test double`,
			);
		},
	});
}
