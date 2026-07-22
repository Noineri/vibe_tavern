/**
 * Characterization tests for the SillyTavern directory scanner's THREE gaps
 * (ST_NATIVE_DIALOG_IMPORT_PLAN Wave 1, STN-1D).
 *
 * Before STN-1D the scanner imported only characters + chats for real. The
 * lorebook section was a LIE: it hit a `// TODO: Store lorebook …` no-op and
 * just incremented a counter. Presets and personas were not scanned at all.
 * These tests pin all three gaps CLOSED by building a real ST folder and
 * proving the artifacts land in the DB after importSillyTavernDirectory:
 *
 *   1. lorebooks (worlds/*.json)  → stores.lorebooks gains a row + entries.
 *   2. presets (OpenAI Settings/) → stores.presets gains a row.
 *   3. personas (settings.json)   → stores.personas gains a row.
 *
 * Also pins:
 *   - scanSillyTavernDirectory reports the right preview counts for ALL surfaces.
 *   - importSillyTavernDirectory is driven through the REAL SessionRuntime
 *     (importExportDeps), which is the path the Wave 3 withTrace wiring fix
 *     guards — so this test also exercises that fix end-to-end.
 *
 * Uses a real SessionRuntime + temp SQLite (same pattern as
 * seed-imported-opening-trace.test.ts). Per AGENTS.md §1 this characterization
 * test was written alongside the gap-closing change.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { STORAGE_FOLDERS } from "@vibe-tavern/db";
import { scanSillyTavernDirectory } from "../src/shared/st-directory-scanner.js";

/**
 * Build a complete-but-minimal ST data dir. Returns its root path.
 * Fixture names use distinctive strings so assertions can find them by name
 * after a full-directory import (the scanner imports EVERYTHING per call, so
 * each gap must be identifiable in the resulting DB rows).
 */
async function buildStDir(root: string) {
	// characters/ — one minimal V2 card (the scanner needs a real card to seed)
	await mkdir(join(root, "characters"), { recursive: true });
	await Bun.write(
		join(root, "characters", "TestChar.json"),
		JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Test Char", description: "probe", first_mes: "Hello." } }),
	);

	// worlds/ — one ST lorebook with one entry (the gap-1 regression target)
	await mkdir(join(root, "worlds"), { recursive: true });
	await Bun.write(
		join(root, "worlds", "TestWorld.json"),
		JSON.stringify({
			name: "Test World",
			entries: {
				"0": {
				 uid: 0, key: ["greeting"], keysecondary: [],
				 content: "Greetings lore entry.", comment: "test",
				 constant: false, vectorized: false, selective: true,
				 selectiveLogic: 0, addMemo: false, order: 100, position: 0,
				 disable: false, excludeRecursion: false, preventRecursion: false,
				 delayUntilRecursion: false, probability: 100, useProbability: true,
				 depth: 4, group: "", groupOverride: false, groupWeight: 100,
				 scanDepth: null, caseSensitive: null, matchWholeWords: null,
				 useGroupScoring: null, automationId: "", role: null, sticky: null,
				 cooldown: null, delay: null, displayIndex: 0,
				},
			},
		}),
	);

	// OpenAI Settings/ — one ST preset (the gap-2 regression target).
	// The scanner derives the preset name from the FILENAME (mirrors the browser
	// flow), so the stored name will be "TestPreset" — not the JSON's `name`.
	await mkdir(join(root, "OpenAI Settings"), { recursive: true });
	await Bun.write(
		join(root, "OpenAI Settings", "TestPreset.json"),
		JSON.stringify({
			name: "Test Preset",
			prompts: [
				{ identifier: "main", name: "Main Prompt", role: "system", content: "You are a test.", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true },
				{ identifier: "jailbreak", name: "Jailbreak", role: "system", content: "Continue.", injection_position: 0, injection_depth: 0, injection_order: 1, enabled: true },
				{ identifier: "customInject", name: "My Injection", role: "system", content: "Custom block.", injection_position: 1, injection_depth: 4, injection_order: 100, enabled: true },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "main", enabled: true, order: 0 },
				{ identifier: "jailbreak", enabled: true, order: 1 },
				{ identifier: "customInject", enabled: true, order: 2 },
			]}],
		}),
	);

	// settings.json — one persona (the gap-3 regression target).
	// parseStPersonas reads personas[key] as the name, so the stored persona
	// name will be "Test User" (the VALUE in the personas map).
	await Bun.write(
		join(root, "settings.json"),
		JSON.stringify({
			power_user: {
				personas: { "default.png": "Test User" },
				persona_descriptions: { "default.png": { description: "A test persona." } },
				default_persona: "default.png",
			},
		}),
	);

	return root;
}

