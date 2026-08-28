/**
 * Worker-URL resolution pins (prod-build fix, 2026-08-28): Bun.build does not
 * emit `new Worker(new URL(...))` chunks, so the prod factory must point at
 * the fixed asset `assets/kokoro-worker.js` emitted by the worker entrypoint
 * build in `scripts/build-web.ts`; the dev factory keeps loading the raw .ts
 * source served by the Bun HTML dev server. If the prod branch ever regresses
 * to the `new URL(...)` form, the prod app 404s the worker and the Kokoro
 * model download stalls forever — exactly the field bug this fixed.
 *
 * The prod flag is injected as an explicit argument (defaulting to the
 * build-config value at the call site): bun:test's mock.module flattens
 * getter exports, so a mutable isProd seam cannot be mocked reliably — and a
 * pure-argument form needs no mock at all.
 */

import { describe, expect, test } from "bun:test";

import { kokoroWorkerUrl } from "./kokoro-worker-factory.js";

describe("kokoroWorkerUrl", () => {
	test("dev: resolves the raw worker source next to this module", () => {
		const url = kokoroWorkerUrl(false);
		expect(url).toContain("kokoro-worker.ts");
	});

	test("prod: the fixed worker asset + app-version cache-bust", () => {
		const url = kokoroWorkerUrl(true);
		expect(url.startsWith("/assets/kokoro-worker.js?v=")).toBe(true);
		expect(url.length > "/assets/kokoro-worker.js?v=".length).toBe(true); // some version present
	});

	test("prod URL never leaks the dev .ts form", () => {
		expect(kokoroWorkerUrl(true)).not.toContain("kokoro-worker.ts");
	});
});
