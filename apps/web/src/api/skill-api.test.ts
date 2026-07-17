/**
 * CTX-S7 — pins that `importCoauthorSkills` builds the multipart upload so each
 * file's FIELD NAME is its `webkitRelativePath` (the portable relative path a
 * `<input webkitdirectory>` picker produces). This is the self-check "Folder
 * upload preserves relative paths": the server resolves the skill tree from
 * these field names with no companion path array, so a regression here would
 * silently flatten or misname imported files.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCoauthorSkills } from "./skill-api.js";

/** Make a File with a `webkitRelativePath` (readonly in the DOM type, so define
 *  it explicitly — mirrors what a folder picker writes on each File). */
function folderFile(relativePath: string, contents = "x"): File {
	const file = new File([contents], relativePath.split("/").pop() ?? relativePath, { type: "text/markdown" });
	Object.defineProperty(file, "webkitRelativePath", { value: relativePath, configurable: true });
	return file;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("importCoauthorSkills — folder upload preserves relative paths (CTX-S7)", () => {
	it("uses each file's webkitRelativePath as its multipart field name", async () => {
		const files = [
			folderFile("general-writing/SKILL.md", "---\nname: General\n---\nbody"),
			folderFile("general-writing/references/rules.md", "rules"),
			folderFile("general-writing/assets/template.md", "tpl"),
		];

		let captured: FormData | undefined;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = init?.body as FormData;
			return new Response(JSON.stringify({ importedSkillIds: ["general-writing"], importedTopLevelDirs: ["general-writing"] }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await importCoauthorSkills(files);

		// Field names are EXACTLY the relative paths (preserving the folder tree).
		const entries = Array.from(captured!.entries());
		expect(entries.map(([name]) => name)).toEqual([
			"general-writing/SKILL.md",
			"general-writing/references/rules.md",
			"general-writing/assets/template.md",
		]);
		// The corresponding values are the original files, in order.
		// The corresponding values are the original files, in order. (The FormData
		// entry value is typed narrowly in this lib config, so cast via unknown.)
		expect(entries.map(([, value]) => (value as unknown as File).name)).toEqual(["SKILL.md", "rules.md", "template.md"]);
		expect(result.importedSkillIds).toEqual(["general-writing"]);
	});

	it("falls back to file.name when webkitRelativePath is absent (single-file picker)", async () => {
		const file = new File(["body"], "loose-skill.md", { type: "text/markdown" });
		// No webkitRelativePath defined (a plain file input without webkitdirectory).

		let captured: FormData | undefined;
		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured = init?.body as FormData;
			return new Response(JSON.stringify({ importedSkillIds: [], importedTopLevelDirs: [] }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await importCoauthorSkills([file]);
		expect(Array.from(captured!.entries()).map(([name]) => name)).toEqual(["loose-skill.md"]);
	});

	it("throws on a non-OK response, surfacing the server message", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ error: "No SKILL.md found in tree." }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			}),
		) as unknown as typeof fetch;

		await expect(importCoauthorSkills([folderFile("bad/SKILL.md")])).rejects.toThrow(/No SKILL\.md found/);
	});

	it("POSTs to the import endpoint", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			capturedUrl = input.toString();
			return new Response(JSON.stringify({ importedSkillIds: [], importedTopLevelDirs: [] }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await importCoauthorSkills([folderFile("x/SKILL.md")]);
		expect(capturedUrl).toContain("/api/coauthor/skills/import");
	});
});
