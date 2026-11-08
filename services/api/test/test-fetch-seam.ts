/**
 * THE one typed test-fetch seam (Wave B step 5 — TYPE_SAFETY_CAST_DEBT_REPORT).
 *
 * Test fetch doubles come in shapes `typeof fetch` rejects: bun's `mock()`
 * wrapper is not a plain `(input, init) => Promise<Response>`, and inline
 * stubs often return `Response` synchronously. Every install therefore used
 * to be erased through `as unknown as typeof fetch` — the exact cast class
 * the type-gate exists to kill. This helper is the single cast-free
 * derivation: its return type IS `typeof fetch`, the async arrow supplies
 * the missing `Promise<...>` wrapper, and the compiler proves the
 * assignability at this one definition site.
 *
 * The returned double also carries the real fetch's `preconnect` (bun's
 * Mock lacks it — both former hand-rolled reattach sites, skill-api's
 * mockFetch and narration-ogg's fetchSpy, fed this precedent into the seam).
 * Reading `globalThis.fetch.preconnect` at INSTALL time is safe even when a
 * previous test left a seam double installed: the double itself carries the
 * same preconnect forward.
 *
 * Usage: `globalThis.fetch = testFetch(impl);` — `impl` may be a bun
 * `mock(...)`: call tracking, `mockClear()` and call-count assertions keep
 * working on the ORIGINAL mock variable; only the install is wrapped (one
 * added microtask per call — waits stay parked-promise/resolved-state,
 * never sleeps). Restore discipline (testing skill R3) is unchanged: every
 * `globalThis.fetch` patch is restored in BOTH `beforeEach` and `afterAll`;
 * this seam installs, it never restores.
 *
 * Import: services/api tests `./test-fetch-seam.js`; apps/web tests via the
 * `@vibe-tavern/test-fetch` paths mapping (apps/web/tsconfig.json) — a
 * relative import from apps/web would reach across workspaces textually,
 * the mapping keeps the graph direction explicit (services/api → apps/web,
 * never the reverse).
 */
export function testFetch(
	impl: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
	return Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => impl(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
}
