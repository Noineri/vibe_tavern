import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createAgentBranchSidechatRoutes } from "../src/api/routes/agent-branch-sidechat.js";
import { createAgentChatSessionsRoutes } from "../src/api/routes/agent-chat-sessions.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";

/**
 * SC-20 — the route pair behind the fork, the REAL adapter (store-only
 * instance over a REAL store container in a temp data dir) behind the REAL
 * route module, with the SC-0b session routes mounted beside them:
 *
 * 1. POST …/fork-sidechat { targetBranchId } → 200 with the copied-threads
 *    result, and the copied session is servable through the sibling family;
 * 2. a target that is not a child of the source → the typed 400 (Validation
 *    + `target_branch_not_child_of_source` in details);
 * 3. a body without targetBranchId → the zod 400;
 * 4. a missing chat / missing target branch → 404 NotFound;
 * 5. GET …/sidechat-summary → { hasSessions, count } both ways (with and
 *    without active sessions), 404 for a foreign branch.
 */

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 400/404s are observable at the route —
 *  the same pattern as agent-thread-events.test.ts. */
function mountDomainErrorMapping(app: Hono): Hono {
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
	return app;
}

let stores: StoreContainer;
let app: Hono;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-branch-sidechat-"));
	stores = await createStoreContainer(join(dataRoot, "agent-sidechat.db"), dataRoot);
	const character = await stores.characters.create({ name: "SC-20 route fixture" });
	characterId = character.id;

	const copilotWire = new ExperienceCopilotAdapter(stores);
	app = mountDomainErrorMapping(
		new Hono()
			.route("/", createAgentBranchSidechatRoutes(copilotWire))
			.route("/", createAgentChatSessionsRoutes(copilotWire)),
	);
});

/** A chat with one user message and a child branch forked at it — the fork
 *  pair's minimal substrate. */
async function seedChatWithChild(): Promise<{ chatId: string; sourceBranchId: string; targetBranchId: string }> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-20 route fixture chat",
		promptPresetId: null,
	});
	const message = await stores.messages.addMessage({
		chatId: chat.id,
		branchId: chat.activeBranchId,
		role: "user",
		authorType: "user",
		content: "seed",
	});
	const child = await stores.chats.forkBranch(chat.id, message.id);
	return { chatId: chat.id, sourceBranchId: chat.activeBranchId, targetBranchId: child.id };
}

describe("POST /api/agent/chats/:chatId/branches/:branchId/fork-sidechat (SC-20)", () => {
	test("200 with the copied-threads result; the copy is servable through the sibling session routes", async () => {
		const { chatId, sourceBranchId, targetBranchId } = await seedChatWithChild();
		await stores.experienceCopilot.startNewChatSession(chatId, sourceBranchId, "sidechat-ooc");

		const response = await app.request(`/api/agent/chats/${chatId}/branches/${sourceBranchId}/fork-sidechat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ targetBranchId }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { copiedThreads: { threadId: string; agentKind: string }[] };
		expect(body.copiedThreads).toHaveLength(1);
		expect(body.copiedThreads[0]!.agentKind).toBe("sidechat-ooc");

		// The sibling family serves the copied session exactly as any other.
		const sessionsResponse = await app.request(
			`/api/agent/chats/${chatId}/branches/${targetBranchId}/sidechat-ooc/sessions`,
		);
		expect(sessionsResponse.status).toBe(200);
		const sessions = (await sessionsResponse.json()) as { id: string; archivedAt: string | null }[];
		expect(sessions.filter((session) => session.archivedAt === null).map((session) => session.id)).toEqual([
			body.copiedThreads[0]!.threadId,
		]);
	});

	test("a target that is not a child of the source → the typed 400", async () => {
		const { chatId, sourceBranchId } = await seedChatWithChild();
		// A branch that does not exist under this chat is a 404 — to hit the
		// 400 the target must EXIST but not be a child: fork a grandchild.
		const sourceMessages = await stores.messages.getMessages(sourceBranchId);
		const child = await stores.chats.forkBranch(chatId, sourceMessages[0]!.id);
		const grandchild = await stores.chats.forkBranch(chatId, (await stores.messages.getMessages(child.id))[0]!.id);

		const response = await app.request(`/api/agent/chats/${chatId}/branches/${sourceBranchId}/fork-sidechat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ targetBranchId: grandchild.id }),
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { kind: string; details?: Record<string, unknown> } };
		expect(body.error.kind).toBe("Validation");
		expect(body.error.details).toMatchObject({ code: "target_branch_not_child_of_source" });
	});

	test("a body without targetBranchId → the validator 400", async () => {
		const { chatId, sourceBranchId } = await seedChatWithChild();
		const response = await app.request(`/api/agent/chats/${chatId}/branches/${sourceBranchId}/fork-sidechat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(400);
	});

	test("a missing chat and a missing target branch → 404 NotFound", async () => {
		const { chatId, sourceBranchId, targetBranchId } = await seedChatWithChild();
		const missingChat = await app.request(`/api/agent/chats/chat_missing_sc20/branches/${sourceBranchId}/fork-sidechat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ targetBranchId }),
		});
		expect(missingChat.status).toBe(404);

		const missingTarget = await app.request(`/api/agent/chats/${chatId}/branches/${sourceBranchId}/fork-sidechat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ targetBranchId: "brnch_missing_sc20" }),
		});
		expect(missingTarget.status).toBe(404);
		const body = (await missingTarget.json()) as { error: { kind: string; resource?: string } };
		expect(body.error.kind).toBe("NotFound");
		expect(body.error.resource).toBe("ChatBranch");
	});
});

describe("GET /api/agent/chats/:chatId/branches/:branchId/sidechat-summary (SC-20)", () => {
	test("counts the ACTIVE chat-owned sessions both ways", async () => {
		const { chatId, sourceBranchId, targetBranchId } = await seedChatWithChild();

		const empty = await app.request(`/api/agent/chats/${chatId}/branches/${targetBranchId}/sidechat-summary`);
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ hasSessions: false, count: 0 });

		await stores.experienceCopilot.startNewChatSession(chatId, targetBranchId, "sidechat-ooc");
		const one = await app.request(`/api/agent/chats/${chatId}/branches/${targetBranchId}/sidechat-summary`);
		expect(one.status).toBe(200);
		expect(await one.json()).toEqual({ hasSessions: true, count: 1 });

		// Archived sessions do not count.
		const sessions = await stores.experienceCopilot.listSessionsForChat(chatId, targetBranchId, "sidechat-ooc");
		await stores.experienceCopilot.archive(sessions[0]!.id);
		const archived = await app.request(`/api/agent/chats/${chatId}/branches/${targetBranchId}/sidechat-summary`);
		expect(await archived.json()).toEqual({ hasSessions: false, count: 0 });

		// A foreign branch under this chat's path → 404.
		const other = await seedChatWithChild();
		const foreign = await app.request(`/api/agent/chats/${chatId}/branches/${other.sourceBranchId}/sidechat-summary`);
		expect(foreign.status).toBe(404);
		expect(sourceBranchId).not.toBe(other.sourceBranchId);
	});
});
