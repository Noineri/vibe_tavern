/**
 * SC-0e — per-kind model binding (`use-agent-model-binding.ts`).
 *
 * Contracts:
 *  - the kind's saved pair (when the profile still exists) wins over the
 *    first-available default;
 *  - mini-app and script choices are independent (a PATCH writes one kind
 *    only; the sibling hook never re-resolves);
 *  - a dangling saved id falls through to the first available profile;
 *  - the host's `defaultModelBinding` is consulted ONLY when the kind has no
 *    usable saved provider (a full saved pair never triggers it);
 *  - a dangling hook proposal is ignored.
 *
 * L1: paths repo-relative; no registry resets (test hosts unsubscribe in
 * `afterAll`); fetch mocked + restored per test; no sleeps (sync cache-path
 * effects); no platform assumptions (no separators/ordering); one
 * `bun test --parallel` file (no ordering assumptions, stores re-seeded in
 * `beforeEach`); assertions pin stable post-effect state.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type { AgentKindSettingsWire } from "@vibe-tavern/api-contracts";
import type { ProviderProfileRecord } from "../../../api/types.js";

import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, renderHook, waitFor } = await import("@testing-library/react");
const { useBootstrapStore } = await import("../../../stores/api-actions/bootstrap-actions.js");
const { useProviderDataStore } = await import("../../../stores/provider-data-store.js");
const { wireUiSettings } = await import("../../../../test/wire-fixtures.js");
const {
	getAgentHost,
	registerAgentHost,
} = await import("../../../lib/agent-host-registry.js");
import type {
	AgentDefaultModelBinding,
	AgentDefaultModelContext,
} from "../../../lib/agent-host-registry.js";
const { useAgentModelBinding } = await import("./use-agent-model-binding.js");

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let capturedCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetch(): void {
	capturedCalls = [];
	globalThis.fetch = Object.assign(
		mock<FetchImplementation>(async (input, init) => {
			const url = input.toString();
			capturedCalls.push({ url, init });
			// Echo the PATCH body back as the updated row (the real server
			// upserts and returns the row; the hook's action merges it).
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				providerProfileId?: string | null;
				modelName?: string | null;
			};
			const kind = url.split("/api/agent/kinds/")[1]?.split("/")[0] ?? "unknown";
			return new Response(
				JSON.stringify({
					agentKind: kind,
					providerProfileId: body.providerProfileId ?? null,
					modelName: body.modelName ?? null,
					defaultProfileId: null,
					updatedAt: "2026-02-02T00:00:00.000Z",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}),
		{ preconnect: originalFetch.preconnect },
	);
}

// Two profiles; each carries one tool-capable cached model so the REAL
// `useProviderModels` hook serves the model list from cache (no fetch).
const PROFILES = [
	{
		id: "p1",
		name: "First",
		cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
	},
	{
		id: "p2",
		name: "Second",
		cachedModels: { models: [{ id: "m2", label: "Model Two", contextLength: 200000, capabilities: { tools: true } }] },
	},
] as unknown as ProviderProfileRecord[];

function kindEntry(kind: string, providerProfileId: string | null, modelName: string | null): AgentKindSettingsWire {
	return { agentKind: kind, providerProfileId, modelName, defaultProfileId: null, updatedAt: "" };
}

function seedStores(map: Record<string, AgentKindSettingsWire>): void {
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: [],
			promptPresets: [],
			uiSettings: wireUiSettings(),
			agentKindSettings: map,
			isArmServer: false,
		},
	});
	useProviderDataStore.setState({ profiles: PROFILES });
}

const experienceOwner: AgentThreadOwner = { kind: "script", scriptId: "s-exp" };
const scriptOwner: AgentThreadOwner = { kind: "script", scriptId: "s-scr" };
const hookOwner: AgentThreadOwner = { kind: "script", scriptId: "s-hook" };

const hookSpy = mock((_ctx: AgentDefaultModelContext): AgentDefaultModelBinding => ({ providerProfileId: "p2", modelName: "m2" }));
let unsubHookHost = (): void => {};
let unsubDanglingHookHost = (): void => {};

beforeAll(async () => {
	// Self-register the built-in script-owned hosts (module init side effect —
	// neither defines `defaultModelBinding` in this unit).
	await import("../../build/editors/copilot/experience-agent-host.js");
	await import("../../build/editors/script-agent-host.js");
	const experienceTransport = getAgentHost("experience").transport;
	unsubHookHost = registerAgentHost({
		kind: "sc0e-hook",
		i18n: {
			title: "agent_title",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		toolKeys: [],
		bufferSpecs: [],
		transport: experienceTransport,
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
		defaultModelBinding: (ctx) => hookSpy(ctx),
	});
	unsubDanglingHookHost = registerAgentHost({
		kind: "sc0e-hook-dangling",
		i18n: {
			title: "agent_title",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		toolKeys: [],
		bufferSpecs: [],
		transport: experienceTransport,
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
		defaultModelBinding: () => ({ providerProfileId: "deleted-profile", modelName: "mX" }),
	});
});

beforeEach(() => {
	installFetch();
	mock.clearAllMocks();
	seedStores({});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	unsubHookHost();
	unsubDanglingHookHost();
	useBootstrapStore.setState({ data: null });
	useProviderDataStore.setState({ profiles: [] });
});

describe("use-agent-model-binding — saved pair and fallback (SC-0e)", () => {
	it("the saved pair wins over the first-available default", () => {
		seedStores({ experience: kindEntry("experience", "p2", "m2") });
		const { result } = renderHook(() => useAgentModelBinding("experience", experienceOwner));
		expect(result.current.providerProfileId).toBe("p2");
		expect(result.current.model).toBe("m2");
	});

	it("no saved pair defaults to the first profile (pre-upgrade behavior)", () => {
		seedStores({});
		const { result } = renderHook(() => useAgentModelBinding("experience", experienceOwner));
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.model).toBe("m1");
	});

	it("a dangling saved id falls through to the first available profile", () => {
		seedStores({ experience: kindEntry("experience", "deleted-profile", "mX") });
		const { result } = renderHook(() => useAgentModelBinding("experience", experienceOwner));
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.model).toBe("m1");
	});

	it("a dangling saved model keeps the saved provider with the first model", () => {
		seedStores({ experience: kindEntry("experience", "p2", "deleted-model") });
		const { result } = renderHook(() => useAgentModelBinding("experience", experienceOwner));
		expect(result.current.providerProfileId).toBe("p2");
		expect(result.current.model).toBe("m2");
	});
});

describe("use-agent-model-binding — independence (SC-0e)", () => {
	it("changing one assistant never changes the other", async () => {
		seedStores({
			experience: kindEntry("experience", "p1", "m1"),
			script: kindEntry("script", "p2", "m2"),
		});
		const exp = renderHook(() => useAgentModelBinding("experience", experienceOwner));
		const scr = renderHook(() => useAgentModelBinding("script", scriptOwner));
		expect(exp.result.current.providerProfileId).toBe("p1");
		expect(scr.result.current.providerProfileId).toBe("p2");

		act(() => {
			exp.result.current.handleProviderChange("p2", "m2");
		});

		// The write is fire-and-forget — wait for the PATCH round-trip to land.
		await waitFor(() => expect(capturedCalls).toHaveLength(1));

		// The PATCH targets the experience kind only, with the kind's field names.
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.url).toContain("/api/agent/kinds/experience/settings");
		expect(JSON.parse(String(capturedCalls[0]?.init?.body))).toEqual({
			providerProfileId: "p2",
			modelName: "m2",
		});
		// The bootstrap map merges the experience row; the script row is untouched.
		const map = useBootstrapStore.getState().data?.agentKindSettings;
		expect(map?.["experience"]).toMatchObject({ providerProfileId: "p2", modelName: "m2" });
		expect(map?.["script"]).toMatchObject({ providerProfileId: "p2", modelName: "m2" });
		// The sibling hook keeps its own choice.
		expect(scr.result.current.providerProfileId).toBe("p2");
		expect(scr.result.current.model).toBe("m2");
	});
});

describe("use-agent-model-binding — descriptor hook (SC-0e)", () => {
	it("the hook default applies when the kind has no saved pair", () => {
		seedStores({});
		const { result } = renderHook(() => useAgentModelBinding("sc0e-hook", hookOwner));
		expect(hookSpy).toHaveBeenCalled();
		expect(result.current.providerProfileId).toBe("p2");
		expect(result.current.model).toBe("m2");
	});

	it("a full saved pair never consults the hook", () => {
		seedStores({ "sc0e-hook": kindEntry("sc0e-hook", "p1", "m1") });
		const { result } = renderHook(() => useAgentModelBinding("sc0e-hook", hookOwner));
		expect(hookSpy).not.toHaveBeenCalled();
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.model).toBe("m1");
	});

	it("a dangling hook proposal falls through to the first available profile", () => {
		seedStores({});
		const { result } = renderHook(() => useAgentModelBinding("sc0e-hook-dangling", hookOwner));
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.model).toBe("m1");
	});
});
