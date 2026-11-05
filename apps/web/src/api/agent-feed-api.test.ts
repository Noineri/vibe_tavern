/**
 * AFP-12 — the paged feed/detail client (`api/agent-feed-api.ts`) against the
 * AFP-11 routes, plus the host-contract half: every REGISTERED built-in host
 * wires `transport.feed` to the client fns by IDENTITY — no wrapper, so the
 * paged path can never fall back to a full-thread fetch. Harness: the
 * agent-chat-api.test.ts pattern (fetch-level mock, restored after each and
 * after all; no mock.module anywhere).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let feedApi: typeof import("./agent-feed-api.js");
let getAgentHost: typeof import("../lib/agent-host-registry.js").getAgentHost;
type AgentFeedStaleError = import("./agent-feed-api.js").AgentFeedStaleError;

beforeAll(async () => {
	feedApi = await import("./agent-feed-api.js");
	({ getAgentHost } = await import("../lib/agent-host-registry.js"));
	// Self-register every built-in host (module-init side effects — the same
	// imports the production wrappers perform exactly once per process).
	await import("../components/build/editors/copilot/experience-agent-host.js");
	await import("../components/build/editors/script-agent-host.js");
	await import("../components/chat/sidechat/sidechat-host.js");
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

/** A minimal schema-valid feed page fixture (thread echo + one message). */
function feedPage() {
	return {
		threadId: "t1",
		historyEpoch: 0,
		head: { record: "message", seq: 1, createdAt: "2026-11-05T12:00:02.000Z", id: "a1" },
		range: {
			oldest: { record: "message", seq: 0, createdAt: "2026-11-05T12:00:01.000Z", id: "u1" },
			newest: { record: "message", seq: 1, createdAt: "2026-11-05T12:00:02.000Z", id: "a1" },
		},
		messages: [{ id: "u1", threadId: "t1", role: "user", content: "hi", toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null, createdAt: "2026-11-05T12:00:01.000Z" }],
		events: [],
		hasOlder: true,
		hasNewer: false,
		cursors: { before: "cur-before", after: null },
		boundary: {
			startsMidTurn: false,
			endsMidTurn: false,
			turnOpenerMessageId: "u1",
			continuedToolCalls: [],
			lastUserMessageId: "u1",
			digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null },
		},
	};
}

