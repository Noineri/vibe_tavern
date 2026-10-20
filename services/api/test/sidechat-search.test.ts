import { describe, test, expect } from "bun:test";
import {
	createContextSearchSession,
	type ContextSearchBranchView,
	type ContextSearchStoreReads,
} from "../src/domain/context/context-search-service.js";
import {
	buildContextSearchStoreReads,
	type ContextSearchStoreReadsSource,
} from "../src/domain/context/context-search-store-reads.js";
import { buildSidechatSearchTools } from "../src/domain/agent/kinds/sidechat/sidechat-search-tools.js";

/**
 * SC-10 — the sidechat's search surface, three layers:
 *
 * 1. The session's `rp-message` channel over a branch view (the SC-2a view
 *    the turn's sync produced): whole-branch indexing (old text outside any
 *    model window stays findable), neighbour reads, cross-branch isolation,
 *    the current-text mark, and the Co-Author shape preserved when no branch
 *    is wired.
 * 2. The ONE extracted store-reads mapping: no Co-Author skill catalog → no
 *    skill records (the sidechat's wiring), catalog wired → the Co-Author's
 *    skill channel unchanged.
 * 3. The tools factory: toggle gating and the Co-Author output shapes (the
 *    shapes SC-13's captions parse through parseAgentToolOutput).
 *
 * The stream-level wiring (served-ness through the REAL buildTools seam, the
 * {{user}}-resolved text, summary-covered finds) lives in
 * sidechat-ooc-stream.test.ts's SC-10 block.
 */

// ─── Fixtures (inline per-file factories — the repo's test contract) ────────

/** A minimal library the session projects (one character, nothing else). */
function makeStores(overrides?: Partial<ContextSearchStoreReads>): ContextSearchStoreReads {
	return {
		listAllCharacters: async () => [
			{ id: "ch_theron", name: "Theron", description: "A brooding ranger.", personalitySummary: null, tags: [] },
		],
		listAllPersonas: async () => [],
		listAllLorebooks: async () => [],
		listEntries: async () => [],
		listAllScripts: async () => [],
		listLorebooksLinkedToTarget: async () => [],
		listScriptsLinkedToTarget: async () => [],
		// The sidechat's wiring passes NO skill catalog — the mapping test below
		// pins that contract; the session here mirrors it (no skill records).
		listSkills: async () => [],
		getCharacter: async (id) =>
			id === "ch_theron"
				? { id: "ch_theron", name: "Theron", description: "A brooding ranger.", personalitySummary: null, tags: [] }
				: null,
		getPersona: async () => null,
		getLorebook: async () => null,
		getEntry: async () => null,
		getScript: async () => null,
		...overrides,
	};
}

const noScope = async () => ({ activeCharacterId: null, activePersonaId: null });

/** A long branch: 12 position-ordered messages, each with a unique keyword —
 *  the fixture for "the model window keeps a suffix; the index keeps the
 *  whole view". */
function longBranchView(): ContextSearchBranchView {
	const messages = Array.from({ length: 12 }, (_, i) => ({
		id: `m_sc10_${i}`,
		position: i,
		role: i % 2 === 0 ? ("assistant" as const) : ("user" as const),
		authorName: i % 2 === 0 ? "Theron" : "Sable",
		text: `SC10-TURN-${i} the story moves on; keyword-well-${i} echoes here.`,
	}));
	return { chatId: "chat_sc10", branchId: "brnch_sc10", messages };
}

function withView(view: ContextSearchBranchView | null) {
	return () => Promise.resolve(view);
}

// ─── 1. The session's rp-message channel ────────────────────────────────────

