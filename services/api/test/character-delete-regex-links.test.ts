/**
 * R-10 (REGEX_V13_FOLLOWUP) — owner's policy B pinned at the real boundary.
 *
 * CharacterRuntime.delete must clean up regex_links targeting the deleted
 * character (polymorphic target_id has no FK, so cleanup can only be
 * app-level) while the PRESETS themselves survive in the manager for manual
 * rebinding. Before R-10 the links orphaned: after deleting a character, its
 * imported presets kept dead link rows pointing at a character id that no
 * chat could ever resolve again (chats cascade away via the characters FK),
 * and the R-7 bindings UI would have rendered nameless ghost rows.
 *
 * This drives the REAL SessionRuntime (route → sessionRuntime.character.delete
 * → stores.regex.deleteLinksForTarget) on a temp SQLite — same pattern as
 * st-directory-scanner.test.ts, no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { REGEX_PLACEMENT, REGEX_SUBSTITUTE, type CharacterId } from "@vibe-tavern/domain";

let env: Awaited<ReturnType<typeof createEnv>>;

async function createEnv() {
	const tmpDir = resolve(tmpdir(), "vt-r10-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	return {
		runtime,
		stores,
		tmpDir,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

describe("character delete → regex bindings (R-10 policy B)", () => {
	beforeAll(async () => {
		setTokenCountFn((text: string) => text.length);
		env = await createEnv();
	});

	afterAll(async () => { if (env) await env.cleanup(); });

	it("character deletion removes its regex links but keeps the presets (manual rebinding stays possible)", async () => {
		// A character with one bound preset + one preset bound to another character.
		const doomed = await env.stores.characters.create({ name: "Doomed" });
		const other = await env.stores.characters.create({ name: "Other" });

		const presetA = await env.stores.regex.create({
			name: "a-think-strip",
			findRegex: "/<think>[\\s\\S]*?<\\/think>/g",
			replaceString: "",
			trimStrings: [],
			substituteRegex: REGEX_SUBSTITUTE.None,
			disabled: false,
			markdownOnly: false,
			promptOnly: false,
			runOnEdit: true,
			minDepth: null,
			maxDepth: null,
			placement: [REGEX_PLACEMENT.AiOutput],
			isGlobal: false,
			sortOrder: 0,
		});
		const presetB = await env.stores.regex.create({
			name: "b-mood",
			findRegex: "/x/g",
			replaceString: "y",
			trimStrings: [],
			substituteRegex: REGEX_SUBSTITUTE.None,
			disabled: false,
			markdownOnly: false,
			promptOnly: false,
			runOnEdit: true,
			minDepth: null,
			maxDepth: null,
			placement: [REGEX_PLACEMENT.AiOutput],
			isGlobal: false,
			sortOrder: 1,
		});
		await env.stores.regex.addLink(presetA.id, "character", doomed.id);
		await env.stores.regex.addLink(presetB.id, "character", doomed.id);
		await env.stores.regex.addLink(presetB.id, "character", other.id);
		expect(await env.stores.regex.getLinks(presetA.id)).toHaveLength(1);
		expect(await env.stores.regex.getLinks(presetB.id)).toHaveLength(2);

		// The production route path: adapter → sessionRuntime.character.delete.
		await env.runtime.character.delete(doomed.id);

		// Character gone; the OTHER character and every surviving link intact.
		expect(await env.stores.characters.getById(doomed.id as CharacterId)).toBeNull();
		expect(await env.stores.characters.getById(other.id as CharacterId)).toBeTruthy();
		// Policy B core: presets survive deletion of their bound character…
		expect((await env.stores.regex.getById(presetA.id))?.name).toBe("a-think-strip");
		// …their links to the deleted character are gone (no ghost rows for the
		// R-7 bindings UI), and links to other targets survive untouched.
		expect(await env.stores.regex.getLinks(presetA.id)).toEqual([]);
		const linksB = await env.stores.regex.getLinks(presetB.id);
		expect(linksB).toHaveLength(1);
		expect(linksB[0]!.targetId).toBe(other.id);
		// The dead preset can be re-bound by hand (policy B's whole point).
		await env.stores.regex.addLink(presetA.id, "character", other.id);
		expect((await env.stores.regex.getLinks(presetA.id))[0]!.targetId).toBe(other.id);
	});
});
