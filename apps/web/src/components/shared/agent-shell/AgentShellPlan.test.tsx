/**
 * SC-0i — the agent shell's plan section comes from the host descriptor.
 *
 * Pins, through a full `AgentShell` mount with stub transports:
 *   - a host WITH `planOwner` fetches the script plan route and renders the
 *     plan panel (`agent-plan-panel`) once the plan is non-empty;
 *   - a host WITHOUT `planOwner` (absent = no plan block) performs NO plan
 *     fetch and renders no plan panel, while the chat itself still loads.
 *
 * Harness mirrors ExperienceCopilotShell.test.tsx: fetch-level routing (the
 * real hono clients run against canned payloads — no module-registry
 * touching, so the file coexists with any sibling in one process), an
 * isolated per-render i18next instance (empty resources ⇒ keys verbatim, no
 * process-global i18n — R13), passthrough stubs for Radix Tooltip/Popover
 * content that never mounts under happy-dom, and store resets per test.
 * Both fake hosts are chat-only (no editor pane), registered under unique
 * kinds and unsubscribed in `afterAll` — the documented registry cleanup
 * seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installRadixPopoverSeam } from "../../../../test/radix-popover-seam.js";
import { installToggleSeam } from "../../../../test/toggle-seam.js";
import type { AgentPlan, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";

import { agentFeedPageFromMessages } from "../../../../test/agent-feed-page.js";

useDomEnv();

// The shell reads `useIsMobile` (matchMedia) — fixed desktop here.
const realMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
	...realMobile,
	useIsMobile: () => false,
}));

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shared Toggle wraps Radix Switch (no happy-dom anchor); the Toggle's
// own behaviour is pinned in Toggle.test.tsx — stub to a plain button via the
// shared toggle seam, keeping this suite's own testid (CO-LOAD CONTRACT: the
// seam restores the REAL Toggle for real-arm riders that register it — the
// former inline stub stayed live process-globally in a hand-bundled run).
installToggleSeam({ stub: true, testId: "sc0i-autocompact-toggle" });

// Radix Select.Content / BottomSheet (vaul) do not mount under happy-dom, and
// this test does not drive provider/model selection — render the trigger only.
function FakeToolbarSelect(props: { trigger: ReactElement }) {
	return <>{props.trigger}</>;
}
const realToolbarSelect = await import("../ToolbarSelect.js");
mock.module("../ToolbarSelect.js", () => ({
	...realToolbarSelect,
	ToolbarSelect: FakeToolbarSelect,
}));

// The settings summary is pinned in its own suite — stub it so no settings fetch
// can fire here. SC-13a: the stub exposes the ids it received, so the
// chat-owner test pins the shell's wiring (chatId through, no script id).
const realSettingsModal = await import("./AgentSettingsModal.js");
mock.module("./AgentSettingsModal.js", () => ({
	...realSettingsModal,
	AgentSettingsModal: ({ isOpen, chatId, scriptId }: { isOpen: boolean; chatId?: string; scriptId?: string }) =>
		(isOpen ? <div data-testid="sc0i-settings-modal-stub" data-chat-id={chatId ?? ""} data-script-id={scriptId ?? ""} /> : null),
}));

// Radix Popover.Content never mounts under happy-dom — the shared
// radix-popover seam keeps the switcher's uncontrolled `<Popover.Root>` on
// the deterministic inline stub (the session list stays queryable) while
// every CONTROLLED Root rides the real Radix arm. The former full
// replacement was R4-less (every other export `undefined` for later files in
// a hand-bundled run) and erased real-arm riders' closed-state contract.
installRadixPopoverSeam();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentShell: typeof import("./AgentShell.js").AgentShell;
let registerAgentHost: typeof import("../../../lib/agent-host-registry.js").registerAgentHost;
let scriptOwnerId: typeof import("../../../lib/agent-host-registry.js").scriptOwnerId;
type AgentHostDescriptor = import("../../../lib/agent-host-registry.js").AgentHostDescriptor;
// Transport members the shell never calls in these tests ride the real client
// fns (the registry-mechanics fixture pattern — real signatures keep the
// delegation compiler-checked); every member the mount DOES call is stubbed.
let stubTransport: () => AgentHostDescriptor["transport"];

const PLAN: AgentPlan = {
	goal: "Shell plan",
	constraints: [],
	tasks: [{ id: "task_1", title: "Panel task", body: "", status: "active" }],
};

const THREAD: ExperienceCopilotThreadWire = {
	id: "sc0i-thread",
	scriptId: "sc0i-shell-script",
	draftSessionId: null,
	title: "SC-0i probe",
	archivedAt: null,
	createdAt: "",
	updatedAt: "",
	metrics: null,
	contextLinks: [],
	todo: [],
};

// SC-13a: the chat-owned fixture host — chat-only (no editor pane), no plan
// owner (absent = no plan block, so the bare script hosts' throwing
// `planOwner` seam is never walked), profile choice written to the chat row.
function chatDescriptor(kind: string): AgentHostDescriptor {
	return {
		kind,
		i18n: {
			title: "agent_title",
			kindLabel: "agent_kind_sidechat",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
			emptySub: "agent_subtitle",
		},
		// AP-17: required on every descriptor (exactly four keys — the tuple
		// type makes a wrong count a compile break); the real hosts' values are
		// pinned by agent-host-registry.test.ts.
		starterPromptKeys: [
			"agent_starter_sidechat_recap",
			"agent_starter_sidechat_feelings",
			"agent_starter_sidechat_twists",
			"agent_starter_sidechat_pacing",
		],
		toolKeys: [],
		profileAssignment: { target: "chat" },
		// AP-2: required on every descriptor (a missing markup is a compile break).
		messageMarkup: "plain",
		bufferSpecs: [],
		transport: stubTransport(),
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
	};
}

function descriptor(kind: string, withPlan: boolean): AgentHostDescriptor {
	return {
		kind,
		i18n: {
			title: "agent_title",
			kindLabel: "agent_kind_script",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
			emptySub: "agent_subtitle",
		},
		// AP-17: required on every descriptor (exactly four keys — the tuple
		// type makes a wrong count a compile break); the real hosts' values are
		// pinned by agent-host-registry.test.ts.
		starterPromptKeys: [
			"agent_starter_script_explain",
			"agent_starter_script_fix_bugs",
			"agent_starter_script_comment",
			"agent_starter_script_simplify",
		],
		toolKeys: [],
		profileAssignment: { target: "script" },
		// AP-2: required on every descriptor (a missing markup is a compile break).
		messageMarkup: "plain",
		bufferSpecs: [],
		transport: stubTransport(),
		buildSendOptions: () => ({}),
		// SC-0i: only the plan host derives a plan owner (its script owner);
		// the bare host omits the hook entirely — absent = no plan block.
		...(withPlan
			? { planOwner: (ctx: { owner: Parameters<typeof scriptOwnerId>[0] }) => ({ kind: "script" as const, scriptId: scriptOwnerId(ctx.owner) }) }
			: {}),
		recordProposalRenderers: {},
	};
}

// ── Fetch-level router (canned payloads for the mount's side fetches) ───────
const realFetch = globalThis.fetch;
const planUrls: string[] = [];

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

// DR-7: per-test mutable canned state — the (chat, kind) settings row the
// effective-profile reads resolve, the branch plan payload, and the PATCH
// bodies the hand-off row's write produces.
const EMPTY_PLAN: AgentPlan = { goal: "", constraints: [], tasks: [] };
let dr7ChatProfileId: string | null;
let dr7Plan: AgentPlan;
const dr7ChatSettingsPatches: string[] = [];

const SIDECHAT_PROFILES = {
	profiles: [
		{ id: "builtin", name: "Sidechat OOC", isBuiltIn: true, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc" },
		{ id: "builtin-director", name: "Director", isBuiltIn: true, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc" },
		{ id: "cprof_user", name: "My grim director", isBuiltIn: false, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc" },
		// DR-7b: a user row duplicated from the director — source recorded.
		{ id: "cprof_dup", name: "My director copy", isBuiltIn: false, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc", sourceBuiltinId: "builtin-director" },
	],
};

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const path = new URL(String(input), "http://gateway.test").pathname;
	const method = (init?.method ?? "GET").toUpperCase();
	const feedThreadId = /\/api\/agent\/threads\/([^/]+)\/feed$/.exec(path)?.[1];
	if (method === "GET" && feedThreadId) return jsonResponse(agentFeedPageFromMessages(feedThreadId, []));
	if (method === "GET" && path.includes("/api/scripts/") && path.endsWith("/agent-plan")) {
		planUrls.push(path);
		return jsonResponse({ plan: PLAN });
	}
	if (path.includes("/branches/") && path.endsWith("/plan")) {
		planUrls.push(path);
		return jsonResponse({ plan: dr7Plan });
	}
	// DR-7: the sidechat host's chat-kind routes — the active thread (canned
	// wire), the sessions list, the messages/events reads, the profiles list
	// (the chip's load feeds BOTH parked-choice instances), and the (chat,
	// kind) settings row (GET resolves the effective profile; PATCH is the
	// hand-off row's write, recorded verbatim).
	if (method === "GET" && path.endsWith("/active")) return jsonResponse(THREAD);
	if (method === "GET" && path.endsWith("/sessions")) return jsonResponse([]);
	if (method === "GET" && path.endsWith("/messages")) return jsonResponse([]);
	if (method === "GET" && path.endsWith("/events")) return jsonResponse([]);
	if (method === "GET" && path.includes("/api/copilot/profiles")) return jsonResponse(SIDECHAT_PROFILES);
	if (path.endsWith("/settings")) {
		const chatId = path.split("/")[4] ?? "";
		if (method === "PATCH") {
			dr7ChatSettingsPatches.push(String(init?.body ?? ""));
			const body = JSON.parse(String(init?.body ?? "{}")) as { profileId?: string | null };
			dr7ChatProfileId = body.profileId ?? null;
			return jsonResponse({ chatId, agentKind: "sidechat-ooc", profileId: dr7ChatProfileId, updatedAt: "" });
		}
		return jsonResponse({ chatId, agentKind: "sidechat-ooc", profileId: dr7ChatProfileId, updatedAt: "" });
	}
	if (path.includes("personas") || path.includes("lorebook") || path.endsWith("/api/scripts/all")) return jsonResponse([]);
	if (path.includes("coauthor/skills")) return jsonResponse({ entries: [], errors: [] });
	if (path.includes("experience-copilot") && path.endsWith("/context")) {
		return jsonResponse({ metrics: null, autoCompact: true });
	}
	return jsonResponse({ error: { message: `unrouted ${method} ${path}` } }, 404);
});

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim). No process-global i18n is touched (R13).
function makeIsolatedI18n() {
	const instance = createInstance();
	void instance.init({
		lng: "en",
		fallbackLng: "en",
		resources: {},
		ns: ["translation"],
		defaultNS: "translation",
		keySeparator: false,
		nsSeparator: false,
		interpolation: { prefix: "{", suffix: "}", escapeValue: false },
	});
	return instance;
}

function withIsolatedI18n(node: ReactNode) {
	return <I18nextProvider i18n={makeIsolatedI18n()}>{node}</I18nextProvider>;
}

let unsubs: Array<() => void> = [];

beforeAll(async () => {
	globalThis.fetch = fetchRouter as unknown as typeof globalThis.fetch;
	({ render, fireEvent, waitFor } = await import("@testing-library/react"));
	({ AgentShell } = await import("./AgentShell.js"));
	({ registerAgentHost, scriptOwnerId } = await import("../../../lib/agent-host-registry.js"));
	const experienceApi = await import("../../../api/experience-copilot-api.js");
	// DR-7: the REAL sidechat host registers the kind the empty-state tests
	// mount (its transport + plan owner + meter labels all live there).
	await import("../../chat/sidechat/sidechat-host.js");
	stubTransport = () => ({
		sendStream: experienceApi.streamExperienceCopilot,
		answerAsk: experienceApi.answerCopilotAsk,
		getActiveThread: async () => THREAD,
		listMessages: async (_threadId: string) => [],
		startSession: async () => THREAD,
		listSessions: async () => [],
		activateSession: experienceApi.activateExperienceCopilotSession,
		renameSession: experienceApi.renameExperienceCopilotSession,
		setContextLinks: experienceApi.setExperienceCopilotContextLinks,
		deleteTurn: experienceApi.deleteCopilotTurn,
		editMessage: experienceApi.editCopilotMessage,
	});
	unsubs = [
		registerAgentHost(descriptor("sc0i-plan-host", true)),
		registerAgentHost(descriptor("sc0i-bare-host", false)),
		registerAgentHost(chatDescriptor("sc13a-chat-host")),
	];
});

beforeEach(() => {
	planUrls.length = 0;
	fetchRouter.mockClear();
	dr7ChatProfileId = null;
	dr7Plan = PLAN;
	dr7ChatSettingsPatches.length = 0;
	// DR-7: the chip/shell profile reads ride the shared profile store —
	// start every test empty so the chip's mount load is the only filler.
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false, kind: "experience" });
	useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
	useAgentReviewRoundStore.setState({ roundsByThread: {} });
	useSnapshotStore.setState({ allCharacters: [] });
	useProviderDataStore.setState({ profiles: [] });
	const current = useBootstrapStore.getState().data;
	if (current) {
		useBootstrapStore.setState({ data: { ...current, agentKindSettings: {} } });
	}
});

afterAll(() => {
	globalThis.fetch = realFetch;
	// DR-7: no sidechat profile list leaks to later files sharing the worker.
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false, kind: "experience" });
	for (const unsub of unsubs) unsub();
	unsubs = [];
});

describe("AgentShell plan section from the host (SC-0i)", () => {
	it("a host with planOwner fetches the script plan route and renders the panel", async () => {
		const { getByTestId } = render(
			withIsolatedI18n(
				<AgentShell kind="sc0i-plan-host" owner={{ kind: "script", scriptId: "sc0i-shell-script" }} isMobile={false} />,
			),
		);
		await waitFor(() => expect(getByTestId("agent-plan-panel")).toBeDefined());
		// The hono client prefixes the gateway base ("/null" under tests) —
		// match the route suffix, not the exact string.
		expect(planUrls.some((url) => url.includes("/api/scripts/sc0i-shell-script/agent-plan"))).toBe(true);
	});

	it("a host without planOwner performs no plan fetch and renders no plan block", async () => {
		const { getByTestId, queryByTestId } = render(
			withIsolatedI18n(
				<AgentShell kind="sc0i-bare-host" owner={{ kind: "script", scriptId: "sc0i-shell-script" }} isMobile={false} />,
			),
		);
		// Settle signal: the chat input renders only inside the loaded-session
		// branch (threadId set) — strictly after the mount flush where a plan
		// fetch would have been issued, so the assertions below cannot race
		// it. (The message list carries no testid while empty — it renders a
		// bare EmptyState then — so the input is the stable anchor.)
		await waitFor(() => expect(getByTestId("copilot-chat-input")).toBeDefined());
		expect(planUrls).toHaveLength(0);
		expect(queryByTestId("agent-plan-panel")).toBeNull();
	});
});

// ─── SC-13a: the shell serves a chat-owned host ────────────────────────────

describe("AgentShell chat owner (SC-13a)", () => {
	it("a chat owner mounts without throwing and the settings summary receives the chat id", async () => {
		// Pre-SC-13a this render threw: the shell derived the script id
		// unconditionally (`scriptOwnerId` throws for a chat owner).
		const { getByTestId } = render(
			withIsolatedI18n(
				<AgentShell kind="sc13a-chat-host" owner={{ kind: "chat", chatId: "sc13a-chat", branchId: "branch-1", agentKind: "sc13a-chat" }} isMobile={false} />,
			),
		);
		// Settle signal (same anchor as above): the loaded-session branch.
		await waitFor(() => expect(getByTestId("copilot-chat-input")).toBeDefined());
		// AP-27 was: the gear opened the profile modal; now (mockup §4): the
		// gear opens the settings summary — the stub exposes the ids the
		// shell passed — the chat id rides through, no script id is derived.
		fireEvent.click(getByTestId("copilot-profile-gear-btn"));
		const stub = getByTestId("sc0i-settings-modal-stub");
		expect(stub.getAttribute("data-chat-id")).toBe("sc13a-chat");
		expect(stub.getAttribute("data-script-id")).toBe("");
	});
});

// ─── DR-7: the sidechat empty state is profile-aware ───────────────────────
// The REAL sidechat host mounted on a chat+branch owner (fetch-level canned
// routes — no module mocks); key-echo i18n (provider-less renders echo keys
// by construction, so these pins are co-load safe). The branch plan's EVENTS
// are its tasks (the story-plan sync's projection); the plan route serves
// `dr7Plan` per test.
describe("AgentShell sidechat empty state (DR-7)", () => {
	// Each test mounts under its OWN chat+branch owner: `useAgentPlan`'s
	// cache is module-global and keyed by owner, so a shared key would
	// serve the first test's plan to every later one (loadPlan early-returns
	// once loaded). The router serves any owner path from the same `dr7`
	// canned state.
	function ownerFor(branchId: string) {
		return { kind: "chat" as const, chatId: `dr7-chat-${branchId}`, branchId, agentKind: "sidechat-ooc" };
	}

	function renderSidechat(branchId: string, mobile = false) {
		return render(withIsolatedI18n(<AgentShell kind="sidechat-ooc" owner={ownerFor(branchId)} isMobile={mobile} />));
	}

	it("the director effective: ITS four starters + title/subtitle, no hand-off row", async () => {
		dr7ChatProfileId = "builtin-director";
		dr7Plan = EMPTY_PLAN;
		const { getByTestId, getByText, getAllByText, queryByTestId } = renderSidechat("director");
		// Terminal state: the director's starters replace the host's once the
		// (chat, kind) read + profile list land (before that the fallback
		// renders — the composer alone is not a settle signal).
		await waitFor(() => expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_director_plan"));
		expect(getByTestId("agent-starter-3").textContent).toBe("agent_starter_director_recap");
		// The director's localized name shows in BOTH surfaces that render it
		// here: the empty state's title AND the header chip's label (DR-7's
		// one-derivation name — key echo under the isolated i18n).
		expect(getByTestId("agent-profile-chip").textContent).toBe("agent_profile_name_builtin_director");
		expect(getAllByText("agent_profile_name_builtin_director").length).toBeGreaterThanOrEqual(1);
		expect(getByText("agent_director_empty_sub")).toBeDefined();
		// The hand-off row is «Вне роли»'s — not the director's own.
		expect(queryByTestId("agent-handoff-row")).toBeNull();
	});

	it("the first built-in: its four starters + the hand-off row; the click writes the chat row AND prefills the composer (never sent)", async () => {
		dr7ChatProfileId = null;
		dr7Plan = EMPTY_PLAN;
		const { getByTestId } = renderSidechat("handoff");
		await waitFor(() => expect(getByTestId("copilot-chat-input")).toBeDefined());

		// The independent initial feed read must commit before the empty state.
		// «Вне роли»'s own state is byte-identical plus the accent row.
		await waitFor(() => expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_sidechat_recap"));
		const row = getByTestId("agent-handoff-row");
		expect(row.textContent).toBe("sidechat_director_row");

		fireEvent.click(row);
		// The write is EXACTLY the DR-6 one: PATCH the (chat, kind) row with
		// the director's id.
		await waitFor(() => expect(dr7ChatSettingsPatches.length).toBeGreaterThan(0));
		expect(dr7ChatSettingsPatches.some((body) => body.includes("builtin-director"))).toBe(true);
		// The composer carries the director's first starter (key echo) —
		// prefilled, NOT sent (no stream call fired).
		expect((getByTestId("copilot-chat-input") as HTMLTextAreaElement).value).toBe("agent_starter_director_plan");
		// The write landed locally: the empty state flips to the director's
		// own starters (the same read the shell's instance holds).
		await waitFor(() => expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_director_plan"));
	});

	it("hidden while the branch plan has events (tasks); the host's four starters stay", async () => {
		dr7ChatProfileId = null;
		dr7Plan = PLAN; // one task = one story event
		// DR-9 (P1) moved this pin to MOBILE: the desktop sidechat no longer
		// renders the plan section (the strip, DR-11, becomes its home), so the
		// panel-mounted anchor below lives in the mobile «Сайдчат» pane.
		const { getByTestId, queryByTestId } = renderSidechat("planned", true);
		// Terminal state: the plan PANEL mounts once the branch plan with a
		// task lands — only then is the row's absence stable (before it, the
		// still-empty cache would render the row).
		await waitFor(() => expect(getByTestId("agent-plan-panel")).toBeDefined());
		await waitFor(() => expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_sidechat_recap"));
		expect(queryByTestId("agent-handoff-row")).toBeNull();
		expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_sidechat_recap");
	});

	it("a user profile keeps the host's starters and shows the hand-off row (owner ruling 2026-11-01)", async () => {
		dr7ChatProfileId = "cprof_user";
		dr7Plan = EMPTY_PLAN;
		const { getByTestId } = renderSidechat("user");
		// Terminal state: the chip's label proves the effective read + the
		// profile list landed (the raw wire name — user profiles never
		// localize); the starter fallback alone cannot (it is also the
		// pre-read state).
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("My grim director"));
		await waitFor(() => expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_sidechat_recap"));
		// Behavior change: a user profile HID the row under DR-7 → SHOWS it now
		// (owner ruling 2026-11-01: discovery of the director outranks
		// profile-choice non-nagging). The chip anchor above proves the
		// user-profile read landed, so this pins the post-read state — not the
		// pre-read built-in seed, which showed the row on HEAD too.
		expect(getByTestId("agent-handoff-row").textContent).toBe("sidechat_director_row");
	});

	it("DR-7b: a user DUPLICATE of the director shows the SOURCE's starters with the HOST's title — and the hand-off row (owner ruling 2026-11-01)", async () => {
		dr7ChatProfileId = "cprof_dup";
		dr7Plan = EMPTY_PLAN;
		const { getByTestId, getAllByText, queryByTestId, queryByText } = renderSidechat("dup");
		// Terminal state: the chip proves the effective read landed (the raw
		// wire name — a user profile never localizes, even with a source).
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("My director copy"));
		// STARTERS are the one thing a duplicate inherits: the director's four.
		await waitFor(() => expect(getByTestId("agent-starter-0").textContent).toBe("agent_starter_director_plan"));
		expect(getByTestId("agent-starter-3").textContent).toBe("agent_starter_director_recap");
		expect(queryByTestId("agent-starter-4")).toBeNull();
		// The PRESENTATION stays built-in-only: the host's own title renders
		// (the kind label — its empty-state title), never the director's
		// localized name or its empty-state line.
		expect(getAllByText("agent_kind_sidechat").length).toBeGreaterThanOrEqual(1);
		expect(queryByText("agent_profile_name_builtin_director")).toBeNull();
		expect(queryByText("agent_director_empty_sub")).toBeNull();
		// A user profile offers the OOC hand-off row too — the duplicate is NOT
		// the director itself (its own id differs), so the switch is meaningful
		// (owner ruling 2026-11-01; the DR-7 user-profile hide is dropped).
		expect(getByTestId("agent-handoff-row").textContent).toBe("sidechat_director_row");
	});
});

// ─── DR-9 (P1): the sidechat plan section is desktop-hidden only ───────────
// The REAL sidechat host on a chat+branch owner: the DESKTOP sidechat panel
// drops its plan section (the story plan's desktop home becomes the chat
// column's strip, DR-11); the MOBILE «Сайдчат» pane keeps it (mockup §9 —
// the phone's strip lives in the «Чат» pane). Script hosts keep their
// section on both viewports (pinned by the SC-0i describe above).
describe("AgentShell sidechat plan section (DR-9 P1)", () => {
	// Same shape as the DR-7 suite's ownerFor — local so this describe stands
	// alone (per-test owners: `useAgentPlan`'s cache is keyed by owner).
	function p1Owner(branchId: string) {
		return { kind: "chat" as const, chatId: `dr7-chat-${branchId}`, branchId, agentKind: "sidechat-ooc" };
	}

	it("hidden on desktop, kept on mobile — same host, same plan", async () => {
		dr7ChatProfileId = null;
		dr7Plan = PLAN; // one task = one story event (the plan is fetched on both)

		const desktop = render(withIsolatedI18n(<AgentShell kind="sidechat-ooc" owner={p1Owner("p1-desktop")} isMobile={false} />));
		// Settle: the loaded-session branch (the input) plus the plan GET
		// having been issued; the desktop pane's absence is prop-gated (the
		// section is unmounted), so it cannot race the fetch.
		await waitFor(() => expect(desktop.getByTestId("copilot-chat-input")).toBeDefined());
		await waitFor(() => expect(planUrls.some((url) => url.includes("dr7-chat-p1-desktop"))).toBe(true));
		expect(desktop.queryByTestId("agent-plan-panel")).toBeNull();
		desktop.unmount();

		const mobile = render(withIsolatedI18n(<AgentShell kind="sidechat-ooc" owner={p1Owner("p1-mobile")} isMobile />));
		// Terminal state: the panel mounts once the branch plan lands.
		await waitFor(() => expect(mobile.getByTestId("agent-plan-panel")).toBeDefined());
		mobile.unmount();
	});
});