describe("context-search session: rp-message channel (SC-10)", () => {
	test("a keyword hits an old RP message outside the window — the index is the WHOLE branch view", async () => {
		// The SC-6 budget trim keeps a suffix of the flow (oldest entries drop
		// first); any window over 12 messages excludes the opening turns. The
		// view is the whole branch (SC-2a's contract), so the index still finds
		// message #2 — exactly the old material the search exists for.
		const session = createContextSearchSession(makeStores(), noScope, withView(longBranchView()));
		const results = await session.search("keyword-well-1");
		expect(results.some((r) => r.type === "rp-message" && r.id === "m_sc10_1")).toBe(true);
		const read = await session.read("rp-message", "m_sc10_1");
		expect(read.content).toContain("SC10-TURN-1");
		session.dispose();
	});

	test("reading returns the message plus its immediate neighbours; edges get one side only", async () => {
		const session = createContextSearchSession(makeStores(), noScope, withView(longBranchView()));

		// A middle message: Before + After, in story order, adjacent entries
		// (not position arithmetic — positions can have gaps after deletes).
		const middle = await session.read("rp-message", "m_sc10_5");
		expect(middle.content).toContain("## This message — RP message #6");
		expect(middle.content).toContain("## Before — RP message #5 (assistant — Theron)");
		expect(middle.content).toContain("SC10-TURN-4");
		expect(middle.content).toContain("## After — RP message #7 (assistant — Theron)");
		expect(middle.content).toContain("SC10-TURN-6");
		// The non-adjacent turns do not ride along.
		expect(middle.content).not.toContain("SC10-TURN-0");

		// The first message has no Before; the last has no After.
		const first = await session.read("rp-message", "m_sc10_0");
		expect(first.content).not.toContain("## Before");
		expect(first.content).toContain("## After");
		const last = await session.read("rp-message", "m_sc10_11");
		expect(last.content).toContain("## Before");
		expect(last.content).not.toContain("## After");
		session.dispose();
	});

	test("other branches never match — the session indexes its own view only", async () => {
		const otherBranch: ContextSearchBranchView = {
			chatId: "chat_sc10",
			branchId: "brnch_other",
			messages: [
				{ id: "m_other_0", position: 0, role: "assistant", authorName: "Theron", text: "BRANCHB-ONLY the moonpool shatters." },
			],
		};
		const session = createContextSearchSession(makeStores(), noScope, withView(longBranchView()));
		// The other branch's distinctive keyword finds nothing here…
		const results = await session.search("moonpool");
		expect(results.filter((r) => r.type === "rp-message")).toEqual([]);
		// …and its message id is not readable through this session.
		await expect(session.read("rp-message", "m_other_0")).rejects.toThrow(/not found/);
		// Sanity: the other view's own session DOES find it (the empty result
		// is isolation, not a broken index).
		const other = createContextSearchSession(makeStores(), noScope, withView(otherBranch));
		expect((await other.search("moonpool")).some((r) => r.id === "m_other_0")).toBe(true);
		session.dispose();
		other.dispose();
	});

	test("the read marks RP text as the CURRENT text, not a frozen event", async () => {
		const session = createContextSearchSession(makeStores(), noScope, withView(longBranchView()));
		const read = await session.read("rp-message", "m_sc10_2");
		expect(read.title).toBe("RP message #3");
		expect(read.content).toContain("Current text as the RP model sees it now");
		expect(read.content).toContain("not a frozen event copy");
		session.dispose();
	});

	test("search results carry position/role/author meta and the branch scope", async () => {
		const session = createContextSearchSession(makeStores(), noScope, withView(longBranchView()));
		const results = await session.search("keyword-well-2");
		const hit = results.find((r) => r.type === "rp-message" && r.id === "m_sc10_2")!;
		expect(hit.title).toBe("RP message #3");
		expect(hit.scope).toBe("branch:brnch_sc10");
		expect(hit.meta.role).toBe("assistant");
		expect(hit.meta.author).toBe("Theron");
		expect(hit.meta.position).toBe("2");
		session.dispose();
	});

	test("the branch view resolves once and memoizes; entity reads never touch it", async () => {
		let resolved = 0;
		const session = createContextSearchSession(makeStores(), noScope, async () => {
			resolved += 1;
			return longBranchView();
		});
		// A bare entity read resolves nothing (the Co-Author's lazy-read
		// contract, unchanged).
		await session.read("character", "ch_theron");
		expect(resolved).toBe(0);
		// Two searches + an rp-message read resolve the view exactly once.
		await session.search("keyword-well-3");
		await session.search("keyword-well-4");
		await session.read("rp-message", "m_sc10_0");
		expect(resolved).toBe(1);
		session.dispose();
	});

	test("without a branch view the session keeps the Co-Author's shape — no rp-message hits or reads", async () => {
		const session = createContextSearchSession(makeStores(), noScope);
		const results = await session.search("keyword-well-1");
		expect(results.filter((r) => r.type === "rp-message")).toEqual([]);
		await expect(session.read("rp-message", "m_sc10_1")).rejects.toThrow(/not found/);
		// The entity channel still works (the Co-Author's session, unchanged).
		expect((await session.search("Theron"))[0]!.type).toBe("character");
		session.dispose();
	});
});

