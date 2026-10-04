import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { createAiInstructionTemplateRoutes } from "../src/api/routes/ai-instruction-template.js";
import { AiInstructionTemplateAdapter } from "../src/api/adapters/ai-instruction-template-adapter.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * AI_EDITOR_INSTRUCTION_TEMPLATES — instruction-template HTTP routes.
 * Mirrors the small-resource route test pattern (sampler-set-routes.test.ts)
 * with the real store container + adapter (DB round-trip end-to-end, no
 * mocked store). Pins: GET/POST/GET-list, PATCH rename + text overwrite,
 * DELETE, the case-insensitive 409 name collision, and the empty-name 400
 * (zod) — the same production DomainError mapping the app mounts.
 */

let stores: StoreContainer;
let app: ReturnType<typeof createAiInstructionTemplateRoutes>;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-ai-instruction-template-routes-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	app = createAiInstructionTemplateRoutes(new AiInstructionTemplateAdapter(stores));
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
});

interface WireTemplate {
	id: string;
	name: string;
	sortOrder: number;
	text: string;
	createdAt: string;
	updatedAt: string;
}

const jsonHeaders = { "content-type": "application/json" };

async function createTemplate(name: string, text: string): Promise<WireTemplate> {
	const res = await app.request("/api/ai-instruction-templates", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify({ name, text }),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as WireTemplate;
}

describe("POST /api/ai-instruction-templates", () => {
	test("creates a template and lists it in store order", async () => {
		const created = await createTemplate("Сократить", "Сократи ответ до трёх абзацев.");
		expect(created.id).toMatch(/^aitpl/);
		expect(created.name).toBe("Сократить");
		expect(created.text).toBe("Сократи ответ до трёх абзацев.");
		expect(created.sortOrder).toBe(0);

		const second = await createTemplate("Без пафоса", "Убери пафос, оставь суть.");
		expect(second.sortOrder).toBe(1);

		const list = await app.request("/api/ai-instruction-templates");
		expect(list.status).toBe(200);
		const body = (await list.json()) as WireTemplate[];
		expect(body.map((tpl) => tpl.name)).toEqual(["Сократить", "Без пафоса"]);
	});

	test("rejects a duplicate name (case-insensitive) → 409", async () => {
		await createTemplate("Alpha", "first");
		const res = await app.request("/api/ai-instruction-templates", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "ALPHA", text: "collision" }),
		});
		expect(res.status).toBe(409);
	});

	test("rejects an empty name or empty text → 400", async () => {
		const noName = await app.request("/api/ai-instruction-templates", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "", text: "x" }),
		});
		expect(noName.status).toBe(400);

		const noText = await app.request("/api/ai-instruction-templates", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "Empty text", text: "" }),
		});
		expect(noText.status).toBe(400);
	});
});

describe("PATCH /api/ai-instruction-templates/:id", () => {
	test("renames and overwrites the text (both, separately)", async () => {
		const created = await createTemplate("Rename me", "old text");

		const renamed = await app.request(`/api/ai-instruction-templates/${created.id}`, {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "Renamed" }),
		});
		expect(renamed.status).toBe(200);
		expect(((await renamed.json()) as WireTemplate).name).toBe("Renamed");

		const rewritten = await app.request(`/api/ai-instruction-templates/${created.id}`, {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ text: "new text" }),
		});
		expect(rewritten.status).toBe(200);
		expect(((await rewritten.json()) as WireTemplate).text).toBe("new text");
	});

	test("rename onto an existing name → 409; unknown id → 400", async () => {
		const one = await createTemplate("One", "1");
		await createTemplate("Two", "2");

		const collision = await app.request(`/api/ai-instruction-templates/${one.id}`, {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "two" }),
		});
		expect(collision.status).toBe(409);

		const missing = await app.request("/api/ai-instruction-templates/aitpl_nope", {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "Whatever" }),
		});
		expect(missing.status).toBe(400);
	});
});

describe("DELETE /api/ai-instruction-templates/:id", () => {
	test("deletes the template (nothing references it — insert copies text)", async () => {
		const created = await createTemplate("Temp", "bye");
		const res = await app.request(`/api/ai-instruction-templates/${created.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);

		const list = (await (await app.request("/api/ai-instruction-templates")).json()) as WireTemplate[];
		expect(list.find((tpl) => tpl.id === created.id)).toBeUndefined();
	});
});
