import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createDebugRoutes } from "../src/api/routes/debug.js";
import type { BootstrapRuntimeApi } from "../src/api/contract/runtime-api.js";

// The defaults endpoint under test never touches the runtime; reject loudly
// if a future change routes the test through it.
const runtime: BootstrapRuntimeApi = {
	bootstrap: () => Promise.reject(new Error("bootstrap is not used by this test")),
};

function app(): Hono {
	return createDebugRoutes(runtime);
}

// The mode query param is user input: it validates against the contract's
// mode enum and falls back to the documented default ("lore_entry"). Before
// the fix the raw string rode into the mode lookup unvalidated (an erasure
// cast at the call) and an unknown mode 500ed ("Unknown AI assistant mode")
// — the pinned contract below is the post-fix behavior.
describe("GET /api/defaults/ai-assistant-prompt", () => {
	test("absent mode serves the documented lore_entry default", async () => {
		const res = await app().request("/api/defaults/ai-assistant-prompt");
		expect(res.status).toBe(200);
		const explicit = await app().request("/api/defaults/ai-assistant-prompt?mode=lore_entry");
		expect(explicit.status).toBe(200);
		expect(await res.text()).toBe(await explicit.text());
	});

	test("unknown mode falls back to the lore_entry default (200, not the old 500)", async () => {
		const res = await app().request("/api/defaults/ai-assistant-prompt?mode=definitely_not_a_mode");
		expect(res.status).toBe(200);
		const baseline = await app().request("/api/defaults/ai-assistant-prompt?mode=lore_entry");
		expect(await res.text()).toBe(await baseline.text());
	});

	test("a valid non-default mode selects its own prompt", async () => {
		const res = await app().request("/api/defaults/ai-assistant-prompt?mode=skill");
		expect(res.status).toBe(200);
		const loreEntry = await app().request("/api/defaults/ai-assistant-prompt?mode=lore_entry");
		expect(await res.text()).not.toBe(await loreEntry.text());
	});
});