async function createRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-scanner-" + crypto.randomUUID().slice(0, 8));
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

type Env = Awaited<ReturnType<typeof createRuntime>>;

describe("ST directory scanner — three gaps (STN-1D)", () => {
	let env: Env;
	let stDir: string;
	beforeAll(() => setTokenCountFn((text: string) => text.length));
	afterAll(async () => { if (env) await env.cleanup(); });

	it("scan reports lorebook + preset + persona counts (all-surface preview)", async () => {
		env = await createRuntime();
		stDir = await buildStDir(join(env.tmpDir, "st-source"));

		const scan = await env.runtime.scanSillyTavernDirectory(stDir);

		expect(scan.characters.length).toBe(1);
		expect(scan.lorebooks.length).toBe(1);
		expect(scan.lorebooks[0].name).toBe("Test World");
		// gap-2 preview: presets are now scanned
		expect(scan.presets.length).toBe(1);
		// gap-3 preview: persona is now scanned
		expect(scan.persona).not.toBeNull();
		expect(scan.persona!.count).toBe(1);
	});

	it("import WRITES all three surfaces — lorebook (gap-1), preset (gap-2), persona (gap-3)", async () => {
		// Spy on assemblePrompt via the lifecycle deps (same technique as
		// seed-imported-opening-trace.test.ts). The scanner runs through the REAL
		// runtime → importExportDeps → chatLifecycle.seedImportedOpening, so this
		// also pins the withTrace-wiring fix: if the importExportDeps wrapper ever
		// drops the { withTrace: false } option again, assemblePrompt fires and
		// this assertion fails — the 68s/card freeze stays dead.
		const lifecycle = env.runtime.chatLifecycle as unknown as {
			deps: { assemblePrompt: (chatId: unknown, branchId: string) => Promise<unknown> };
		};
		const realAssemble = lifecycle.deps.assemblePrompt;
		let assembleCalls = 0;
		lifecycle.deps.assemblePrompt = mock(async (chatId: unknown, branchId: string) => {
			assembleCalls++;
			return realAssemble(chatId as never, branchId);
		});

		const loreBefore = (await env.stores.lorebooks.listAllLorebooks()).length;
		const presetBefore = (await env.stores.presets.listAll()).length;
		const personaBefore = (await env.stores.personas.listAll()).length;

		// ONE import call drives the whole directory through the real runtime.
		const result = await env.runtime.importSillyTavernDirectory(stDir);

		// Top-line counters must reflect REAL writes, not the old no-op count.
		expect(result.characters).toBe(1);
		expect(result.lorebooks).toBe(1);
		expect(result.presets).toBe(1);
		expect(result.personas).toBe(1);
		expect(result.errors).toEqual([]);

		// withTrace wiring gate: the seeded character greeting must NOT trigger
		// assemblePrompt (the lore-activation engine). If this is > 0, the
		// importExportDeps wrapper is dropping { withTrace: false } again and the
		// mass-import path will freeze on pathological global lorebooks.
		expect(assembleCalls).toBe(0);

		// ── gap-1: lorebook row + entries actually landed ──
		const loreAfter = await env.stores.lorebooks.listAllLorebooks();
		expect(loreAfter.length).toBe(loreBefore + 1);
		const importedLore = loreAfter.find((lb) => lb.name === "Test World");
		expect(importedLore).toBeTruthy();
		const loreEntries = await env.stores.lorebooks.listEntries(importedLore!.id);
		// The old no-op would have left ZERO entries even if it had created the
		// row — this entry-count assertion is the load-bearing regression gate.
		expect(loreEntries.length).toBe(1);
		expect(loreEntries[0].content).toContain("Greetings lore entry.");

		// ── gap-2: preset row + field mapping (browser Phase 3 parity) ──
		const presetAfter = await env.stores.presets.listAll();
		expect(presetAfter.length).toBe(presetBefore + 1);
		// Scanner derives the name from the FILENAME, not the JSON `name` field.
		const importedPreset = presetAfter.find((p) => p.name === "TestPreset");
		expect(importedPreset).toBeTruthy();
		// main → systemPrompt, jailbreak → postHistoryInstructions,
		// customInject → customInjections (the browser Phase 3 mapping).
		expect(importedPreset!.systemPrompt).toContain("You are a test.");
		expect(importedPreset!.postHistoryInstructions).toContain("Continue.");
		expect(importedPreset!.customInjections.some((c) => c.identifier === "customInject" && c.content === "Custom block.")).toBe(true);

		// ── gap-3: persona row landed ──
		const personaAfter = await env.stores.personas.listAll();
		expect(personaAfter.length).toBe(personaBefore + 1);
		const importedPersona = personaAfter.find((p) => p.name === "Test User");
		expect(importedPersona).toBeTruthy();
		expect(importedPersona!.description).toBe("A test persona.");
	});
});

