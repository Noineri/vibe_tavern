/**
 * The ONE shared AgentShell fetch-router test harness — the unified form of
 * the scaffolding that was hand-copied across seven suites (fork census +
 * coincidence analysis: reports/AGENT_SHELL_TEST_HARNESS_UNIFICATION_ANALYSIS;
 * execution plan: plans/AGENT_SHELL_TEST_HARNESS_UNIFICATION_PLAN).
 *
 * serves: 7 suites (as of ASHU-1 the module exists; the census list migrates
 * unit by unit):
 *   - components/layout/app-shell-render-isolation.test.tsx (ASHU-2)
 *   - components/shared/agent-shell/agent-shell-stream-isolation.test.tsx (ASHU-3)
 *   - components/chat/sidechat/SidechatPanel.test.tsx (ASHU-4)
 *   - components/chat/sidechat/director-message-tools-flow.test.tsx (ASHU-5)
 *   - components/chat/sidechat/sidechat-host.test.tsx (ASHU-6)
 *   - components/build/editors/script-agent-host.test.tsx (ASHU-7)
 *   - components/build/editors/copilot/ExperienceCopilotShell.test.tsx (ASHU-8)
 * A NEW eighth hand-copy of the drain/router/bootstrap-quartet pattern is a
 * defect from copy #2 (AGENTS.md §3) — import this module instead.
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts): this
 * module registers NOTHING at import time — no mock.module, no globalThis
 * writes at module scope. Every export is a pure function or factory; the
 * caller installs/restore fetch in its own lifecycle hooks (R3 duty stays in
 * the test file). @testing-library/react is imported DYNAMICICALLY inside
 * flushSessionLoad so this module never loads RTL before dom-env registration
 * (the dom-env.ts ordering contract).
 *
 * Layer map (the analysis's four layers):
 *   0 — micro-helpers: jsonResponse / sseResponse / flushSessionLoad
 *   1 — fixtures: chatThread (wire-fixtures overrides pattern)
 *   2 — store discipline: seedShellStores / resetShellStores
 *   3 — route builder: shellRouter (bootstrap quartet + agent-chats triple +
 *       copilot family + custom escape hatch + fail-loud tail)
 */

