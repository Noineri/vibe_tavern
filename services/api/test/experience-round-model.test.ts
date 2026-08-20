/**
 * Realtime round-model seam tests (RM-7 / REALTIME_EXPERIENCE_MODE_PLAN).
 *
 * Tests `createRoundModelDeps().run` at the established executor boundary: the
 * provider profile resolution, prompt construction, executor call, and output
 * SHAPE validation are exercised directly with a mock `ProviderProfileService`
 * and a mock executor (the same seam pattern as experience-playground-model.test.ts).
 * No real external provider is called.
 *
 * The deliberate divergence from the playground seam is pinned here: round-model
 * is STATELESS, so action-mode output is validated by SHAPE ONLY (a JSON object
 * `{ actionId, args? }`) — a bare action-type string is REJECTED (no
 * legal-action check exists; the frame reduce + RM-8 replay own legality).
 */
import { describe, expect, test } from "bun:test";
import type { AssemblePromptResponse, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { createRoundModelDeps, type ExperienceRoundModelInput } from "../src/domain/interactive/experience-round-model.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "pp1",
		name: "Test Provider",
		providerPreset: "openai",
		apiKey: "sk-test-key",
		defaultModel: "gpt-test",
		bindPerModel: false,
		contextBudget: 8000,
		...overrides,
	} as StoredProviderProfileRecord;
}

function mockProviderProfiles(profile: StoredProviderProfileRecord | null = makeProfile()): Pick<
	ProviderProfileService,
	"getProviderProfile" | "getProviderModelSettings" | "resolveActiveProviderProfile"
> {
	return {
		getProviderProfile: async (id: string) => (profile !== null && id === profile.id ? profile : null),
		getProviderModelSettings: async () => null,
		resolveActiveProviderProfile: async () => profile,
	};
}

interface ExecuteSpy {
	calls: Array<{ profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse; signal?: AbortSignal }>;
}

function makeExecuteSpy(text: string): { spy: ExecuteSpy; execute: NonNullable<Parameters<typeof createRoundModelDeps>[0]["execute"]> } {
	const spy: ExecuteSpy = { calls: [] };
	const execute = async (input: { profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse; signal?: AbortSignal }) => {
		spy.calls.push({ profile: input.profile, model: input.model, prompt: input.prompt, signal: input.signal });
		return { text };
	};
	return { spy, execute };
}

function input(overrides: Partial<ExperienceRoundModelInput> = {}): ExperienceRoundModelInput {
	return {
		seatId: "ai",
		requestId: "rq-7",
		providerProfileId: "pp1",
		modelId: "gpt-test",
		prompt: { viewer: "ai", mode: "text", instruction: "Reply in character." },
		...overrides,
	};
}

function makeDeps(text: string): { deps: ReturnType<typeof createRoundModelDeps>; spy: ExecuteSpy } {
	const { spy, execute } = makeExecuteSpy(text);
	const deps = createRoundModelDeps({
		providerProfiles: mockProviderProfiles() as ProviderProfileService,
		execute,
	});
	return { deps, spy };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createRoundModelDeps — executor boundary", () => {
	test("text mode: resolves provider, calls executor, returns validated text", async () => {
		const { deps, spy } = makeDeps("  Hello there!  ");
		const result = await deps.run(input());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.seatId).toBe("ai");
		expect(result.data.requestId).toBe("rq-7");
		expect(result.data.result).toBe("Hello there!"); // trimmed
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]!.profile.id).toBe("pp1");
		expect(spy.calls[0]!.model).toBe("gpt-test");
	});

	test("happy path builds a prompt containing the author instruction", async () => {
		const { deps, spy } = makeDeps("hi");
		await deps.run(input());

		const promptText = JSON.stringify(spy.calls[0]!.prompt);
		expect(promptText).toContain("Reply in character.");
	});

	test("forwards the abort signal to the executor", async () => {
		const { deps, spy } = makeDeps("hi");
		const controller = new AbortController();
		await deps.run(input({ signal: controller.signal }));

		expect(spy.calls[0]!.signal).toBe(controller.signal);
	});

	test("action mode: returns the PARSED JSON object as verbatim data", async () => {
		const { deps } = makeDeps('{"actionId":"move","args":{"dx":1}}');
		const result = await deps.run(input({ prompt: { viewer: "ai", mode: "action" } }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.result).toEqual({ actionId: "move", args: { dx: 1 } });
	});

	test("action mode: rejects a bare action-type string (no legal-action check exists)", async () => {
		const { deps } = makeDeps("move");
		const result = await deps.run(input({ prompt: { viewer: "ai", mode: "action" } }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid_output");
		expect(result.error.status).toBe(422);
	});

	test("text mode: empty/whitespace output is invalid_output", async () => {
		const { deps } = makeDeps("   ");
		const result = await deps.run(input());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid_output");
	});

	test("malformed prompt (string, missing viewer, bad mode) is invalid_model_prompt", async () => {
		for (const bad of ["just a string", { mode: "text" }, { viewer: "ai", mode: "explode" }]) {
			const { deps } = makeDeps("x");
			const result = await deps.run(input({ prompt: bad }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("invalid_model_prompt");
		}
	});

	test("missing provider profile is no_provider", async () => {
		const { execute } = makeExecuteSpy("x");
		const deps = createRoundModelDeps({ providerProfiles: mockProviderProfiles(null) as ProviderProfileService, execute });
		const result = await deps.run(input());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("no_provider");
		expect(result.error.status).toBe(422);
	});

	test("API-key-required profile with empty key is no_api_key", async () => {
		const { execute } = makeExecuteSpy("x");
		const deps = createRoundModelDeps({
			providerProfiles: mockProviderProfiles(makeProfile({ apiKey: "" })) as ProviderProfileService,
			execute,
		});
		const result = await deps.run(input());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("no_api_key");
	});

	test("executor throw is provider_error (500), never escapes", async () => {
		const deps = createRoundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute: async () => { throw new Error("rate limited"); },
		});
		const result = await deps.run(input());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("provider_error");
		expect(result.error.status).toBe(500);
		expect(result.error.message).toContain("rate limited");
	});

	test("requestId omitted → response omits it", async () => {
		const { deps } = makeDeps("hi");
		const result = await deps.run(input({ requestId: undefined }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect("requestId" in result.data).toBe(false);
	});
});
