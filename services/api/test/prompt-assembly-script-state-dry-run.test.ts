import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { brandId, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { readBranchAsModelSees, type RpBranchViewDeps } from "../src/domain/sidechat/rp-branch-view.js";

/**
 * SC-4c — a read never moves the chat's scripts. `buildPipelineContext`
 * threads the assembly's `dryRun` into the resolver's `executeScripts`; under
 * `dryRun` the script engine still runs (its injections and character-field
 * changes shape the assembled text exactly as on a real turn) but the updated
 * script state is NOT persisted — only a real send/regenerate writes it.
 *
 * Real rows (in-memory-backed store container, real StaticPromptResolver +
 * PromptAssemblyService — the same seam a chat turn goes through). The
 * counter script makes both halves observable at once: it READS state
 * (`context.state.get('turns', 0)`), mutates it (`set`), mutates a character
 * field, and INJECTS the value it read — so the assembled text always shows
 * the stored counter, and the stored counter shows whether anything wrote.
 * Before the fix, every dryRun read bumped the stored counter (a preview
 * advanced scripts as if a turn happened); after it, repeated reads show the
 * same value until a real send bumps it.
 *
 * The counter script is GLOBAL-scoped on purpose: chat-scoped scripts are
 * visible to every chat in the container (the pinned `scopeType = 'chat' OR
 * chatId = :cid` binding shape), and per-chat isolation here comes from the
 * state living on each test's own chat row — every test makes a fresh chat.
 */

let stores: StoreContainer;
let assembly: PromptAssemblyService;
let sidechatDeps: RpBranchViewDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-script-state-dry-run-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const persona = await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer.",
		defaultForNewChats: true,
	});
	expect(persona.name).toBe("Sable");
	const character = await stores.characters.create({ name: "Theron" });
	characterId = character.id;
	const script = await stores.scripts.create({
		name: "counter",
		scriptKind: "prompt",
		scopeType: "global",
		enabled: true,
		code: [
			"const n = context.state.get('turns', 0);",
			"context.state.set('turns', n + 1);",
			"context.character.personality = 'Theron, count: ' + n;",
			"context.chat.injectMessage('[counter] stored turns: ' + n);",
		].join("\n"),
	});
	expect(script.scopeType).toBe("global");
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	sidechatDeps = { chats: stores.chats, messages: stores.messages, assembly };
});

/** A fresh chat with one user message — its `scriptState` starts empty. */
async function makeChat(): Promise<{ chatId: ChatId; branchId: ChatBranchId }> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-4c fixture chat",
		promptPresetId: null,
	});
	const chatId = brandId<ChatId>(chat.id);
	const branchId = brandId<ChatBranchId>(chat.activeBranchId);
	await stores.messages.addMessage({
		chatId,
		branchId,
		role: "user",
		authorType: "user",
		content: "I step inside the tavern.",
	});
	return { chatId, branchId };
}

/** The chat's stored script state, serialized — byte-comparable snapshots. */
async function storedScriptState(chatId: ChatId): Promise<string> {
	const chat = await stores.chats.getById(chatId);
	expect(chat).not.toBeNull();
	return JSON.stringify(chat!.scriptState ?? null);
}

function injectedText(result: Awaited<ReturnType<PromptAssemblyService["assembleForChat"]>>): string[] {
	return result.prompt.scriptInjections.flatMap((run) => run.injectedMessages.map((m) => m.content));
}

describe("read-only assemblies never advance chat scripts (SC-4c)", () => {
	it("a dryRun assembly leaves script state byte-identical while its injection and field change still shape the prompt", async () => {
		const { chatId, branchId } = await makeChat();
		const before = await storedScriptState(chatId);

		const result = await assembly.assembleForChat({ chatId, branchId, model: "", dryRun: true });

		// The script RAN: its injection and its character-field change are in
		// the assembled text exactly as on a real turn.
		expect(injectedText(result)).toEqual(["[counter] stored turns: 0"]);
		const payload = JSON.stringify(result.prompt.finalPayload);
		expect(payload).toContain("[counter] stored turns: 0");
		expect(payload).toContain("Theron, count: 0");

		// But the store never moved — byte-identical script state.
		expect(await storedScriptState(chatId)).toBe(before);
		expect(await storedScriptState(chatId)).toBe("{}");

		// The bug made visible: a SECOND dryRun read reads the same counter
		// (before the fix it had been bumped to 1 by the first read).
		const again = await assembly.assembleForChat({ chatId, branchId, model: "", dryRun: true });
		expect(injectedText(again)).toEqual(["[counter] stored turns: 0"]);
		expect(await storedScriptState(chatId)).toBe("{}");
	});

	it("a sidechat sync read (readBranchAsModelSees) leaves script state identical", async () => {
		const { chatId, branchId } = await makeChat();
		const before = await storedScriptState(chatId);

		// The SC-2a/SC-2c seam the sidechat runs before EVERY sidechat
		// message — a read of the RP branch, never a turn of it.
		const view = await readBranchAsModelSees(sidechatDeps, chatId, branchId);
		expect(view).not.toBeNull();
		expect(view!.messages).toHaveLength(1);

		expect(await storedScriptState(chatId)).toBe(before);
	});

	it("a real send (no dryRun) still writes script state exactly as before", async () => {
		const { chatId, branchId } = await makeChat();

		// First real assembly: the script read 0, injected 0, persisted turns=1.
		const first = await assembly.assembleForChat({ chatId, branchId, model: "" });
		expect(injectedText(first)).toEqual(["[counter] stored turns: 0"]);
		let state = JSON.parse(await storedScriptState(chatId));
		let keys = Object.keys(state);
		expect(keys).toHaveLength(1);
		expect(state[keys[0]!]).toEqual({ turns: 1 });

		// Second real assembly: now reads 1, persists turns=2 — the send path
		// is byte-for-byte the pre-fix behavior.
		const second = await assembly.assembleForChat({ chatId, branchId, model: "" });
		expect(injectedText(second)).toEqual(["[counter] stored turns: 1"]);
		state = JSON.parse(await storedScriptState(chatId));
		keys = Object.keys(state);
		expect(keys).toHaveLength(1);
		expect(state[keys[0]!]).toEqual({ turns: 2 });
	});
});
