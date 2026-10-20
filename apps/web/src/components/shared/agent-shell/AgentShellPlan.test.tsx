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
import type { AgentPlan, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";

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
// own behaviour is pinned in Toggle.test.tsx — stub to a plain button.
const realToggle = await import("../Toggle.js");
mock.module("../Toggle.js", () => ({
	...realToggle,
	Toggle: ({
		checked,
		onChange,
	}: {
		checked: boolean;
		onChange: (v: boolean) => void;
	}) => (
		<button
			type="button"
			data-testid="sc0i-autocompact-toggle"
			data-checked={checked ? "true" : "false"}
			onClick={() => onChange(!checked)}
		/>
	),
}));

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

// The profile modal is pinned in its own suite — stub it so no profile fetch
// can fire here. SC-13a: the stub exposes the ids it received, so the
// chat-owner test pins the shell's wiring (chatId through, no script id).
const realProfileModal = await import("./AgentProfileModal.js");
mock.module("./AgentProfileModal.js", () => ({
	...realProfileModal,
	AgentProfileModal: ({ isOpen, chatId, scriptId }: { isOpen: boolean; chatId?: string; scriptId?: string }) =>
		(isOpen ? <div data-testid="sc0i-profile-modal-stub" data-chat-id={chatId ?? ""} data-script-id={scriptId ?? ""} /> : null),
}));

// Radix Popover.Content never mounts under happy-dom — render it inline so
// the session switcher mounts without throwing.
mock.module("@radix-ui/react-popover", () => ({
	Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
	Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
	Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
	Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Anchor: () => null,
}));

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
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
			emptySub: "agent_subtitle",
		},
		toolKeys: [],
		profileAssignment: { target: "chat" },
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
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
			emptySub: "agent_subtitle",
		},
		toolKeys: [],
		profileAssignment: { target: "script" },
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

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const path = new URL(String(input), "http://gateway.test").pathname;
	const method = (init?.method ?? "GET").toUpperCase();
	if (method === "GET" && path.includes("/api/scripts/") && path.endsWith("/agent-plan")) {
		planUrls.push(path);
		return jsonResponse({ plan: PLAN });
	}
	if (path.includes("/branches/") && path.endsWith("/plan")) {
		planUrls.push(path);
		return jsonResponse({ plan: PLAN });
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
	it("a chat owner mounts without throwing and the profile modal receives the chat id", async () => {
		// Pre-SC-13a this render threw: the shell derived the script id
		// unconditionally (`scriptOwnerId` throws for a chat owner).
		const { getByTestId } = render(
			withIsolatedI18n(
				<AgentShell kind="sc13a-chat-host" owner={{ kind: "chat", chatId: "sc13a-chat", branchId: "branch-1", agentKind: "sc13a-chat" }} isMobile={false} />,
			),
		);
		// Settle signal (same anchor as above): the loaded-session branch.
		await waitFor(() => expect(getByTestId("copilot-chat-input")).toBeDefined());
		// The gear opens the profile modal; the stub exposes the ids the
		// shell passed — the chat id rides through, no script id is derived.
		fireEvent.click(getByTestId("copilot-profile-gear-btn"));
		const stub = getByTestId("sc0i-profile-modal-stub");
		expect(stub.getAttribute("data-chat-id")).toBe("sc13a-chat");
		expect(stub.getAttribute("data-script-id")).toBe("");
	});
});
