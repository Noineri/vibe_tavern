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
const { useAgentProfileModelStore } = await import("../../../stores/agent-profile-model-store.js");
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

const jsonResponse = (payload: unknown) =>
	new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

// DR-8: the profile own-model rows the in-memory server below serves per
// `${kind}:${profileId}` — seeded per test; absent = no own model.
let profileModelRows: Record<string, { providerProfileId: string; modelName: string | null }> = {};

function installFetch(): void {
	capturedCalls = [];
	globalThis.fetch = Object.assign(
		mock<FetchImplementation>(async (input, init) => {
			const url = input.toString();
			capturedCalls.push({ url, init });
			// DR-8: the own-model family — GET/PUT/DELETE against the in-memory
			// rows; everything else keeps the kind-settings echo below.
			const modelMatch = url.match(/\/api\/agent\/kinds\/([^/]+)\/profiles\/([^/]+)\/model$/);
			if (modelMatch) {
				const key = `${modelMatch[1]}:${modelMatch[2]}`;
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "PUT") {
					const body = JSON.parse(String(init?.body ?? "{}")) as { providerProfileId?: string; modelName?: string | null };
					profileModelRows[key] = { providerProfileId: body.providerProfileId ?? "", modelName: body.modelName ?? null };
					return jsonResponse({ model: profileModelRows[key] });
				}
				if (method === "DELETE") {
					delete profileModelRows[key];
					return jsonResponse({ ok: true });
				}
				return jsonResponse({ model: profileModelRows[key] ?? null });
			}
			// Echo the PATCH body back as the updated row (the real server
			// upserts and returns the row; the hook's action merges it).
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				providerProfileId?: string | null;
				modelName?: string | null;
			};
			const kind = url.split("/api/agent/kinds/")[1]?.split("/")[0] ?? "unknown";
			return jsonResponse({
					agentKind: kind,
					providerProfileId: body.providerProfileId ?? null,
					modelName: body.modelName ?? null,
					defaultProfileId: null,
					updatedAt: "2026-02-02T00:00:00.000Z",
				});
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
	return { agentKind: kind, providerProfileId, modelName, defaultProfileId: null, updatedAt: "", servesChatModes: [], autoCompactDefault: true };
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
// DR-8: the own-model arm's fixture chat-target host + owner.
const DR8_CHAT_KIND = "dr8-chat";
let unsubDr8ChatHost = (): void => {};
const dr8ChatOwner: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "branch-1", agentKind: DR8_CHAT_KIND };

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
			kindLabel: "agent_kind_script",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		// AP-17: required on every descriptor (four keys, tuple-typed).
		starterPromptKeys: [
			"agent_starter_script_explain",
			"agent_starter_script_fix_bugs",
			"agent_starter_script_comment",
			"agent_starter_script_simplify",
		],
		toolKeys: [],
		// SC-0g: both script-owned hosts are `script`-assigned (the field is
		// required on every descriptor).
		profileAssignment: { target: "script" },
		// AP-2: required on every descriptor (a missing markup is a compile break).
		messageMarkup: "plain",
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
			kindLabel: "agent_kind_script",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		// AP-17: required on every descriptor (four keys, tuple-typed).
		starterPromptKeys: [
			"agent_starter_script_explain",
			"agent_starter_script_fix_bugs",
			"agent_starter_script_comment",
			"agent_starter_script_simplify",
		],
		toolKeys: [],
		// SC-0g: both script-owned hosts are `script`-assigned (the field is
		// required on every descriptor).
		profileAssignment: { target: "script" },
		// AP-2: required on every descriptor (a missing markup is a compile break).
		messageMarkup: "plain",
		bufferSpecs: [],
		transport: experienceTransport,
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
		defaultModelBinding: () => ({ providerProfileId: "deleted-profile", modelName: "mX" }),
	});
	// DR-8: the chat-target fixture host (the own-model arm's gate — a
	// script-target host must stay on today's path even when the caller
	// passes an id by mistake). Registered once like the hosts above.
	unsubDr8ChatHost = registerAgentHost({
		kind: DR8_CHAT_KIND,
		i18n: {
			title: "agent_title",
			kindLabel: "agent_kind_sidechat",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		starterPromptKeys: [
			"agent_starter_sidechat_recap",
			"agent_starter_sidechat_feelings",
			"agent_starter_sidechat_twists",
			"agent_starter_sidechat_pacing",
		],
		toolKeys: [],
		profileAssignment: { target: "chat" },
		messageMarkup: "plain",
		bufferSpecs: [],
		transport: experienceTransport,
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
	});
});

