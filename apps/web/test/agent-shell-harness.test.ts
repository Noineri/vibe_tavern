/**
 * Smoke test for test/agent-shell-harness.ts (the harness.smoke.test.tsx
 * precedent: prove the pure exports' shapes cheaply; the DOM-bound export
 * flushSessionLoad is proven live by the migrating suites — ASHU-2 onward —
 * because it dynamically imports RTL and wants dom-env's registration first).
 */
import { describe, expect, it } from "bun:test";
import { chatThread, jsonResponse, shellRouter, sseResponse } from "./agent-shell-harness.js";

const GET = (path: string): Promise<Response> => shellRouter({})(path, { method: "GET" });

describe("agent-shell-harness micro-helpers", () => {
	it("jsonResponse serializes with the given status", async () => {
		const ok = jsonResponse({ a: 1 });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("Content-Type")).toBe("application/json");
		expect(await ok.json()).toEqual({ a: 1 });
		const bad = jsonResponse({ error: "x" }, 500);
		expect(bad.status).toBe(500);
	});

	it("sseResponse emits text/event-stream frames", async () => {
		const res = sseResponse(['data: {"finishReason":"stop"}']);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(await res.text()).toBe('data: {"finishReason":"stop"}\n');
	});

	it("chatThread carries the full wire schema and applies overrides", () => {
		const base = chatThread();
		expect(base.title).toBe("Sidechat");
		expect(base.scriptId).toBeNull();
		expect(base.metrics).toBeNull();
		expect(base.contextLinks).toEqual([]);
		expect(base.todo).toEqual([]);
		expect(Object.keys(base).sort()).toEqual(
			["archivedAt", "contextLinks", "createdAt", "draftSessionId", "id", "metrics", "scriptId", "todo", "title", "updatedAt"].sort(),
		);
		expect(chatThread({ id: "t-2", title: "Other" }).id).toBe("t-2");
		expect(chatThread({ id: "t-2", title: "Other" }).title).toBe("Other");
	});
});

describe("shellRouter", () => {
	it("serves the bootstrap quartet + model-favorites and fails loud on the unknown", async () => {
		expect((await GET("/api/personas")).status).toBe(200);
		expect(await (await GET("/api/personas")).json()).toEqual([]);
		expect((await GET("/api/lorebooks/all")).status).toBe(200);
		expect((await GET("/api/scripts/all")).status).toBe(200);
		const skills = await (await GET("/api/coauthor/skills")).json();
		expect(skills).toEqual({ entries: [], errors: [] });
		expect((await GET("/api/provider-profiles/p1/model-favorites")).status).toBe(200);
		const unhandled = await GET("/api/nope");
		expect(unhandled.status).toBe(500);
		const body = (await unhandled.json()) as { error: { message: string } };
		expect(body.error.message).toContain("GET");
		expect(body.error.message).toContain("/api/nope");
	});

	it("bootstrap: false removes the quartet", async () => {
		const router = shellRouter({ bootstrap: false });
		const res = await router("/api/personas", { method: "GET" });
		expect(res.status).toBe(500);
	});

	it("serves the agent-chats triple from LIVE state (per-test mutation visible)", async () => {
		const state = {
			activeThread: chatThread({ id: "t-a" }),
			sessions: [{ id: "s1" }],
			newSession: chatThread({ id: "t-new" }),
			messages: [],
		};
		const router = shellRouter({ agentChats: state });
		const active = await (await router("/api/agent/chats/chat-1/branches/branch-1/sidechat-ooc/active", { method: "GET" })).json();
		expect(active).toEqual(state.activeThread);
		const created = await (await router("/api/agent/chats/chat-1/branches/branch-1/sidechat-ooc/session", { method: "POST" })).json();
		expect(created).toEqual(state.newSession);
		state.activeThread = chatThread({ id: "t-b" });
		const after = await (await router("/api/agent/chats/chat-1/branches/branch-1/sidechat-ooc/active", { method: "GET" })).json();
		expect(after).toEqual(state.activeThread);
	});

	it("serves the copilot family with the clean default stream and overridable messages", async () => {
		const router = shellRouter({ copilot: { messages: [{ id: "m1" }] } });
		const stream = await router("/api/experience-copilot/x/stream", { method: "POST" });
		expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
		expect(await stream.text()).toBe('data: {"finishReason":"stop"}\n');
		const messages = await (await router("/api/experience-copilot/x/messages", { method: "GET" })).json();
		expect(messages).toEqual([{ id: "m1" }]);
		const context = await (await router("/api/experience-copilot/x/context", { method: "GET" })).json();
		expect(context).toEqual({ metrics: null, autoCompact: true });
		const plan = await (await router("/api/agent/chats/chat-1/branches/branch-1/sidechat-ooc/plan", { method: "GET" })).json();
		expect(plan).toEqual({ plan: { goal: "", constraints: [], tasks: [] } });
	});

	it("custom handlers run FIRST and null falls through", async () => {
		const router = shellRouter({
			custom: ({ path, method }) => {
				if (method === "DELETE" && path.endsWith("/reviews/r1")) return jsonResponse({ ok: true });
				return null;
			},
		});
		const handled = await router("/api/agent-runs/x/reviews/r1", { method: "DELETE" });
		expect(await handled.json()).toEqual({ ok: true });
		const fallen = await router("/api/personas", { method: "GET" });
		expect(fallen.status).toBe(200);
	});
});