// ── PNG card import: avatar-full wiring + bounded parallelism ──────────────────
//
// The avatar fix that closed STN-1D originally wrote a dead `original.png`
// nobody reads + skipped avatar-full entirely. The follow-up redirected the
// second write to `avatar-full.png` (paired with setFolderAvatarFull) so ST-
// imported cards wire into the existing crop-confirm flow, and added bounded
// concurrency (CHAR_CONCURRENCY=8) + buffer reuse so the 1000+ card case
// doesn't serial-read every PNG twice. These tests pin both behaviors.

/** Minimal PNG chunk: len + type + data + crc(crc left zero — walker skips). */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + 4 + data.length + 4);
	new DataView(out.buffer).setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	return out;
}

/** Synthesize a minimal valid PNG carrying a base64 `chara` tEXt chunk. */
function makeCharaPng(cardName: string): Uint8Array {
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
	const charaText = new TextEncoder().encode(
		"chara\0" + btoa(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: cardName, description: "probe", first_mes: "Hi." } })),
	);
	const text = pngChunk("tEXt", charaText);
	const iend = pngChunk("IEND", new Uint8Array(0));
	const total = sig.length + ihdr.length + text.length + iend.length;
	const out = new Uint8Array(total);
	let o = 0;
	for (const part of [sig, ihdr, text, iend]) { out.set(part, o); o += part.length; }
	return out;
}

/** Build a minimal ST dir containing PNG cards with the given names. */
async function buildStDirWithPngCards(root: string, names: string[]): Promise<void> {
	await mkdir(join(root, "characters"), { recursive: true });
	for (const name of names) {
		await Bun.write(join(root, "characters", `${name}.png`), makeCharaPng(name));
	}
	await mkdir(join(root, "chats"), { recursive: true });
}

