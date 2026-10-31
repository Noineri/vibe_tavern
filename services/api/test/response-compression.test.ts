import { describe, expect, test } from "bun:test";
import { streamSSE } from "hono/streaming";
import { createApp } from "../src/server/app-factory.js";
import { createAiAssistantFeature } from "../src/domain/ai-assistant/ai-assistant-feature.js";
import { EventBus } from "@vibe-tavern/domain";
import type { RuntimeApi } from "../src/api/routes/index.js";

const payload = { text: "network response ".repeat(256) };

async function makeApp() {
	return createApp({
		runtime: {} as RuntimeApi,
		configureFeatures(app) {
			app.get("/api/compression-json", (c) => c.json(payload));
			app.get("/api/compression-encoded", () => new Response(Bun.gzipSync(JSON.stringify(payload)), {
				headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
			}));
			app.get("/api/compression-ndjson", (c) => c.body(`${JSON.stringify(payload)}\n`, 200, {
				"Content-Type": "application/x-ndjson",
			}));
		},
	});
}

describe("response compression", () => {
	test("an embedded frontend compresses on demand without precompressed siblings", async () => {
		const content = "export const value = 'embedded';\n".repeat(128);
		const app = await createApp({
			runtime: {} as RuntimeApi,
			embeddedWebFiles: new Map([
				["/index.html", new Blob(["<main>app</main>"], { type: "text/html" })],
				["/assets/app.js", new Blob([content], { type: "text/javascript" })],
			]),
		});
		const response = await app.request("/assets/app.js", { headers: { "Accept-Encoding": "gzip" } });
		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(response.headers.get("ETag")).toStartWith("W/");
		expect(new TextDecoder().decode(Bun.gunzipSync(await response.arrayBuffer()))).toBe(content);
	});

	test("JSON without encoding negotiation keeps its original body", async () => {
		const app = await makeApp();
		const response = await app.request("/api/compression-json");
		expect(response.headers.get("Content-Encoding")).toBeNull();
		expect(await response.json()).toEqual(payload);
	});

	test("JSON requested with gzip keeps its decoded payload", async () => {
		const app = await makeApp();
		const response = await app.request("/api/compression-json", { headers: { "Accept-Encoding": "gzip" } });
		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(response.headers.get("Vary")).toContain("Accept-Encoding");
		expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await response.arrayBuffer())))).toEqual(payload);
	});

	test("already encoded responses are not compressed twice", async () => {
		const app = await makeApp();
		const response = await app.request("/api/compression-encoded", { headers: { "Accept-Encoding": "gzip" } });
		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await response.arrayBuffer())))).toEqual(payload);
	});

	test("JSONL export content stays uncompressed", async () => {
		const app = await makeApp();
		const response = await app.request("/api/compression-ndjson", { headers: { "Accept-Encoding": "gzip" } });
		expect(response.headers.get("Content-Encoding")).toBeNull();
		expect(await response.text()).toBe(`${JSON.stringify(payload)}\n`);
	});

	for (const transport of ["streamSSE", "assistant"] as const) {
		test(`${transport} delivers the first event while the producer is parked`, async () => {
			const gate = Promise.withResolvers<void>();
			let ended = false;
			const runtime = {
				async *streamAiAssistant() {
					yield { type: "text", text: "first" };
					await gate.promise;
					ended = true;
					yield { type: "done" };
				},
			} as unknown as RuntimeApi;
			const app = await createApp({
				runtime,
				configureFeatures(app) {
					if (transport === "assistant") {
						createAiAssistantFeature(runtime).activate({ events: new EventBus(), router: app });
					} else {
						app.post("/api/ai-assistant", (c) => streamSSE(c, async (stream) => {
							await stream.writeSSE({ data: "first" });
							await gate.promise;
							ended = true;
							await stream.writeSSE({ data: "done" });
						}));
					}
				},
			});
			try {
				const response = await app.request("/api/ai-assistant", {
					method: "POST",
					headers: { "Accept-Encoding": "gzip", "Content-Type": "application/json" },
					body: JSON.stringify({ mode: "lore_entry", instruction: "test", providerProfileId: "p", enabledLayers: [] }),
				});
				expect(response.headers.get("Content-Encoding")).toBeNull();
				expect(response.headers.get("Content-Type")).toContain("text/event-stream");
				const reader = response.body!.getReader();
				const first = await reader.read();
				expect(new TextDecoder().decode(first.value)).toContain("first");
				expect(ended).toBe(false);
				gate.resolve();
				while (!(await reader.read()).done) { /* drain the terminal event */ }
				expect(ended).toBe(true);
			} finally {
				gate.resolve();
			}
		});
	}
});
