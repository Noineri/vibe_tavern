import { describe, expect, test } from "bun:test";
import { createRegexRoutes } from "../src/api/routes/regex.js";
import type { RegexRuntimeApi } from "../src/api/contract/runtime-api.js";
import type {
  RegexPreset,
  RegexProfile,
  RegexProfileLink,
  RegexPresetId,
  RegexProfileId,
} from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";

function mockRegex(overrides: Partial<RegexRuntimeApi> = {}): RegexRuntimeApi {
	return { ...overrides } as unknown as RegexRuntimeApi;
}

const preset = (id: string, extra: Partial<RegexPreset> = {}): RegexPreset => ({
	id: brandId<RegexPresetId>(id),
	name: "p",
	findRegex: "/x/g",
	replaceString: "",
	trimStrings: [],
	substituteRegex: 0,
	disabled: false,
	markdownOnly: false,
	promptOnly: false,
	runOnEdit: true,
	minDepth: null,
	maxDepth: null,
	placement: [2],
	isGlobal: false,
	sortOrder: 0,
	profileId: null,
	createdAt: "0",
	updatedAt: "0",
	...extra,
});

const profile = (id: string, extra: Partial<RegexProfile> = {}): RegexProfile => ({
	id: brandId<RegexProfileId>(id),
	name: "profile",
	disabled: false,
	isGlobal: false,
	sortOrder: 0,
	createdAt: "0",
	updatedAt: "0",
	...extra,
});

const link = (id: string): RegexProfileLink => ({
	regexProfileId: brandId<RegexProfileId>(id),
	targetType: "character",
	targetId: "char_1",
});

describe("R-13 regex profile routes", () => {
	test("GET /api/regex/profiles/all returns the profile list", async () => {
		const runtime = mockRegex({ listAllRegexProfiles: async () => [profile("pf_1")] });
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/profiles/all");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([profile("pf_1")]);
	});

	test("GET /api/regex/profiles/:id returns the profile; unknown → 404", async () => {
		const runtime = mockRegex({
			getRegexProfile: async (id) => (id === "pf_1" ? profile("pf_1") : null),
		});
		const app = createRegexRoutes(runtime);
		const found = await app.request("/api/regex/profiles/pf_1");
		expect(found.status).toBe(200);
		expect(await found.json()).toEqual(profile("pf_1"));
		const missing = await app.request("/api/regex/profiles/nope");
		expect(missing.status).toBe(404);
	});

	test("POST /api/regex/profiles creates with 201; validates the body", async () => {
		let received: unknown;
		const runtime = mockRegex({
			createRegexProfile: async (body) => {
				received = body;
				return profile("pf_new");
			},
		});
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "bundle" }),
		});
		expect(res.status).toBe(201);
		expect(received).toMatchObject({ name: "bundle", disabled: false, isGlobal: false, sortOrder: 0 });
		// Empty name is rejected by the schema (400 from zValidator).
		const bad = await app.request("/api/regex/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "" }),
		});
		expect(bad.status).toBe(400);
	});

	test("PATCH /api/regex/profiles/:id updates the profile", async () => {
		let patchedId = "";
		const runtime = mockRegex({
			updateRegexProfile: async (id, body) => {
				patchedId = id;
				return profile("pf_1", { ...body, name: "renamed" });
			},
		});
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/profiles/pf_1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "renamed", disabled: true }),
		});
		expect(res.status).toBe(200);
		expect(patchedId).toBe("pf_1");
		expect(await res.json()).toMatchObject({ name: "renamed", disabled: true });
	});

	test("DELETE /api/regex/profiles/:id passes the mode query (default keep); invalid mode → 400", async () => {
		let deletedMode = "";
		const runtime = mockRegex({
			deleteRegexProfile: async (_id, mode) => {
				deletedMode = mode;
			},
		});
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/profiles/pf_1?mode=cascade", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(deletedMode).toBe("cascade");
		// Default = keep when no mode given.
		const res2 = await app.request("/api/regex/profiles/pf_2", { method: "DELETE" });
		expect(res2.status).toBe(200);
		expect(deletedMode).toBe("keep");
		// Unknown mode → schema 400.
		const res3 = await app.request("/api/regex/profiles/pf_3?mode=explode", { method: "DELETE" });
		expect(res3.status).toBe(400);
	});

	test("POST /api/regex/profiles/:id/attach attaches a rule and 404s on unknown rule", async () => {
		let attachArgs: [string, string] | null = null;
		const runtime = mockRegex({
			attachRegexRule: async (profileId, ruleId) => {
				attachArgs = [profileId, ruleId];
				if (ruleId === "gone") return null;
				return preset("rx_1", { profileId: brandId<RegexProfileId>(profileId) });
			},
		});
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/profiles/pf_1/attach", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ruleId: "rx_1" }),
		});
		expect(res.status).toBe(200);
		expect(attachArgs).toEqual(["pf_1", "rx_1"]);
		expect(await res.json()).toMatchObject({ id: "rx_1", profileId: "pf_1" });

		const missingRule = await app.request("/api/regex/profiles/pf_1/attach", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ruleId: "gone" }),
		});
		expect(missingRule.status).toBe(404); // attachRegexRule returned null → 404
	});

	test("POST /api/regex/presets/:id/detach detaches a rule", async () => {
		let detachedId = "";
		const runtime = mockRegex({
			detachRegexRule: async (ruleId) => {
				detachedId = ruleId;
				return preset(ruleId, { profileId: null });
			},
		});
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/presets/rx_1/detach", { method: "POST" });
		expect(res.status).toBe(200);
		expect(detachedId).toBe("rx_1");
	});

	test("GET /api/regex/profiles/:id/members returns member ids", async () => {
		const runtime = mockRegex({
			listRegexProfileMemberIds: async () => ["rx_1", "rx_2"],
		});
		const app = createRegexRoutes(runtime);
		const res = await app.request("/api/regex/profiles/pf_1/members");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(["rx_1", "rx_2"]);
	});

	test("GET/PUT /api/regex/profiles/:id/links round-trip profile links", async () => {
		let putBody: { links: Array<{ targetType: string; targetId: string }> } | null = null;
		const runtime = mockRegex({
			getRegexProfileLinks: async () => [link("pf_1")],
			setRegexProfileLinks: async (_id, links) => {
				putBody = { links };
				return [link("pf_1")];
			},
		});
		const app = createRegexRoutes(runtime);
		const got = await app.request("/api/regex/profiles/pf_1/links");
		expect(got.status).toBe(200);
		expect(await got.json()).toEqual([link("pf_1")]);
		const put = await app.request("/api/regex/profiles/pf_1/links", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ links: [{ targetType: "character", targetId: "char_1" }] }),
		});
		expect(put.status).toBe(200);
		expect(putBody?.links).toEqual([{ targetType: "character", targetId: "char_1" }]);
	});

	test("existing preset routes still work alongside profile routes (list + resolve)", async () => {
		const runtime = mockRegex({
			listAllRegexPresets: async () => [preset("rx_1")],
			resolveActiveRegex: async () => [preset("rx_1")],
		});
		const app = createRegexRoutes(runtime);
		const list = await app.request("/api/regex/presets/all");
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual([preset("rx_1")]);
		const resolve = await app.request("/api/regex/resolve-active?characterId=char_1");
		expect(resolve.status).toBe(200);
		expect(await resolve.json()).toEqual([preset("rx_1")]);
	});
});