// ─── 2. The ONE store-reads mapping ─────────────────────────────────────────

function mappingSource(): ContextSearchStoreReadsSource {
	return {
		characters: {
			listAll: async () => [{ id: "ch_x", name: "X" }],
			getById: async (id: string) => (id === "ch_x" ? { id: "ch_x", name: "X" } : null),
		},
		personas: { listAll: async () => [], getById: async () => null },
		lorebooks: {
			listAllLorebooks: async () => [],
			listEntries: async () => [],
			getLorebook: async () => null,
			getEntry: async () => null,
			listLorebooksLinkedToTarget: async () => [],
		},
		scripts: {
			listAll: async () => [],
			getById: async () => null,
			listScriptsLinkedToTarget: async () => [],
		},
	};
}

describe("buildContextSearchStoreReads (SC-10 extraction — the one mapping)", () => {
	test("without a skill catalog it lists NO skills — the sidechat's session indexes no Co-Author skill records", async () => {
		const reads = buildContextSearchStoreReads(mappingSource());
		expect(await reads.listSkills()).toEqual([]);
		// The store wrappers delegate (spot check: the character bulk read).
		expect((await reads.listAllCharacters()).map((c) => c.id)).toEqual(["ch_x"]);
	});

	test("with a skill catalog it maps the entries — the Co-Author's skill channel, unchanged", async () => {
		const reads = buildContextSearchStoreReads(mappingSource(), async () => [
			{
				id: "card-workshop",
				name: "Character Card Workshop",
				description: "Step-by-step card authoring.",
				rootRelativeManifestPath: "card-workshop/SKILL.md",
				source: "builtin",
				shadowsBuiltin: false,
			},
		]);
		const skills = await reads.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0]).toEqual({
			id: "card-workshop",
			name: "Character Card Workshop",
			description: "Step-by-step card authoring.",
			manifestPath: "card-workshop/SKILL.md",
			source: "builtin",
		});
	});
});

// ─── 3. The tools factory ───────────────────────────────────────────────────

/** A session double the tools tests can drive (the tool layer is the unit). */
function fakeSession(): import("../src/domain/context/context-search-service.js").ContextSearchSession {
	return {
		search: async () => [
			{
				type: "rp-message",
				id: "m_1",
				title: "RP message #2",
				scope: "branch:brnch_1",
				ownerId: null,
				parentId: null,
				meta: { role: "assistant", author: "Theron", position: "1" },
				matchKind: "content",
			},
		],
		read: async (type, id) => ({ type, id, title: "RP message #2", content: "# RP message #2\n…" }),
		dispose: () => {},
	};
}
const fake = fakeSession();

describe("buildSidechatSearchTools (SC-10)", () => {
	test("with both toggles on it serves the pair with the Co-Author output shapes", async () => {
		const tools = buildSidechatSearchTools({
			session: fake,
			toolSet: { search_context: true, read_context_item: true },
		});
		expect(Object.keys(tools).sort()).toEqual(["read_context_item", "search_context"]);

		const searchOut = (await tools.search_context.execute({ query: "lantern" })) as {
			results: Array<Record<string, unknown>>;
		};
		// The Co-Author's search shape: a `results` array of locator metadata
		// rows (what SC-13's captions parse through parseAgentToolOutput).
		expect(Array.isArray(searchOut.results)).toBe(true);
		expect(searchOut.results[0]!.type).toBe("rp-message");
		expect(searchOut.results[0]!.matchKind).toBe("content");

		const readOut = (await tools.read_context_item.execute({ type: "rp-message", id: "m_1" })) as {
			type: string;
			id: string;
			title: string;
			content: string;
		};
		// The Co-Author's read shape: the four canonical-read fields.
		expect(readOut.type).toBe("rp-message");
		expect(readOut.id).toBe("m_1");
		expect(readOut.title).toBe("RP message #2");
		expect(readOut.content).toContain("RP message #2");
	});

	test("toggle gating: off keys are not served — a tool landed with its toggle off is not landed", () => {
		expect(
			Object.keys(
				buildSidechatSearchTools({ session: fake, toolSet: {} }),
			),
		).toEqual([]);
		expect(
			Object.keys(
				buildSidechatSearchTools({ session: fake, toolSet: { search_context: true } }),
			),
		).toEqual(["search_context"]);
		expect(
			Object.keys(
				buildSidechatSearchTools({ session: fake, toolSet: { read_context_item: true } }),
			),
		).toEqual(["read_context_item"]);
	});
});
