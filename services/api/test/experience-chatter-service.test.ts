/**
 * ExperienceChatterService — AC-2 boundary tests (ASYNC_FLAVOR_CHATTER_PLAN).
 *
 * Boundary under test: the REAL chatter service (marker parse, cache
 * single-attempt semantics, seat-pin model resolution, best-effort
 * degradation) with the provider-profile service and the executor mocked at
 * the same seams the model-effect service tests use (providerProfiles pick +
 * an execute spy). No DB — the cache is in-process by design.
 *
 * Pinned behavior:
 *  1. Static flavor (no marker / malformed marker / extra keys) passes through
 *     byte-identical — full backward compatibility.
 *  2. A valid marker resolves synchronously to `pending`, fires ONE model
 *     attempt per (session, viewer, revision, request), and the cache serves
 *     the terminal view on subsequent calls without re-invoking the model.
 *  3. Revision bump allows a fresh attempt; older entries are evicted.
 *  4. Every failure path (unknown seat, provider throw, empty reply, no
 *     active profile) degrades to `failed` with the author's fallback — never
 *     an exception, never an error surface.
 *  5. Seat pinning follows IR-70E: a pinned participant uses exactly its
 *     pinned provider/model; the prompt is the host chatter protocol.
 */
import { describe, expect, test } from "bun:test";
import type { StoredProviderProfileRecord, AssemblePromptResponse, ExperienceParticipant } from "@vibe-tavern/domain";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ExperienceChatterService, parseChatterMarker } from "../src/domain/interactive/experience-chatter-service.js";

function makeProfile(overrides: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "pp1", name: "Test", providerPreset: "ollama", endpoint: "http://x", apiKey: null,
		defaultModel: "test-model", contextBudget: 8000, pinContextBudget: false, bindPerModel: false,
		modelFreeOnly: false, modelGroupByOwner: false, maxTokens: 4096, temperature: 1, topP: 1, topK: 0,
		minP: 0, topA: 0, typicalP: 1, tfsZ: 1, repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
		dryMultiplier: 0, dryBase: 0, dryAllowedLength: 0, drySequenceBreakers: [], xtcThreshold: 0,
		xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, stopSequences: [],
		logitBias: [], seed: null, reasoningEffort: "medium", showReasoning: false, streamResponse: true,
		customSamplers: false, proxyMode: "off", proxyId: null, isActive: true, visionModel: null,
		createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
		...overrides,
	} as StoredProviderProfileRecord;
}

function pinnedParticipant(id: string): ExperienceParticipant {
	return {
		id,
		label: id,
		controller: "model",
		providerProfileId: "pp1",
		modelId: "pinned-model",
	} as ExperienceParticipant;
}

interface ExecuteSpy {
	calls: Array<{ profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse }>;
}

function makeService(opts: {
	profile?: StoredProviderProfileRecord | null;
	executeReturn?: () => Promise<{ text: string }> | { text: string };
	executeThrows?: boolean;
} = {}) {
	const profile = opts.profile === undefined ? makeProfile() : opts.profile;
	const providerProfiles: Pick<ProviderProfileService, "resolveActiveProviderProfile" | "getProviderProfile" | "getProviderModelSettings"> = {
		resolveActiveProviderProfile: async () => profile,
		getProviderProfile: async (id: string) => (profile !== null && profile.id === id ? profile : null),
		getProviderModelSettings: async () => null,
	};
	const spy: ExecuteSpy = { calls: [] };
	const service = new ExperienceChatterService({
		providerProfiles: providerProfiles as unknown as ProviderProfileService,
		execute: (async (input: { profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse }) => {
			spy.calls.push({ profile: input.profile, model: input.model, prompt: input.prompt });
			if (opts.executeThrows) throw new Error("provider blew up");
			const ret = opts.executeReturn;
			return ret ? await ret() : { text: "A cosmetic line." };
		}) as never,
	});
	return { service, spy };
}