describe("agent-feed-api — the paged feed read", () => {
	it("GETs the feed route; the newest window carries no paging params", async () => {
		respondWith(200, feedPage());
		const page = await feedApi.getAgentFeedPage("t1");
		expect(capturedUrl).toContain("/api/agent/threads/t1/feed");
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect(new URL(capturedUrl, "http://localhost").search).toBe("");
		expect(page.threadId).toBe("t1");
		expect(page.messages).toHaveLength(1);
	});

	it("echoes the cursor params verbatim and stringifies the numeric limit", async () => {
		respondWith(200, feedPage());
		await feedApi.getAgentFeedPage("t1", { before: "cur-before", limit: 40 });
		const url = new URL(capturedUrl, "http://localhost");
		// The dev-gateway base is absent under the harness (the "null" origin
		// prefix) — the sibling agent-chat-api test's toContain convention.
		expect(url.pathname.endsWith("/api/agent/threads/t1/feed")).toBe(true);
		expect(url.searchParams.get("before")).toBe("cur-before");
		expect(url.searchParams.get("limit")).toBe("40");
		expect(url.searchParams.has("after")).toBe(false);

		respondWith(200, feedPage());
		await feedApi.getAgentFeedPage("t1", { after: "cur-after" });
		expect(new URL(capturedUrl, "http://localhost").searchParams.get("after")).toBe("cur-after");

		respondWith(200, feedPage());
		await feedApi.getAgentFeedPage("t1", { aroundMessageId: "u1" });
		expect(new URL(capturedUrl, "http://localhost").searchParams.get("aroundMessageId")).toBe("u1");
	});

	it("a typed 409 becomes AgentFeedStaleError carrying the code and the CURRENT epoch", async () => {
		respondWith(409, { error: { kind: "Conflict", message: "stale window", details: { code: "AGENT_FEED_STALE_WINDOW", historyEpoch: 7 } } });
		let failure: unknown;
		try { await feedApi.getAgentFeedPage("t1", { before: "cur-before" }); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(feedApi.AgentFeedStaleError);
		const stale = failure as AgentFeedStaleError;
		expect(stale.code).toBe("AGENT_FEED_STALE_WINDOW");
		expect(stale.historyEpoch).toBe(7);
		expect(stale.message).toBe("stale window");
	});

	it("an untyped 409 and other failures stay the shared RpcError mapping", async () => {
		respondWith(409, { error: { kind: "Conflict", message: "some other conflict" } });
		let failure: unknown;
		try { await feedApi.getAgentFeedPage("t1"); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(feedApi.AgentFeedStaleError);
		expect((failure as { status: number }).status).toBe(409);

		respondWith(404, { error: { kind: "NotFound", message: "no thread" } });
		let missing: unknown;
		try { await feedApi.getAgentFeedPage("never_born"); } catch (error) { missing = error; }
		expect((missing as { status: number }).status).toBe(404);
	});
});

describe("agent-feed-api — the frozen detail read", () => {
	it("GETs the detail route; the first page sends no cursor", async () => {
		respondWith(200, { threadId: "t1", eventId: "ev1", epoch: 0, kind: "branch_forked", at: 3, nextCursor: null });
		const detail = await feedApi.getAgentEventDetail("t1", "ev1");
		expect(capturedUrl).toContain("/api/agent/threads/t1/events/ev1");
		expect(new URL(capturedUrl, "http://localhost").search).toBe("");
		expect(detail.kind).toBe("branch_forked");
	});

	it("a continuation page echoes the previous response's nextCursor", async () => {
		respondWith(200, { threadId: "t1", eventId: "ev1", epoch: 0, kind: "rp_sync", fromPosition: 0, toPosition: 54, offset: 50, messages: [], nextCursor: null });
		await feedApi.getAgentEventDetail("t1", "ev1", "cur-detail");
		expect(new URL(capturedUrl, "http://localhost").searchParams.get("cursor")).toBe("cur-detail");
	});

	it("the stale-cursor 409 keeps its own typed code", async () => {
		respondWith(409, { error: { kind: "Conflict", message: "stale cursor", details: { code: "AGENT_EVENT_CURSOR_STALE", historyEpoch: 2 } } });
		let failure: unknown;
		try { await feedApi.getAgentEventDetail("t1", "ev1", "cur-detail"); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(feedApi.AgentFeedStaleError);
		expect((failure as AgentFeedStaleError).code).toBe("AGENT_EVENT_CURSOR_STALE");
		expect((failure as AgentFeedStaleError).historyEpoch).toBe(2);
	});
});

describe("agent-feed-api — every built-in host wires the transport member by identity", () => {
	it("the experience host: transport.feed is the client fns, not a wrapper", () => {
		const transport = getAgentHost("experience").transport;
		expect(transport.feed?.page).toBe(feedApi.getAgentFeedPage);
		expect(transport.feed?.detail).toBe(feedApi.getAgentEventDetail);
	});

	it("the script host: transport.feed is the client fns, not a wrapper", () => {
		const transport = getAgentHost("script").transport;
		expect(transport.feed?.page).toBe(feedApi.getAgentFeedPage);
		expect(transport.feed?.detail).toBe(feedApi.getAgentEventDetail);
	});

	it("the sidechat host: transport.feed is the client fns, not a wrapper", () => {
		const transport = getAgentHost("sidechat-ooc").transport;
		expect(transport.feed?.page).toBe(feedApi.getAgentFeedPage);
		expect(transport.feed?.detail).toBe(feedApi.getAgentEventDetail);
	});

	it("the wired member is LIVE: a page request flows through the transport to the feed route", async () => {
		respondWith(200, feedPage());
		const page = await getAgentHost("sidechat-ooc").transport.feed!.page("t1", { limit: 2 });
		expect(capturedUrl).toContain("/api/agent/threads/t1/feed");
		expect(new URL(capturedUrl, "http://localhost").searchParams.get("limit")).toBe("2");
		expect(page.messages).toHaveLength(1);
	});
});
