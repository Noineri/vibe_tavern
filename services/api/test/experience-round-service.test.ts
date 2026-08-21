/**
 * RM-8: realtime round-commit replay-verification tests.
 *
 * Full path through the REAL DB + REAL session lifecycle + REAL VM: the test
 * produces an HONEST round log by driving the same kernel functions the frame
 * loop host drives (update → legality-checked reduce → cursor draws), in the
 * same order, then commits it. The honest-by-construction log plus targeted
 * tamperings pin the contract: a verified commit applies exactly one terminal
 * `round_commit` transition + the finish-writeback card; a tampered claim,
 * edited log, impossible event order, wrong seed, or non-reproducible model
 * result fails typed 422 `round_verification_failed` with NOTHING applied.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { createDeterministicRandom, type ExperienceAction } from "@vibe-tavern/domain";
import type { ExperienceRoundCommitRequestDto } from "@vibe-tavern/api-contracts";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import {
	createCountingRandom,
	ExperienceService,
	seedToNumeric,
} from "../src/domain/interactive/experience-service.js";
import { ExperienceReportService } from "../src/domain/interactive/experience-report-service.js";
import { ExperienceRoundService } from "../src/domain/interactive/experience-round-service.js";
import {
	runActions,
	runCreate,
	runReduce,
	runUpdate,
	validateSubmittedAction,
} from "../src/domain/interactive/experience-kernel.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A realtime arcade fixture exercising the whole replay surface: update draws
 * from the DETERMINISTIC cursor (replay parity lives or dies here), inputs and
 * a script seat both reduce, a model seat's intent applies verbatim, and a
 * "win" input completes the round mid-log.
 */
const ARCADE_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "arcade", name: "Arcade", mode: "realtime", tickMs: 100 },
  capabilities: [{ capability: "participants" }, { capability: "deterministic_random" }, { capability: "model" }],
  create() { return { t: 0, moves: [], r: 0 }; },
  project(c) { return { t: c.state.t, moves: c.state.moves }; },
  actions(c, viewer) {
    if (viewer && viewer.participantId === "bot") return [{ type: "botstep" }];
    if (viewer && viewer.participantId === "ai") return [{ type: "botstep" }];
    return [{ type: "move" }, { type: "win" }];
  },
  reduce(c, a) {
    const moves = [...c.state.moves, a.type + ":" + String(a.participantId ?? "p")];
    if (a.type === "win") return { state: { ...c.state, moves, won: true }, status: "completed", events: [] };
    return { state: { ...c.state, moves }, status: "active", events: [] };
  },
  update(c, dt) {
    const r = c.random ? c.random.float() : 0;
    return { state: { ...c.state, t: c.state.t + dt, r }, status: "active", events: [] };
  },
});
`;

/** Same package WITHOUT update — a turn package that cannot honestly log ticks. */
const NO_UPDATE_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "plain", name: "Plain" },
  capabilities: [{ capability: "participants" }],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "increment" }]; },
  reduce(c, a) {
    if (a.type === "increment") return { state: { count: c.state.count + 1 }, status: "active", events: [] };
    return { state: c.state, status: "active", events: [] };
  },
});
`;

const PARTICIPANTS = [
	{ id: "human", label: "You", controller: "human" as const },
	{ id: "bot", label: "Bot", controller: "script" as const },
	{ id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp1", modelId: "test-model" },
];
const GRANTS = ["participants", "deterministic_random", "model"];

// ─── Setup ───────────────────────────────────────────────────────────────────

let stores: StoreContainer;
let resources: ExperienceResourceService;
let service: ExperienceService;
let round: ExperienceRoundService;
let sessionSeed: number;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-round-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	resources = new ExperienceResourceService(stores);
	service = new ExperienceService(stores, resources, { generateSeed: () => "seed" });
	round = new ExperienceRoundService(stores, new ExperienceReportService(stores));
	sessionSeed = seedToNumeric("seed");
});

async function seedSession(source: string, participants = PARTICIPANTS, grants: string[] = GRANTS) {
	const character = await stores.characters.create({ name: "Aria", description: "Mage." } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" } as never);
	const branchId = chat.activeBranchId as string;
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source } as never);
	await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: grants as never } as never);
	const started = await service.startSession({ chatId: chat.id, branchId, settings: {}, participants });
	if (!started.ok) throw new Error(`startSession failed: ${started.error.code}`);
	return started.data.sessionId;
}