beforeEach(() => {
	installFetch();
	mock.clearAllMocks();
	seedStores({});
	profileModelRows = {};
	useAgentProfileModelStore.setState({ models: {} });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	unsubHookHost();
	unsubDanglingHookHost();
	unsubDr8ChatHost();
	useBootstrapStore.setState({ data: null });
	useProviderDataStore.setState({ profiles: [] });
	useAgentProfileModelStore.setState({ models: {} });
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

// ── DR-8 (mockup §11, P5): the effective profile's own model ────────────
// A chat-target host whose effective profile carries an own model: the
// displayed pair IS the own binding (the pills always show the model that
// will answer), a pill change PUTs the profile's model (never the kind
// binding), the caption names the profile. No own model, a dangling own
// provider, or a missing effective-profile id: exactly today's hook.

describe("use-agent-model-binding — the profile's own model (DR-8)", () => {
	it("an own model overrides the displayed pair and raises the caption", async () => {
		profileModelRows[`${DR8_CHAT_KIND}:cprof-1`] = { providerProfileId: "p2", modelName: "m2" };
		const { result } = renderHook(() => useAgentModelBinding(DR8_CHAT_KIND, dr8ChatOwner, "cprof-1"));
		await waitFor(() => expect(result.current.providerProfileId).toBe("p2"));
		expect(result.current.model).toBe("m2");
		expect(result.current.models.map((m) => m.id)).toEqual(["m2"]);
		// The caption is non-null (this file has no i18n provider, so t
		// echoes the key verbatim — the interpolation is pinned in the
		// settings/modal suites).
		expect(result.current.ownModelCaption).toBe("agent_model_profile_caption");
	});

	it("a pill change PUTs the profile's model — never the kind binding", async () => {
		profileModelRows[`${DR8_CHAT_KIND}:cprof-1`] = { providerProfileId: "p2", modelName: "m2" };
		const { result } = renderHook(() => useAgentModelBinding(DR8_CHAT_KIND, dr8ChatOwner, "cprof-1"));
		await waitFor(() => expect(result.current.providerProfileId).toBe("p2"));

		act(() => {
			result.current.handleProviderChange("p1", "m1");
		});

		const put = await waitFor(() => {
			const call = capturedCalls.find(
				(c) => c.url.endsWith("/model") && (c.init?.method ?? "GET").toUpperCase() === "PUT",
			);
			expect(call).toBeDefined();
			return call!;
		});
		expect(put.url).toContain(`/api/agent/kinds/${DR8_CHAT_KIND}/profiles/cprof-1/model`);
		expect(JSON.parse(String(put.init?.body))).toEqual({ providerProfileId: "p1", modelName: "m1" });
		// The kind-binding PATCH never fired, and no kind-settings row exists.
		expect(capturedCalls.some((c) => c.url.includes("/settings"))).toBe(false);
		expect(useBootstrapStore.getState().data?.agentKindSettings?.[DR8_CHAT_KIND]).toBeUndefined();
		// The displayed pair followed the optimistic write in the same frame.
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.model).toBe("m1");
	});

	it("no own model → today's behavior: the kind pair resolves and a pill change PATCHes kind settings", async () => {
		const { result } = renderHook(() => useAgentModelBinding(DR8_CHAT_KIND, dr8ChatOwner, "cprof-1"));
		await waitFor(() => expect(result.current.providerProfileId).toBe("p1"));
		expect(result.current.model).toBe("m1");
		expect(result.current.ownModelCaption).toBeNull();

		act(() => {
			result.current.handleProviderChange("p2", "m2");
		});

		await waitFor(() =>
			expect(capturedCalls.some((c) => c.url.includes(`/api/agent/kinds/${DR8_CHAT_KIND}/settings`))).toBe(true),
		);
	});

	it("a dangling own provider falls through to the kind chain (the server's agent-own-model rule)", async () => {
		profileModelRows[`${DR8_CHAT_KIND}:cprof-1`] = { providerProfileId: "deleted-provider", modelName: "mX" };
		const { result } = renderHook(() => useAgentModelBinding(DR8_CHAT_KIND, dr8ChatOwner, "cprof-1"));
		await waitFor(() => expect(result.current.providerProfileId).toBe("p1"));
		expect(result.current.model).toBe("m1");
		expect(result.current.ownModelCaption).toBeNull();
	});

	it("without the effective-profile id the arm never fires (script-target hosts stay byte-identical)", () => {
		const { result } = renderHook(() => useAgentModelBinding(DR8_CHAT_KIND, dr8ChatOwner));
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.ownModelCaption).toBeNull();
		expect(capturedCalls.some((c) => c.url.includes("/model"))).toBe(false);
	});

	it("a chat-target id passed for a SCRIPT-target host still never fires the arm (the host gate)", () => {
		const { result } = renderHook(() => useAgentModelBinding("experience", experienceOwner, "cprof-1"));
		expect(result.current.providerProfileId).toBe("p1");
		expect(result.current.ownModelCaption).toBeNull();
		expect(capturedCalls.some((c) => c.url.includes("/model"))).toBe(false);
	});
});