describe("ST directory scanner — PNG card avatar-full wiring + parallelism", () => {
	let env: Env;
	beforeAll(() => setTokenCountFn((text: string) => text.length));
	afterAll(async () => { if (env) await env.cleanup(); });

	it("PNG card writes avatar.png + avatar-full.png and sets avatarExt + avatarFullExt", async () => {
		env = await createRuntime();
		const stDir = join(env.tmpDir, "st-png-single");
		await buildStDirWithPngCards(stDir, ["PngChar"]);

		const result = await env.runtime.importSillyTavernDirectory(stDir);

		expect(result.errors).toEqual([]);
		expect(result.characters).toBe(1);

		const chars = await env.stores.characters.listAll();
		const imported = chars.find((c) => c.name === "PngChar");
		expect(imported).toBeTruthy();
		const dir = await env.stores.characters.resolveFolderName(imported!.id);

		// avatarExt + avatarFullExt both set — wires the card into the crop-confirm
		// flow so the user can re-crop the original art later.
		expect(imported!.avatarExt).toBe("png");
		expect(imported!.avatarFullExt).toBe("png");

		// Both files actually land in storage.
		const avatarBytes = await env.stores.content.readBinary(STORAGE_FOLDERS.characters, dir, "avatar.png");
		const avatarFullBytes = await env.stores.content.readBinary(STORAGE_FOLDERS.characters, dir, "avatar-full.png");
		expect(avatarBytes).not.toBeNull();
		expect(avatarFullBytes).not.toBeNull();
		// ST cards are uncropped, so the two files are byte-identical.
		expect(avatarBytes!.length).toBe(avatarFullBytes!.length);

		// REGRESSION GUARD: the dead `original.png` artifact (the pre-fix bug)
		// must NOT be written — nothing reads it.
		const originalBytes = await env.stores.content.readBinary(STORAGE_FOLDERS.characters, dir, "original.png");
		expect(originalBytes).toBeNull();
	});

	it("multiple PNG cards import under bounded concurrency without loss", async () => {
		// Reuse the same env from the single-card test (its runtime is clean for
		// a fresh dir). Build a second dir with 3 distinct cards.
		const stDir = join(env.tmpDir, "st-png-multi");
		const names = ["AlphaCard", "BetaCard", "GammaCard"];
		await buildStDirWithPngCards(stDir, names);

		const charsBefore = (await env.stores.characters.listAll()).length;
		const result = await env.runtime.importSillyTavernDirectory(stDir);

		expect(result.errors).toEqual([]);
		expect(result.characters).toBe(3);

		const charsAfter = await env.stores.characters.listAll();
		expect(charsAfter.length).toBe(charsBefore + 3);

		// Every card got both avatar slots — parallel import must not skip the
		// avatar-full write under concurrency.
		for (const name of names) {
			const c = charsAfter.find((x) => x.name === name);
			expect(c, `character ${name} should exist`).toBeTruthy();
			expect(c!.avatarExt).toBe("png");
			expect(c!.avatarFullExt).toBe("png");
			const cdir = await env.stores.characters.resolveFolderName(c!.id);
			const full = await env.stores.content.readBinary(STORAGE_FOLDERS.characters, cdir, "avatar-full.png");
			expect(full, `avatar-full.png for ${name}`).not.toBeNull();
		}
	});
});

/** A larger ST dir with multiple items per surface, for progress-event tests. */
async function buildStDirMulti(root: string) {
	await mkdir(join(root, "characters"), { recursive: true });
	for (let i = 0; i < 3; i++) {
		await Bun.write(
			join(root, "characters", `Char${i}.json`),
			JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: `Char ${i}`, description: "d", first_mes: "hi" } }),
		);
	}
	await mkdir(join(root, "worlds"), { recursive: true });
	for (let i = 0; i < 2; i++) {
		await Bun.write(
			join(root, "worlds", `World${i}.json`), JSON.stringify({ name: `World ${i}`, entries: {} }));
	}
	await mkdir(join(root, "OpenAI Settings"), { recursive: true });
	await Bun.write(
			join(root, "OpenAI Settings", "Preset0.json"),
			JSON.stringify({ chat_start: "", prompts: [{ identifier: "main", name: "main", content: "sys", role: "system" }], prompt_order: { dummy: { order: [{ identifier: "main" }] } } }),
		);
	return root;
}