// ─── Honest-log production (mirrors the frame loop host's execution) ─────────

type LoggedEvent = ExperienceRoundCommitRequestDto["log"][number];

interface RoundScript {
	seed: number;
	state: unknown;
	events: LoggedEvent[];
}

/**
 * Drive the session's rules with the REAL kernel in the frame loop's exact
 * order (update per tick; legality-checked reduce for inputs/script moves)
 * while RECORDING the loop vocabulary — an honest log by construction.
 */
function runHonestRound(
	source: string,
	sessionSeedNumeric: number,
	drive: (ctx: {
		tick: (count: number) => void;
		input: (type: string, participantId?: string) => boolean;
		scriptMove: (participantId: string, type: string) => boolean;
		state: () => unknown;
	}) => void,
): RoundScript {
	const tickMs = 100;
	const script: RoundScript = {
		seed: sessionSeedNumeric,
		state: undefined,
		events: [],
	};
	// create: the SERVER start construction — grant-gated counting random from
	// cursor 0 (grants include participants + deterministic_random + model, so
	// both context fields are present; must reproduce startSession exactly).
	const createRng = createCountingRandom(sessionSeedNumeric, 0);
	const started = runCreate(source, "Rules", {}, {
		participants: PARTICIPANTS,
		random: createRng.random,
	});
	if (!started.ok) throw new Error(`fixture create failed: ${started.message}`);
	script.state = started.value;
	script.events.push({ kind: "round_started", seed: sessionSeedNumeric, settings: null });

	const cursor = createDeterministicRandom(sessionSeedNumeric);
	const tickCaps = { random: cursor, participants: PARTICIPANTS };
	const legalityCaps = { participants: PARTICIPANTS };
	let revision = 0;
	let seq = 0;

	const apply = (action: ExperienceAction): boolean => {
		const legal = runActions(source, "Rules", script.state, viewerFor(action.participantId), legalityCaps);
		if (!legal.ok) throw new Error(`fixture actions failed: ${legal.message}`);
		const check = validateSubmittedAction(action, legal.value);
		if (!check.ok) return false; // dropped, like the live loop
		const reduced = runReduce(source, "Rules", script.state, action, tickCaps);
		if (!reduced.ok) throw new Error(`fixture reduce failed: ${reduced.message}`);
		script.state = reduced.value.state;
		revision += 1;
		return true;
	};

	drive({
		tick: (count) => {
			for (let i = 0; i < count; i++) {
				const transition = runUpdate(source, "Rules", script.state, tickMs, tickCaps);
				if (!transition.ok) throw new Error(`fixture update failed: ${transition.message}`);
				script.state = transition.value.state;
				revision += 1;
			}
			script.events.push({ kind: "ticks", count });
		},
		input: (type, participantId) => {
			seq += 1;
			const action: ExperienceAction = {
				type,
				...(participantId !== undefined ? { participantId } : {}),
				requestId: `loop-${seq}`,
				expectedRevision: revision,
			};
			if (!apply(action)) return false;
			script.events.push({ kind: "input", action });
			return true;
		},
		scriptMove: (participantId, type) => {
			seq += 1;
			const action: ExperienceAction = { type, participantId, requestId: `loop-${seq}`, expectedRevision: revision };
			if (!apply(action)) return false;
			script.events.push({ kind: "script_move", participantId, action });
			return true;
		},
		state: () => script.state,
	});
	script.events.push({ kind: "round_finished", status: "completed" });
	return script;
}

