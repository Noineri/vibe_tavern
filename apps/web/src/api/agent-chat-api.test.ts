/**
 * SC-0c — owner-typed transport routing: a chat owner calls the SC-0b chat
 * routes, a script owner the script routes.
 *
 * The chat half pins the NEW `api/agent-chat-api.ts` client against the SC-0b
 * paths (`/api/agent/chats/:chatId/branches/:branchId/:kind/…`) — URL, method
 * and POST body. The script half pins the owner seam from the other side:
 * the registered `experience` host's transport maps
 * `{ kind: "script", scriptId }` back to the script lifecycle routes
 * (`/api/experience-copilot/script/:scriptId/…`), so the SC-0c re-typing did
 * not reroute a single script-owner call. Harness: the
 * chat-api-send-error.test.ts mockFetch pattern (fetch restored after each).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import type { AgentThreadOwner } from "@vibe-tavern/domain";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let chatApi: typeof import("./agent-chat-api.js");
let getAgentHost: typeof import("../lib/agent-host-registry.js").getAgentHost;
let scriptOwnerId: typeof import("../lib/agent-host-registry.js").scriptOwnerId;
type AgentHostTransport = import("../lib/agent-host-registry.js").AgentHostTransport;

beforeAll(async () => {
	chatApi = await import("./agent-chat-api.js");
	({ getAgentHost, scriptOwnerId } = await import("../lib/agent-host-registry.js"));
	// Self-registers the `experience` host (module init side effect — the same
	// import the production wrapper performs exactly once per process).
	await import("../components/build/editors/copilot/experience-agent-host.js");
});

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let capturedUrl = "";
let capturedInit: RequestInit | undefined;

function respondWith(status: number, body: unknown): void {
	capturedUrl = "";
	capturedInit = undefined;
	globalThis.fetch = Object.assign(
		mock<FetchImplementation>(async (input, init) => {
			capturedUrl = input.toString();
			capturedInit = init;
			return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		}),
		{ preconnect: originalFetch.preconnect },
	);
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	jest.restoreAllMocks();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

const chatOwner: AgentThreadOwner = {
	kind: "chat",
	chatId: "chat-1",
	branchId: "branch-1",
	agentKind: "sidechat-ooc",
};

const scriptOwner: AgentThreadOwner = { kind: "script", scriptId: "script-1" };

function chatBase(): string {
	if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
	return `/api/agent/chats/${chatOwner.chatId}/branches/${chatOwner.branchId}/${chatOwner.agentKind}`;
}

function threadWire(id: string): Record<string, unknown> {
	return { id, title: `Session ${id}`, archivedAt: null };
}

/** The script-owner transport under test — the registered host's own. */
function experienceTransport(): AgentHostTransport {
	return getAgentHost("experience").transport;
}

describe("agent-chat-api — a chat owner calls the chat routes", () => {
	it("getActiveThread-equivalent (getAgentChatActive) GETs the chat active route and returns the thread", async () => {
		if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
		respondWith(200, threadWire("thread-chat-1"));
		const thread = await chatApi.getAgentChatActive(chatOwner.chatId, chatOwner.branchId, chatOwner.agentKind);
		expect(capturedUrl).toContain(`${chatBase()}/active`);
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect((thread as { id: string }).id).toBe("thread-chat-1");
	});

	it("getAgentChatActive returns null before the first session", async () => {
		if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
		respondWith(200, null);
		const thread = await chatApi.getAgentChatActive(chatOwner.chatId, chatOwner.branchId, chatOwner.agentKind);
		expect(capturedUrl).toContain(`${chatBase()}/active`);
		expect(thread).toBeNull();
	});

	it("listAgentChatSessions GETs the chat sessions route and returns the list", async () => {
		if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
		respondWith(200, [threadWire("thread-chat-1"), threadWire("thread-chat-2")]);
		const sessions = await chatApi.listAgentChatSessions(chatOwner.chatId, chatOwner.branchId, chatOwner.agentKind);
		expect(capturedUrl).toContain(`${chatBase()}/sessions`);
		expect(sessions).toHaveLength(2);
	});

	it("startAgentChatSession POSTs the chat session route with the title", async () => {
		if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
		respondWith(200, threadWire("thread-chat-3"));
		const thread = await chatApi.startAgentChatSession(chatOwner.chatId, chatOwner.branchId, chatOwner.agentKind, "Side thread");
		expect(capturedUrl).toContain(`${chatBase()}/session`);
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ title: "Side thread" });
		expect((thread as { id: string }).id).toBe("thread-chat-3");
	});
});

describe("agent-chat-api — branch-sidechat fork pair (SC-21)", () => {
	it("getBranchSidechatSummary GETs the sidechat-summary route and returns the summary", async () => {
		if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
		respondWith(200, { hasSessions: true, count: 2 });
		const summary = await chatApi.getBranchSidechatSummary(chatOwner.chatId, chatOwner.branchId);
		expect(capturedUrl).toContain(`/api/agent/chats/${chatOwner.chatId}/branches/${chatOwner.branchId}/sidechat-summary`);
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect(summary).toEqual({ hasSessions: true, count: 2 });
	});

	it("forkBranchSidechat POSTs the fork-sidechat route with the target branch", async () => {
		if (chatOwner.kind !== "chat") throw new Error("fixture must be a chat owner");
		respondWith(200, { copiedThreads: [{ threadId: "thread-new-1", agentKind: "sidechat-ooc" }] });
		const result = await chatApi.forkBranchSidechat(chatOwner.chatId, chatOwner.branchId, "branch-2");
		expect(capturedUrl).toContain(`/api/agent/chats/${chatOwner.chatId}/branches/${chatOwner.branchId}/fork-sidechat`);
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ targetBranchId: "branch-2" });
		expect(result.copiedThreads).toHaveLength(1);
	});
});

describe("agent host transport — a script owner calls the script routes", () => {
	it("getActiveThread maps { kind: \"script\", scriptId } to the script active route", async () => {
		respondWith(200, threadWire("thread-script-1"));
		const thread = await experienceTransport().getActiveThread(scriptOwner);
		expect(capturedUrl).toContain(`/api/experience-copilot/script/${scriptOwnerId(scriptOwner)}/active`);
		expect(thread).not.toBeNull();
	});

	it("listSessions maps the script owner to the script sessions route", async () => {
		respondWith(200, [threadWire("thread-script-1")]);
		const sessions = await experienceTransport().listSessions(scriptOwner);
		expect(capturedUrl).toContain(`/api/experience-copilot/script/${scriptOwnerId(scriptOwner)}/sessions`);
		expect(sessions).toHaveLength(1);
	});

	it("startSession maps the script owner to the script session route", async () => {
		respondWith(200, threadWire("thread-script-2"));
		const thread = await experienceTransport().startSession(scriptOwner);
		expect(capturedUrl).toContain(`/api/experience-copilot/script/${scriptOwnerId(scriptOwner)}/session`);
		expect(capturedInit?.method).toBe("POST");
		expect(thread).not.toBeNull();
	});
});