/** Let the fire-and-forget promise land before asserting the terminal view. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

const VIEWER = { kind: "participant" as const, participantId: "you" };
const MARKER = { experienceChatter: { seatId: "ai1", instructions: "react to the last move", fallback: "…" } };
const SEATS = [pinnedParticipant("ai1")];

// ─── Marker parsing ──────────────────────────────────────────────────────────

describe("parseChatterMarker", () => {
	test("parses the sole-key marker into the validated request", () => {
		expect(parseChatterMarker(MARKER)).toEqual({
			seatId: "ai1",
			instructions: "react to the last move",
			fallback: "…",
		});
	});

	test("static flavor shapes return null (pass-through)", () => {
		expect(parseChatterMarker(null)).toBeNull();
		expect(parseChatterMarker("text")).toBeNull();
		expect(parseChatterMarker([1, 2])).toBeNull();
		expect(parseChatterMarker({ hint: "static" })).toBeNull();
		// Extra keys beside the marker = not the chatter shape.
		expect(parseChatterMarker({ experienceChatter: { seatId: "a", instructions: "b" }, extra: 1 })).toBeNull();
	});

	test("a malformed marker value returns null (best-effort passthrough)", () => {
		expect(parseChatterMarker({ experienceChatter: { seatId: "", instructions: "b" } })).toBeNull();
		expect(parseChatterMarker({ experienceChatter: "not an object" })).toBeNull();
	});
});

// ─── Resolution semantics ─────────────────────────────────────────────────────

describe("ExperienceChatterService — resolveChatterFlavor", () => {
	test("static flavor passes through unchanged (no marker)", () => {
		const { service, spy } = makeService();
		const staticFlavor = { hint: "look at the board" };
		expect(service.resolveChatterFlavor("s1", VIEWER, 3, staticFlavor, SEATS)).toBe(staticFlavor);
		expect(spy.calls.length).toBe(0);
	});

	test("malformed marker passes through unchanged as static flavor", () => {
		const { service, spy } = makeService();
		const malformed = { experienceChatter: { seatId: "", instructions: "x" } };
		const out = service.resolveChatterFlavor("s1", VIEWER, 3, malformed, SEATS);
		expect(out).toBe(malformed);
		expect(spy.calls.length).toBe(0);
	});

	test("first call returns pending; after completion the same revision serves resolved without a second call", async () => {
		const { service, spy } = makeService();
		const first = service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		expect(first).toEqual({ status: "pending", seatId: "ai1", fallback: "…" });
		await settle();
		expect(spy.calls.length).toBe(1);

		const second = service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		expect(second).toEqual({ status: "resolved", seatId: "ai1", text: "A cosmetic line." });
		const third = service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		expect(third).toEqual(second);
		expect(spy.calls.length).toBe(1);
	});

	test("a revision bump fires a fresh attempt (author-controlled pace)", async () => {
		const { service, spy } = makeService();
		service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		await settle();
		service.resolveChatterFlavor("s1", VIEWER, 2, MARKER, SEATS);
		await settle();
		expect(spy.calls.length).toBe(2);
	});

	test("different viewers are independent cache lanes", async () => {
		const { service, spy } = makeService();
		const other = { kind: "participant" as const, participantId: "p2" };
		service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		service.resolveChatterFlavor("s1", other, 1, MARKER, SEATS);
		await settle();
		expect(spy.calls.length).toBe(2);
	});

	test("the pinned seat uses exactly its pinned provider/model (IR-70E)", async () => {
		const { service, spy } = makeService();
		service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		await settle();
		expect(spy.calls.length).toBe(1);
		expect(spy.calls[0]!.model).toBe("pinned-model");
		expect(spy.calls[0]!.profile.id).toBe("pp1");
		// The chatter prompt is the minimal host protocol + instructions.
		const messages = (spy.calls[0]!.prompt.finalPayload as { messages: Array<{ role: string; content: string }> }).messages;
		expect(messages.some((m) => m.role === "user" && m.content === "react to the last move")).toBe(true);
	});

	test("a provider throw degrades to failed + fallback (never an exception)", async () => {
		const { service, spy } = makeService({ executeThrows: true });
		service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		await settle();
		expect(spy.calls.length).toBe(1);
		const out = service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		expect(out).toEqual({ status: "failed", seatId: "ai1", fallback: "…" });
	});

	test("an empty model reply degrades to failed + fallback", async () => {
		const { service } = makeService({ executeReturn: () => ({ text: "   " }) });
		service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS);
		await settle();
		expect(service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, SEATS)).toEqual({
			status: "failed",
			seatId: "ai1",
			fallback: "…",
		});
	});

	test("an unknown seat never invokes the model and fails immediately", () => {
		const { service, spy } = makeService();
		const out = service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, []);
		expect(out).toEqual({ status: "failed", seatId: "ai1", fallback: "…" });
		expect(spy.calls.length).toBe(0);
	});

	test("no active profile (legacy seat, no provider) degrades to failed", () => {
		const { service, spy } = makeService({ profile: null });
		const legacySeat = [{ id: "ai1", label: "ai1", controller: "model" } as ExperienceParticipant];
		service.resolveChatterFlavor("s1", VIEWER, 1, MARKER, legacySeat);
		expect(spy.calls.length).toBe(0);
	});
});