import type {
	AgentKindSettingsWire,
	ExperienceCopilotMessageWire,
	ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import { useAgentReviewRoundStore } from "../src/stores/agent-review-store.js";
import { useAgentTurnStore } from "../src/stores/agent-turn-store.js";
import { useBootstrapStore } from "../src/stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../src/stores/provider-data-store.js";
import { useSnapshotStore } from "../src/stores/snapshot-store.js";
import { wireUiSettings } from "./wire-fixtures.js";

// ── Layer 0: micro-helpers ─────────────────────────────────────────────────

export function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

export function sseResponse(events: readonly string[]): Response {
	return new Response(events.join("") + (events.length > 0 ? "\n" : ""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/**
 * Drain the shell's chained async microtasks + React's scheduler macrotasks
 * (the 0ms ×5 macrotask drain every one of the seven suites hand-copied).
 * RTL is imported dynamically so the module stays loadable before dom-env
 * registration; in a DOM suite call this inside your act-composed waits the
 * same way the migrated files did.
 */
export async function flushSessionLoad(): Promise<void> {
	const { act } = await import("@testing-library/react");
	await act(async () => {
		for (let i = 0; i < 5; i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

// ── Layer 1: fixtures ──────────────────────────────────────────────────────

/** The one derivation of the copilot thread fixture (the wire schema's complete field set; per-file deltas arrive as overrides). */
export function chatThread(overrides: Partial<ExperienceCopilotThreadWire> = {}): ExperienceCopilotThreadWire {
	return {
		id: "sidechat-thread",
		scriptId: null,
		draftSessionId: null,
		title: "Sidechat",
		archivedAt: null,
		createdAt: "",
		updatedAt: "",
		metrics: null,
		contextLinks: [],
		todo: [],
		...overrides,
	};
}

// ── Layer 2: store discipline ──────────────────────────────────────────────

type ActiveChat = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]>;
type ActiveBranch = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeBranch"]>;

export interface ShellStoreSeed {
	/** agentKindSettings map for the bootstrap store (default: empty map). */
	agentKinds?: Record<string, AgentKindSettingsWire>;
	/** provider profiles for useProviderDataStore (default: empty list). */
	profiles?: ReturnType<typeof useProviderDataStore.getState>["profiles"];
	/** prompt presets carried in the bootstrap payload (default: none). */
	promptPresets?: unknown[];
	/** Active chat/branch for the snapshot store (default: not written). */
	activeChat?: ActiveChat;
	activeBranch?: ActiveBranch;
}

/** Seed the common store surface every AgentShell-mounting suite needs (the seedStores families the seven files hand-copied). */
export function seedShellStores(seed: ShellStoreSeed = {}): void {
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: [],
			promptPresets: (seed.promptPresets ?? []) as never,
			uiSettings: wireUiSettings(),
			agentKindSettings: seed.agentKinds ?? {},
			isArmServer: false,
		},
	});
	useProviderDataStore.setState({ profiles: seed.profiles ?? [] });
	if (seed.activeChat !== undefined || seed.activeBranch !== undefined) {
		useSnapshotStore.setState({ activeChat: seed.activeChat ?? null, activeBranch: seed.activeBranch ?? null });
	}
}

/** Reset the per-test volatile store surface (the common subset of the seven files' beforeEach blocks; file-specific extras stay in the file). */
export function resetShellStores(): void {
	useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
	useAgentReviewRoundStore.setState({ roundsByThread: {} });
	useSnapshotStore.setState({ activeChat: null, activeBranch: null });
}

// ── Layer 3: the route builder ─────────────────────────────────────────────

/** What a custom handler sees; return a Response to answer, null to fall through to the built-in routes. */
export interface RouterRequestContext {
	path: string;
	method: string;
	init?: RequestInit;
}

export type CustomRoute = (ctx: RouterRequestContext) => Response | null;

/** Mutable per-request state for the agent-chats triple — the test holds the object and may reassign fields between tests. */
export interface AgentChatsRouterState {
	activeThread: unknown;
	sessions: unknown[];
	newSession: unknown;
	messages: readonly ExperienceCopilotMessageWire[];
}

export interface ShellRouterOptions {
	/** Serve the bootstrap quartet + model-favorites (default true) — the routes every AgentShell-mounting suite hand-declared. */
	bootstrap?: boolean;
	/** Serve the /api/agent/chats/{c}/branches/{b}/{kind}/ active/sessions/session triple from live state. */
	agentChats?: AgentChatsRouterState;
	/** Serve the experience-copilot family (stream SSE, messages, context, context-links) — default on with a clean one-stop stream. */
	copilot?: { streamEvents?: readonly string[]; messages?: unknown } | false;
	/** File-specific routes (stateful routers, review endpoints, counters) — tried FIRST; null falls through. */
	custom?: CustomRoute;
}

/**
 * Build the fetch-router the suites pass to testFetch(). Deterministic,
 * fail-loud: an unmatched request answers 500 with the method+path named.
 */
export function shellRouter(
	options: ShellRouterOptions = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
	const bootstrap = options.bootstrap ?? true;
	const agentChats = options.agentChats;
	const copilot = options.copilot === undefined ? {} : options.copilot;
	const streamEvents = copilot === false ? [] : (copilot.streamEvents ?? ['data: {"finishReason":"stop"}']);
	const messages = copilot === false ? [] : (copilot.messages ?? []);
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const path = new URL(String(input), "http://gateway.test").pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const custom = options.custom?.({ path, method, init });
		if (custom) return custom;
		if (agentChats) {
			if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/active$/.test(path)) {
				return jsonResponse(agentChats.activeThread);
			}
			if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/sessions$/.test(path)) {
				return jsonResponse(agentChats.sessions);
			}
			if (method === "POST" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/session$/.test(path)) {
				return jsonResponse(agentChats.newSession);
			}
		}
		if (copilot !== false) {
			if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream/.test(path)) {
				return sseResponse(streamEvents);
			}
			if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
				return jsonResponse(messages);
			}
			if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
				return jsonResponse({ metrics: null, autoCompact: true });
			}
			if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
				return jsonResponse([]);
			}
			if (method === "GET" && path.includes("/branches/") && path.endsWith("/plan")) {
				return jsonResponse({ plan: { goal: "", constraints: [], tasks: [] } });
			}
		}
		if (bootstrap) {
			if (method === "GET" && path.endsWith("/api/personas")) return jsonResponse([]);
			if (method === "GET" && path.endsWith("/api/lorebooks/all")) return jsonResponse([]);
			if (method === "GET" && path.endsWith("/api/scripts/all")) return jsonResponse([]);
			if (method === "GET" && path.endsWith("/api/coauthor/skills")) return jsonResponse({ entries: [], errors: [] });
			if (method === "GET" && path.endsWith("/model-favorites")) return jsonResponse([]);
		}
		return jsonResponse({ error: { message: `Unhandled fetch in test: ${method} ${path}` } }, 500);
	};
}