describe("ST directory scanner — streaming progress events", () => {
	let env: Env;
	let stDir: string;
	beforeAll(() => setTokenCountFn((text: string) => text.length));
	afterAll(async () => { if (env) await env.cleanup(); });

	it("importSillyTavernDirectoryStream emits phase+progress then done, in order", async () => {
		env = await createRuntime();
		stDir = await buildStDirMulti(join(env.tmpDir, "st-source"));

		const events = [];
		for await (const ev of env.runtime.importSillyTavernDirectoryStream(stDir)) {
			events.push(ev);
		}

		// Terminal event is `done` with the full result, and counts match the fixture.
		const done = events.find((e) => e.type === "done");
		expect(done, "must emit a terminal done event").toBeTruthy();
		if (done!.type !== "done") throw new Error("unreachable");
		expect(done!.result.characters).toBe(3);
		expect(done!.result.lorebooks).toBe(2);
		expect(done!.result.presets).toBe(1);
		expect(done!.result.errors).toEqual([]);

		// Every phase has exactly one `phase` start event, and it precedes that
		// phase's `progress` events. Phases fire in fixed import order.
		const phaseStarts = events.filter((e) => e.type === "phase").map((e) => e.phase);
		expect(phaseStarts).toEqual(["characters", "chats", "lorebooks", "presets", "personas"]);

		// Granular counts: one progress per imported item, current strictly
		// increasing, never exceeding the done count for that surface.
		const progressFor = (phase: string) =>
			events.filter((e) => e.type === "progress" && e.phase === phase).map((e) => e.current);

		const charProg = progressFor("characters");
		expect(charProg).toEqual([1, 2, 3]);
		const loreProg = progressFor("lorebooks");
		expect(loreProg).toEqual([1, 2]);
		const presetProg = progressFor("presets");
		expect(presetProg).toEqual([1]);

		// The `done` event is the LAST event — nothing emitted after the terminal.
		expect(events[events.length - 1]!.type).toBe("done");
		expect(events.some((e) => e.type === "error")).toBe(false);
	});

	it("onProgress omitted (blocking path) still imports correctly", async () => {
		// The default arg-less importSillyTavernDirectory must behave unchanged:
		// no callback, no events, same result. Guards the opts?-optional wiring.
		const env2 = await createRuntime();
		try {
			const dir = await buildStDirMulti(join(env2.tmpDir, "st-source"));
			const result = await env2.runtime.importSillyTavernDirectory(dir);
			expect(result.characters).toBe(3);
			expect(result.lorebooks).toBe(2);
		} finally {
			await env2.cleanup();
		}
	});
});

function scannerCard(name: string): string {
	return JSON.stringify({
		spec: "chara_card_v2",
		spec_version: "2.0",
		data: { name, description: "scanner fixture", first_mes: "Hello." },
	});
}

function scannerChat(name: string): string {
	return [
		JSON.stringify({ character_name: name }),
		JSON.stringify({ name, mes: `Hello from ${name}.` }),
	].join("\n");
}

function scannerPreset(name: string): string {
	return JSON.stringify({
		name,
		prompts: [{ identifier: "main", name: "Main", role: "system", content: "System." }],
	});
}

