import { describe, expect, test } from "bun:test";
import { createCharacterRoutes } from "../src/api/routes/character.js";
import { createPersonaRoutes } from "../src/api/routes/persona.js";
import type { CharacterAssetRuntimeApi, CharacterRuntimeApi, PersonaRuntimeApi } from "../src/api/contract/runtime-api.js";
import { strictTestDouble } from "./strict-test-double.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// Build a mock runtime that lets each test override the avatar methods; an
// unprovided member throws a labeled miss instead of `undefined`. The
// character mock returns the route module's real parameter type (the
// CharacterAssetRuntimeApi intersection) — the old `as unknown as
// CharacterRuntimeApi` return hid the mismatch from every call site.
function mockCharacter(overrides: Partial<Pick<CharacterRuntimeApi, "uploadCharacterAvatar" | "serveCharacterAvatar" | "serveCharacterAvatarFull">> = {}): CharacterRuntimeApi & CharacterAssetRuntimeApi {
	return strictTestDouble<CharacterRuntimeApi & CharacterAssetRuntimeApi>(overrides, "CharacterRuntimeApi (avatar routes)");
}
function mockPersona(overrides: Partial<Pick<PersonaRuntimeApi, "uploadPersonaAvatar" | "servePersonaAvatar">> = {}): PersonaRuntimeApi {
	return strictTestDouble<PersonaRuntimeApi>(overrides, "PersonaRuntimeApi (avatar routes)");
}

describe("C1 character avatar routes", () => {
	test("POST /api/characters/:id/avatar: multipart upload → 200 + {avatarExt}", async () => {
		const runtime = mockCharacter({
			// The full upload return the real adapter answers with (the erased
			// fragment hid `avatarFullExt`); the route passes it through.
			uploadCharacterAvatar: async () => ({ avatarExt: "png", avatarFullExt: null }),
		});
		const app = createCharacterRoutes(runtime);

		const form = new FormData();
		form.append("file", new File([PNG], "a.png", { type: "image/png" }));

		const res = await app.request("/api/characters/char_1/avatar", { method: "POST", body: form });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ avatarExt: "png", avatarFullExt: null });
	});

	test("POST avatar: no file → 400", async () => {
		const app = createCharacterRoutes(mockCharacter());
		const res = await app.request("/api/characters/char_1/avatar", { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/No file/i);
	});

	test("POST avatar: unsupported type → 415", async () => {
		const runtime = mockCharacter({
			uploadCharacterAvatar: async () => { throw new Error("Unsupported image type: image/bmp"); },
		});
		const app = createCharacterRoutes(runtime);
		const form = new FormData();
		form.append("file", new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" }));
		const res = await app.request("/api/characters/char_1/avatar", { method: "POST", body: form });
		expect(res.status).toBe(415);
	});

	test("POST avatar: too large → 413", async () => {
		const runtime = mockCharacter({
			uploadCharacterAvatar: async () => { throw new Error("Image too large: 25.0 MB. Maximum: 20 MB."); },
		});
		const app = createCharacterRoutes(runtime);
		const form = new FormData();
		form.append("file", new File([PNG], "a.png", { type: "image/png" }));
		const res = await app.request("/api/characters/char_1/avatar", { method: "POST", body: form });
		expect(res.status).toBe(413);
	});

	test("POST avatar: generic error → 400", async () => {
		const runtime = mockCharacter({
			uploadCharacterAvatar: async () => { throw new Error("disk full"); },
		});
		const app = createCharacterRoutes(runtime);
		const form = new FormData();
		form.append("file", new File([PNG], "a.png", { type: "image/png" }));
		const res = await app.request("/api/characters/char_1/avatar", { method: "POST", body: form });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("disk full");
	});

	test("GET avatar: returns the Response from serve", async () => {
		const runtime = mockCharacter({
			serveCharacterAvatar: async () => new Response(PNG, { headers: { "Content-Type": "image/png" } }),
		});
		const app = createCharacterRoutes(runtime);
		const res = await app.request("/api/characters/char_1/avatar");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});

	test("GET avatar: null from serve → 404", async () => {
		const runtime = mockCharacter({ serveCharacterAvatar: async () => null });
		const app = createCharacterRoutes(runtime);
		const res = await app.request("/api/characters/char_1/avatar");
		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/Avatar not found/i);
	});

	test("POST avatar: multipart `crop` + `full` fields are forwarded to the adapter", async () => {
		const calls: Array<{ crop?: string; full?: string }> = [];
		const runtime = mockCharacter({
			uploadCharacterAvatar: async (_id, crop, full) => {
				calls.push({ crop: crop?.name, full: full?.name });
				return { avatarExt: "png", avatarFullExt: full ? "png" : null };
			},
		});
		const app = createCharacterRoutes(runtime);

		const form = new FormData();
		form.append("crop", new File([PNG], "crop.png", { type: "image/png" }));
		form.append("full", new File([PNG], "full.png", { type: "image/png" }));

		const res = await app.request("/api/characters/char_1/avatar", { method: "POST", body: form });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ avatarExt: "png", avatarFullExt: "png" });
		expect(calls).toEqual([{ crop: "crop.png", full: "full.png" }]);
	});

	test("GET /avatar/full: proxies to serveCharacterAvatarFull and returns its Response", async () => {
		const FULL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
		const runtime = mockCharacter({
			serveCharacterAvatarFull: async () => new Response(FULL, { headers: { "Content-Type": "image/png" } }),
		});
		const app = createCharacterRoutes(runtime);
		const res = await app.request("/api/characters/char_1/avatar/full");
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(FULL);
	});

	test("GET /avatar/full: null (no full and no thumbnail) → 404", async () => {
		const runtime = mockCharacter({ serveCharacterAvatarFull: async () => null });
		const app = createCharacterRoutes(runtime);
		const res = await app.request("/api/characters/char_1/avatar/full");
		expect(res.status).toBe(404);
	});
});

describe("C1 persona avatar routes", () => {
	test("POST /api/personas/:id/avatar: upload → 200; GET → bytes; GET null → 404", async () => {
		const runtime = mockPersona({
			// The full upload return the real adapter answers with (the erased
			// fragment hid `avatarFullExt`); the route passes it through.
			uploadPersonaAvatar: async () => ({ avatarExt: "webp", avatarFullExt: null }),
			servePersonaAvatar: async () => new Response(PNG, { headers: { "Content-Type": "image/png" } }),
		});
		const app = createPersonaRoutes(runtime);

		const form = new FormData();
		form.append("file", new File([PNG], "a.webp", { type: "image/webp" }));
		const post = await app.request("/api/personas/p_1/avatar", { method: "POST", body: form });
		expect(post.status).toBe(200);
		expect(await post.json()).toEqual({ avatarExt: "webp", avatarFullExt: null });

		const get = await app.request("/api/personas/p_1/avatar");
		expect(get.status).toBe(200);
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);
	});

	test("GET persona avatar: null → 404; POST no file → 400", async () => {
		const app = createPersonaRoutes(mockPersona({ servePersonaAvatar: async () => null }));
		const get = await app.request("/api/personas/p_1/avatar");
		expect(get.status).toBe(404);

		const post = await app.request("/api/personas/p_1/avatar", { method: "POST", body: new FormData() });
		expect(post.status).toBe(400);
	});
});
