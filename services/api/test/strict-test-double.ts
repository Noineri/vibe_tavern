/**
 * THE one strict test-double seam (Wave B step 6 — TYPE_SAFETY_CAST_DEBT_REPORT).
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
 * construction only to HOLD the reference (e.g. ExperienceCopilotAdapter's
 * constructor reads `stores.chatAgentSettings` / `stores.chats` / `stores.db`
 * into closures that the exercised paths never call). Provide those members
 * explicitly as inert doubles (another `strictTestDouble({}, …)`), or the
 * constructor itself will hit the throw.
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
			throw new Error(
				`strictTestDouble(${label}): member '${String(prop)}' was not provided by this test double`,
			);
		},
	});
}
