/**
 * CA-7 — Co-Author Apply RPC: proposed draft → character card update.
 *
 * Tests the SessionRuntime.applyCoauthorDraft layer (the route is a 3-line
 * passthrough, like the other co-author endpoints). Pins:
 *   - apply profileMd round-trips: parse → field map → character.update →
 *     response.character carries the edited fields.
 *   - empty name is restored from the current card AND a correction is emitted
 *     (R3 — data-loss guard surfaced, not silently masked).
 *   - a malformed heading (## PERSONALITY) in proposedMd does NOT crash Apply;
 *     the section's content is lost (description empty) — this documents the
 *     pre-CA-17 behavior that the tool-layer guard (CA-17) will later make
 *     impossible, and that the diff (CA-10) surfaces to the user.
 *   - greeting-only apply (firstMessage + alternateGreetings, no profileMd)
 *     updates greetings and leaves profile fields untouched.
 *
 * Modeled on coauthor-chat-api.test.ts' createTestRuntime helper.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { serializeProfileMd } from "@vibe-tavern/db";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";

async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	characterId: string;
	coauthorChatId: ChatId;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-ca7-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "ApplyProbe",
		description: "Original personality.",
		firstMessage: "Original opener.",
	});
	const seedChat = await stores.chats.getById(created.activeChatId);
	const characterId = seedChat!.characterId;
	// A co-author chat is the faithful Apply target (though Apply's soft
	// mode-guard R5 would accept any chat for this character).
	const coChat = await runtime.chatLifecycle.createChatForCharacter(characterId, "coauthor");
	return {
		runtime,
		characterId,
		coauthorChatId: coChat.activeChat.id as ChatId,
		stores,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

describe("Co-Author Apply RPC (CA-7)", () => {
	let env: Awaited<ReturnType<typeof createTestRuntime>>;
	afterAll(async () => { if (env) await env.cleanup(); });

	it("applies a proposed profile.md round-trip onto the character card", async () => {
		env = await createTestRuntime();

		const proposedMd = serializeProfileMd({
			profile: {
				name: "Edited Name",
				tags: ["edited", "probe"],
				creator: null,
				characterVersion: null,
				creatorNotes: "New notes.",
				mesExampleMode: "depth",
				mesExampleDepth: 4,
				description: "Deepened personality prose.",
				scenario: "A tighter scene.",
				mesExample: null,
			},
		});

		const res = await env.runtime.applyCoauthorDraft(env.coauthorChatId, { profileMd: proposedMd });

		// The response carries the updated character (config-patch snapshot).
		expect(res.character).toBeDefined();
		expect(res.character!.name).toBe("Edited Name");
		expect(res.character!.description).toBe("Deepened personality prose.");
		expect(res.character!.scenario).toBe("A tighter scene.");
		expect(res.character!.creatorNotes).toBe("New notes.");
		expect(res.character!.tags).toEqual(["edited", "probe"]);
		// No data-loss guards tripped.
		expect(res.corrections).toEqual([]);
	});

	it("restores an empty name from the card and emits a correction (R3)", async () => {
		// serializeProfileMd accepts name:""; parseProfileMd reads it back as "".
		const proposedMd = serializeProfileMd({
			profile: {
				name: "",
				tags: ["x"],
				creator: null,
				characterVersion: null,
				creatorNotes: null,
				mesExampleMode: "depth",
				mesExampleDepth: 4,
				description: "Some personality.",
				scenario: null,
				mesExample: null,
			},
		});

		const res = await env.runtime.applyCoauthorDraft(env.coauthorChatId, { profileMd: proposedMd });

		// Name was NOT wiped — restored from the existing card.
		expect(res.character!.name).toBe("Edited Name");
		// Other proposed fields still applied.
		expect(res.character!.description).toBe("Some personality.");
		// The user is notified, not silently masked.
		expect(res.corrections.length).toBe(1);
		expect(res.corrections[0].field).toBe("name");
		expect(res.corrections[0].action).toBe("restored");
		expect(res.corrections[0].reason).toContain("Edited Name");
	});

	it("does not crash on a malformed heading; the section content is lost (pre-CA-17)", async () => {
		// A heading-level mismatch (## instead of #) is not recognized by
		// parseProfileMd — the PERSONALITY body is dropped to empty and does
		// NOT survive in unknownSections. This documents the behavior the
		// tool-layer guard (CA-17) will later refuse, and that the diff (CA-10)
		// surfaces. Apply itself cannot distinguish intentional clearing from
		// loss, so it applies the canonical (empty) result without error.
		const malformedMd = [
			"---",
			"name: HeadingProbe",
			"---",
			"## PERSONALITY",
			"Lost content here.",
			"# SCENARIO",
			"A scene.",
			"",
		].join("\n");

		const res = await env.runtime.applyCoauthorDraft(env.coauthorChatId, { profileMd: malformedMd });

		// Name applied (it was in the frontmatter, valid).
		expect(res.character!.name).toBe("HeadingProbe");
		// Description is empty — the malformed heading's content was lost.
		expect(res.character!.description).toBe("");
		// Scenario survived (its heading was canonical).
		expect(res.character!.scenario).toBe("A scene.");
		// No corrections — this loss is NOT one Apply detects (by design).
		expect(res.corrections).toEqual([]);
	});

	it("applies greeting-only edits (firstMessage + alternateGreetings) without profileMd", async () => {
		const res = await env.runtime.applyCoauthorDraft(env.coauthorChatId, {
			firstMessage: "A brand new opener.",
			alternateGreetings: ["Alt greeting one.", "Alt greeting two."],
		});

		expect(res.character!.firstMessage).toBe("A brand new opener.");
		expect(res.character!.alternateGreetings).toEqual(["Alt greeting one.", "Alt greeting two."]);
		// Profile fields untouched (no profileMd in this apply).
		expect(res.character!.name).toBe("HeadingProbe");
		expect(res.corrections).toEqual([]);
	});

	it("throws NotFound for an unknown chat", async () => {
		await expect(
			env.runtime.applyCoauthorDraft("nonexistent-chat" as ChatId, {
				firstMessage: "x",
			}),
		).rejects.toThrow(/Chat.*was not found/);
	});
});
