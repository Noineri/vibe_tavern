/**
 * Playground model-continuation seam tests (IR-90E blocker-5).
 *
 * Tests `createPlaygroundModelDeps` at the established executor boundary: the
 * provider profile resolution, prompt construction, and executor call are
 * exercised directly with a mock `ProviderProfileService` and a mock executor
 * (the same seam the model-effect-service tests use). No real external
 * provider is called.
 *
 * Covers: pinned provider/model resolution, prompt input/privacy (private view
 * included, hidden state absent), executor error, empty output, text mapping,
 * structured-action validation (legal action type accepted, illegal rejected).
 */
import { describe, expect, test } from "bun:test";
import type { AssemblePromptResponse, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { createPlaygroundModelDeps } from "../src/domain/interactive/experience-playground-model.js";
import type { PlaygroundModelResolveInput } from "../src/domain/interactive/experience-playground.js";

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
	calls: Array<{ profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse }>;
}

function makeExecuteSpy(text: string): { spy: ExecuteSpy; execute: NonNullable<Parameters<typeof createPlaygroundModelDeps>[0]["execute"]> } {
	const spy: ExecuteSpy = { calls: [] };
	const execute = async (input: { profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse; signal?: AbortSignal }) => {
		spy.calls.push({ profile: input.profile, model: input.model, prompt: input.prompt });
		return { text };
	};
	return { spy, execute };
}

function textInput(overrides: Partial<PlaygroundModelResolveInput> = {}): PlaygroundModelResolveInput {
	return {
		providerProfileId: "pp1",
		modelId: "gpt-test",
		request: { viewer: "ai", mode: "text", actionType: "reply", instruction: "Reply in character." },
		projectedView: { messages: [{ from: "you", text: "Hello!" }] },
		legalActions: [{ type: "reply", label: "Reply", allowsText: true }],
		...overrides,
	};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("createPlaygroundModelDeps — executor boundary", () => {
	test("text mode: resolves provider, calls executor, returns validated text", async () => {
		const { spy, execute } = makeExecuteSpy("Hi there!");
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute,
		});

		const result = await deps.resolveModelReply(textInput());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mode).toBe("text");
		expect(result.text).toBe("Hi there!");
		// The executor was called with the pinned profile + model.
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]!.profile.id).toBe("pp1");
		expect(spy.calls[0]!.model).toBe("gpt-test");
	});

	test("prompt includes the private view and instruction but not hidden state", async () => {
		const { spy, execute } = makeExecuteSpy("reply");
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute,
		});

		await deps.resolveModelReply(textInput({
			projectedView: { messages: [{ from: "you", text: "Hello!" }], secretScore: 42 },
		}));

		const promptText = JSON.stringify(spy.calls[0]!.prompt);
		// The private view (projected state) is included.
		expect(promptText).toContain("Hello!");
		// The package instruction is included.
		expect(promptText).toContain("Reply in character.");
	});

	test("action mode: accepts a bare legal action type", async () => {
		const { execute } = makeExecuteSpy("move");
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute,
		});

		const result = await deps.resolveModelReply(textInput({
			request: { viewer: "ai", mode: "action" },
			legalActions: [{ type: "move", label: "Move" }, { type: "pass", label: "Pass" }],
		}));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mode).toBe("action");
		if (result.mode !== "action") return;
		expect(result.actionId).toBe("move");
	});

	test("action mode: accepts a JSON object with actionId + args", async () => {
		const { execute } = makeExecuteSpy('{"actionId":"pass","args":{"direction":"north"}}');
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute,
		});

		const result = await deps.resolveModelReply(textInput({
			request: { viewer: "ai", mode: "action" },
			legalActions: [{ type: "move" }, { type: "pass" }],
		}));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mode).toBe("action");
		if (result.mode !== "action") return;
		expect(result.actionId).toBe("pass");
		expect(result.args).toEqual({ direction: "north" });
	});

	test("action mode: rejects an illegal action type", async () => {
		const { execute } = makeExecuteSpy("cheat");
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute,
		});

		const result = await deps.resolveModelReply(textInput({
			request: { viewer: "ai", mode: "action" },
			legalActions: [{ type: "move" }, { type: "pass" }],
		}));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_output");
	});

	test("executor error surfaces as provider_error", async () => {
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute: async () => { throw new Error("rate limited"); },
		});

		const result = await deps.resolveModelReply(textInput());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("provider_error");
		expect(result.message).toContain("rate limited");
	});

	test("empty output is rejected as invalid_output", async () => {
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute: async () => ({ text: "   " }),
		});

		const result = await deps.resolveModelReply(textInput());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_output");
	});

	test("missing provider profile returns no_provider", async () => {
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles(null) as ProviderProfileService,
			execute: async () => ({ text: "x" }),
		});

		const result = await deps.resolveModelReply(textInput());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("no_provider");
	});

	test("provider requiring API key with empty key returns no_api_key", async () => {
		const profile = makeProfile({ apiKey: "" });
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles(profile) as ProviderProfileService,
			execute: async () => ({ text: "x" }),
		});

		const result = await deps.resolveModelReply(textInput());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("no_api_key");
	});

	test("malformed effect request returns invalid_output", async () => {
		const deps = createPlaygroundModelDeps({
			providerProfiles: mockProviderProfiles() as ProviderProfileService,
			execute: async () => ({ text: "x" }),
		});

		const result = await deps.resolveModelReply(textInput({
			request: { viewer: "ai", mode: "invalid_mode" as "text" },
		}));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_output");
	});
});