describe("ST directory scanner — filesystem characterization", () => {
	let scanTmp: string | null = null;
	let scanRoot = "";

	beforeEach(async () => {
		scanTmp = await mkdtemp(join(tmpdir(), "vt-st-scan-"));
		scanRoot = join(scanTmp, "st-data");
		await mkdir(scanRoot);
	});

	afterEach(async () => {
		if (scanTmp !== null) {
			await rm(scanTmp, { recursive: true, force: true });
		}
	});

	it("rejects a missing scan root instead of treating it as an empty SillyTavern directory", async () => {
		await expect(scanSillyTavernDirectory(join(scanRoot, "missing"))).rejects.toThrow("is not a directory");
	});

	it("includes dot-path entries and mixed-case extensions across every preview surface in raw directory-entry order", async () => {
		const charactersDir = join(scanRoot, "characters");
		const chatsDir = join(scanRoot, "chats");
		const worldsDir = join(scanRoot, "worlds");
		const presetsDir = join(scanRoot, "OpenAI Settings");
		await Promise.all([
			mkdir(charactersDir, { recursive: true }),
			mkdir(chatsDir, { recursive: true }),
			mkdir(worldsDir, { recursive: true }),
			mkdir(presetsDir, { recursive: true }),
		]);

		await Bun.write(join(charactersDir, "zeta.JSON"), scannerCard("Zeta"));
		await Bun.write(join(charactersDir, ".hidden.json"), scannerCard("Hidden Character"));
		await Bun.write(join(charactersDir, "Alpha.json"), scannerCard("Alpha"));
		await Bun.write(join(charactersDir, "Avatar.PNG"), makeCharaPng("Avatar"));

		for (const chatDir of ["zeta-chat", ".hidden-chat", "alpha-chat"]) {
			await mkdir(join(chatsDir, chatDir));
			await Bun.write(join(chatsDir, chatDir, "Conversation.JSONL"), scannerChat(chatDir));
		}

		await Bun.write(join(worldsDir, "Zeta.JSON"), JSON.stringify({ name: "Zeta World" }));
		await Bun.write(join(worldsDir, ".hidden.json"), JSON.stringify({ name: "Hidden World" }));
		await Bun.write(join(worldsDir, "Alpha.json"), JSON.stringify({ name: "Alpha World" }));

		await Bun.write(join(presetsDir, "Zeta.JSON"), scannerPreset("Zeta Preset"));
		await Bun.write(join(presetsDir, ".hidden.json"), scannerPreset("Hidden Preset"));
		await Bun.write(join(presetsDir, "Alpha.json"), scannerPreset("Alpha Preset"));
		await Bun.write(join(presetsDir, "not-a-preset.json"), JSON.stringify({ name: "Not a preset" }));
		await Bun.write(join(scanRoot, "settings.json"), JSON.stringify({
			power_user: {
				personas: { "scanner.png": "Scanner Persona" },
				persona_descriptions: { "scanner.png": { description: "Fixture persona." } },
			},
		}));

		const characterEntries = await readdir(charactersDir);
		const chatEntries = await readdir(chatsDir);
		const worldEntries = await readdir(worldsDir);
		const presetEntries = await readdir(presetsDir);

		const scan = await scanSillyTavernDirectory(scanRoot);

		// The current scanner passes through the platform's readdir order; it does
		// not sort. Compare to the same directory entries so this deliberately pins
		// that observable ordering instead of assuming a particular filesystem order.
		expect(scan.characters.map((item) => item.fileName)).toEqual(characterEntries);
		expect(scan.chats.map((item) => item.characterName)).toEqual(chatEntries);
		expect(scan.lorebooks.map((item) => item.fileName)).toEqual(worldEntries);
		expect(scan.presets.map((item) => item.fileName)).toEqual(
			presetEntries.filter((entry) => entry !== "not-a-preset.json"),
		);
		expect(scan.characters.map((item) => item.name)).toEqual(
			expect.arrayContaining(["Alpha", "Avatar", "Hidden Character", "Zeta"]),
		);
		expect(scan.chats).toHaveLength(3);
		expect(scan.lorebooks.map((item) => item.name)).toEqual(
			expect.arrayContaining(["Alpha World", "Hidden World", "Zeta World"]),
		);
		expect(scan.presets.map((item) => item.name)).toEqual(
			expect.arrayContaining(["Alpha Preset", "Hidden Preset", "Zeta Preset"]),
		);
		expect(scan.persona).toEqual({ count: 1, imported: false });
		expect(scan.errors).toEqual([]);
	});

	it("reports malformed character, world, preset, and settings JSON while retaining a malformed chat as a zero-message preview", async () => {
		const charactersDir = join(scanRoot, "characters");
		const chatsDir = join(scanRoot, "chats", "broken-chat");
		const worldsDir = join(scanRoot, "worlds");
		const presetsDir = join(scanRoot, "OpenAI Settings");
		await Promise.all([
			mkdir(charactersDir, { recursive: true }),
			mkdir(chatsDir, { recursive: true }),
			mkdir(worldsDir, { recursive: true }),
			mkdir(presetsDir, { recursive: true }),
		]);
		await Bun.write(join(charactersDir, "broken.json"), "{not-json");
		await Bun.write(join(chatsDir, "broken.JSONL"), "{not-json");
		await Bun.write(join(worldsDir, "broken.json"), "{not-json");
		await Bun.write(join(presetsDir, "broken.json"), "{not-json");
		await Bun.write(join(scanRoot, "settings.json"), "{not-json");

		const scan = await scanSillyTavernDirectory(scanRoot);

		expect(scan.characters).toEqual([]);
		expect(scan.chats).toEqual([
			expect.objectContaining({ characterName: "broken-chat", fileName: "broken.JSONL", messageCount: 0 }),
		]);
		expect(scan.lorebooks).toEqual([]);
		expect(scan.presets).toEqual([]);
		expect(scan.persona).toBeNull();
		expect(scan.errors.map((error) => error.file)).toEqual([
			join(charactersDir, "broken.json"),
			join(worldsDir, "broken.json"),
			join(presetsDir, "broken.json"),
			join(scanRoot, "settings.json"),
		]);
		expect(scan.errors.every((error) => error.stage === "parse")).toBe(true);
	});

	it("follows symlinked directories and files outside the configured root, while dangling links surface as parse errors", async () => {
		const charactersDir = join(scanRoot, "characters");
		const chatsDir = join(scanRoot, "chats");
		if (scanTmp === null) throw new Error("scan fixture root was not created");
		const outsideDir = join(scanTmp, "outside");
		const outsideChatsDir = join(outsideDir, "external-chat");
		await Promise.all([
			mkdir(charactersDir, { recursive: true }),
			mkdir(chatsDir, { recursive: true }),
			mkdir(outsideChatsDir, { recursive: true }),
		]);
		const outsideCard = join(outsideDir, "outside-card.json");
		await Bun.write(outsideCard, scannerCard("Outside Character"));
		await Bun.write(join(outsideChatsDir, "outside.JSONL"), scannerChat("Outside Chat"));

		const escapingCardLink = join(charactersDir, "escaping.JSON");
		const danglingCardLink = join(charactersDir, "dangling.JSON");
		const escapingChatLink = join(chatsDir, "escaping-chat");
		const danglingChatLink = join(chatsDir, "dangling-chat");
		const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
		// Deliberately uncaught: a runner without symlink permission fails this gate.
		symlinkSync(outsideCard, escapingCardLink, "file");
		symlinkSync(join(outsideDir, "missing-card.json"), danglingCardLink, "file");
		symlinkSync(outsideChatsDir, escapingChatLink, directoryLinkType);
		symlinkSync(join(outsideDir, "missing-chat"), danglingChatLink, directoryLinkType);

		expect(relative(scanRoot, outsideCard).startsWith("..")).toBe(true);
		const scan = await scanSillyTavernDirectory(scanRoot);

		// OBSERVED SECURITY DEFECT: current Bun.file().stat/text follows these
		// escaping links, so content outside scanRoot is surfaced by the scanner.
		expect(scan.characters).toEqual([
			expect.objectContaining({ fileName: "escaping.JSON", name: "Outside Character" }),
		]);
		expect(scan.chats).toEqual([
			expect.objectContaining({ characterName: "escaping-chat", fileName: "outside.JSONL", messageCount: 1 }),
		]);
		expect(scan.errors).toEqual([
			expect.objectContaining({ file: danglingCardLink, stage: "parse" }),
		]);
	});
});