function viewerFor(participantId: string | undefined) {
	if (participantId === "bot") return { kind: "script" as const, participantId: "bot" };
	if (participantId === "ai") return { kind: "model" as const, participantId: "ai" };
	return { kind: "human" as const, participantId: "human" };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("experience round commit (RM-8)", () => {
	test("a verified commit applies one terminal transition + the finish card", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(3);
			ctx.input("move", "human");
			ctx.tick(2);
			ctx.scriptMove("bot", "botstep");
		});
		const claim: ExperienceRoundCommitRequestDto = {
			status: "completed",
			finalState: script.state,
			log: script.events,
			score: 42,
			summary: "A fine round.",
		};
		const committed = await round.commitRound(sessionId, claim);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.data).not.toBeNull();
		const events = committed.data?.publicReport?.events ?? [];
		expect(events.some((e) => e.type === "round_finished")).toBe(true);

		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.status).toBe("completed");
		expect(session?.revision).toBe(1); // exactly ONE terminal transition
		const steps = await stores.experiences.getSteps(sessionId);
		const commitStep = steps.find((s) => s.kind === "round_commit");
		expect(commitStep).toBeDefined();
		expect(commitStep?.stateHash).toMatch(/^[0-9a-f]{64}$/);
		// The verified replayed state is the session's authoritative state.
		expect(JSON.parse(session?.currentStateJson ?? "null")).toEqual(script.state);
	});

	test("a tampered finalState claim is rejected with nothing applied", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(2);
			ctx.input("move", "human");
		});
		const claim: ExperienceRoundCommitRequestDto = {
			status: "completed",
			finalState: { ...script.state, t: 99999 },
			log: script.events,
		};
		const rejected = await round.commitRound(sessionId, claim);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.status).toBe(422);
		expect(rejected.error.code).toBe("round_verification_failed");

		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.status).toBe("active"); // nothing applied
		expect(session?.revision).toBe(0);
		const steps = await stores.experiences.getSteps(sessionId);
		expect(steps.filter((s) => s.kind === "round_commit")).toHaveLength(0);
	});

	test("an edited log (dropped event) diverges and is rejected", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(2);
			ctx.input("move", "human");
			ctx.tick(1);
			ctx.scriptMove("bot", "botstep");
		});
		// Tamper: remove the script_move — the replay reaches a different state.
		const edited = script.events.filter((event) => event.kind !== "script_move");
		const rejected = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: edited,
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
		expect((await stores.experiences.getSessionById(sessionId))?.revision).toBe(0);
	});

	test("an illegal input inside the log is rejected (the loop drops, never logs)", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(1);
		});
		const injected: LoggedEvent = {
			kind: "input",
			action: { type: "definitely_not_legal", requestId: "evil-1", expectedRevision: 1 },
		};
		const rejected = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: [...script.events.slice(0, -1), injected, script.events[script.events.length - 1]!],
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
	});

	test("deterministic cursor draws in update replay identically (seed parity)", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		// r is a cursor draw inside update — any cursor divergence breaks equality.
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(5);
		});
		const state = script.state as { t: number; r: number };
		expect(state.t).toBe(500);
		expect(state.r).toBeGreaterThan(0);
		expect(state.r).toBeLessThan(1);
		const committed = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: script.events,
		});
		expect(committed.ok).toBe(true);
	});

	test("a wrong round seed is rejected (pinned-seed provenance)", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => ctx.tick(1));
		const log = script.events.map((event) =>
			event.kind === "round_started" ? { ...event, seed: sessionSeed + 1 } : event,
		);
		const rejected = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log,
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
		expect(rejected.error.message).toContain("pinned seed");
	});

	test("model results: an intent applies verbatim, a non-intent records only, an unknown seat is rejected", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(1);
		});
		const withModel: LoggedEvent[] = [
			...script.events.slice(0, -1),
			{ kind: "model_request", seatId: "ai", prompt: { viewer: "ai", mode: "action" }, requestId: "rq-1" },
			{ kind: "model_result", seatId: "ai", result: { type: "botstep", payload: { from: "model" } }, requestId: "rq-1" },
			script.events[script.events.length - 1]!,
		];
		// The implied reduce applies a legal intent: derive the expected state.
		const expectedState = runReduce(
			ARCADE_SOURCE,
			"Rules",
			script.state,
			{ type: "botstep", participantId: "ai", payload: { from: "model" }, requestId: "x", expectedRevision: 0 },
			{ random: createDeterministicRandom(sessionSeed), participants: PARTICIPANTS },
		);
		expect(expectedState.ok).toBe(true);
		if (!expectedState.ok) return;
		const committed = await round.commitRound(sessionId, {
			status: "completed",
			finalState: expectedState.value.state,
			log: withModel,
		});
		expect(committed.ok).toBe(true);

		// Non-intent result: recorded, state unchanged.
		const sessionId2 = await seedSession(ARCADE_SOURCE);
		const script2 = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => ctx.tick(1));
		const withText: LoggedEvent[] = [
			...script2.events.slice(0, -1),
			{ kind: "model_result", seatId: "ai", result: "just words, no intent" },
			script2.events[script2.events.length - 1]!,
		];
		const committed2 = await round.commitRound(sessionId2, {
			status: "completed",
			finalState: script2.state,
			log: withText,
		});
		expect(committed2.ok).toBe(true);

		// Unknown seat: the live loop drops at the door — the log is a lie.
		const sessionId3 = await seedSession(ARCADE_SOURCE);
		const script3 = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => ctx.tick(1));
		const rejected = await round.commitRound(sessionId3, {
			status: "completed",
			finalState: script3.state,
			log: [
				...script3.events.slice(0, -1),
				{ kind: "model_result", seatId: "ghost", result: { type: "botstep" } },
				script3.events[script3.events.length - 1]!,
			],
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
	});

	test("a completing input must be followed by round_finished", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(1);
			ctx.input("win", "human"); // completes the round mid-log
		});
		// Tamper: keep playing AFTER the completion (impossible live).
		const tampered: LoggedEvent[] = [
			...script.events.slice(0, -1),
			{ kind: "input", action: { type: "move", participantId: "human", requestId: "z", expectedRevision: 9 } },
			script.events[script.events.length - 1]!,
		];
		const rejected = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: tampered,
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
	});

	test("structural lies: wrong first/last event, status mismatch, duplicate finish", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => ctx.tick(1));

		const noStart = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: [...script.events.slice(1)],
		});
		expect(noStart.ok).toBe(false);

		const noFinish = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: script.events.slice(0, -1),
		});
		expect(noFinish.ok).toBe(false);

		const statusMismatch = await round.commitRound(sessionId, {
			status: "interrupted", // claim disagrees with the log's finish
			finalState: script.state,
			log: script.events,
		});
		expect(statusMismatch.ok).toBe(false);
		if (statusMismatch.ok) return;
		expect(statusMismatch.error.code).toBe("round_verification_failed");

		const doubleFinish: LoggedEvent[] = [
			...script.events,
			{ kind: "round_finished", status: "completed" },
		];
		const rejectedDouble = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: doubleFinish,
		});
		expect(rejectedDouble.ok).toBe(false);
	});

	test("tick bounds: an oversized batch is rejected before any replay work", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => ctx.tick(1));
		const oversized: LoggedEvent[] = [
			...script.events.slice(0, -1),
			{ kind: "ticks", count: 1001 },
			script.events[script.events.length - 1]!,
		];
		const rejected = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: oversized,
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
	});

	test("a package without update cannot honestly log ticks", async () => {
		const sessionId = await seedSession(NO_UPDATE_SOURCE, [
			{ id: "human", label: "You", controller: "human" as const },
		], ["participants"]);
		const claim: ExperienceRoundCommitRequestDto = {
			status: "completed",
			finalState: { count: 0 },
			log: [
				{ kind: "round_started", seed: sessionSeed, settings: null },
				{ kind: "ticks", count: 1 },
				{ kind: "round_finished", status: "completed" },
			],
		};
		const rejected = await round.commitRound(sessionId, claim);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.code).toBe("round_verification_failed");
	});

	test("a finished session cannot commit again; an unknown session 404s", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => ctx.tick(1));
		const first = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: script.events,
		});
		expect(first.ok).toBe(true);
		const second = await round.commitRound(sessionId, {
			status: "completed",
			finalState: script.state,
			log: script.events,
		});
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.code).toBe("session_not_active");

		const missing = await round.commitRound("no-such-session", {
			status: "completed",
			finalState: {},
			log: [
				{ kind: "round_started", seed: sessionSeed, settings: null },
				{ kind: "round_finished", status: "completed" },
			],
		});
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.error.status).toBe(404);
	});

	test("an interrupted claim commits when the log ends interrupted (player abandon)", async () => {
		const sessionId = await seedSession(ARCADE_SOURCE);
		const script = runHonestRound(ARCADE_SOURCE, sessionSeed, (ctx) => {
			ctx.tick(2);
		});
		const interrupted: LoggedEvent[] = [
			...script.events.slice(0, -1),
			{ kind: "round_finished", status: "interrupted" },
		];
		const committed = await round.commitRound(sessionId, {
			status: "interrupted",
			finalState: script.state,
			log: interrupted,
		});
		expect(committed.ok).toBe(true);
		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.status).toBe("interrupted");
	});
});
