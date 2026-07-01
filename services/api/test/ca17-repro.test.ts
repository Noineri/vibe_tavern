/**
 * CA-17 CANARY — reproduce the reported loop: model emits a VALID # PERSONALITY
 * (H1) with H2 sub-blocks inside; the lost-section guard must NOT fire.
 * If this fails, the guard has a false-positive that turns the refuse→self-correct
 * loop into a death spiral (model can't "fix" already-correct input).
 */
import { describe, it, expect } from "bun:test";
import { parseProfileMd, serializeProfileMd, splitFrontmatter } from "@vibe-tavern/db";

// Mirror of detectLostSections (kept local so the test pins the algorithm).
const KNOWN = ["PERSONALITY", "SCENARIO", "EXAMPLES"] as const;
const FIELD: Record<string, "description" | "scenario" | "mesExample"> = {
	PERSONALITY: "description", SCENARIO: "scenario", EXAMPLES: "mesExample",
};
function detectLostSections(profileMd: string) {
	const { bodyText } = splitFrontmatter(profileMd);
	const seen = new Map<string, { heading: string; body: string }>();
	let cur: { level: string; name: string; body: string } | null = null;
	const flush = () => {
		if (!cur) return;
		const u = cur.name.toUpperCase();
		if ((KNOWN as readonly string[]).includes(u) && cur.body.trim().length > 0)
			seen.set(u, { heading: `${cur.level} ${cur.name}`, body: cur.body });
		cur = null;
	};
	for (const line of bodyText.split("\n")) {
		const m = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
		if (m) { flush(); cur = { level: m[1]!, name: m[2]!.trim(), body: "" }; }
		else if (cur) cur.body += (cur.body ? "\n" : "") + line;
	}
	flush();
	if (seen.size === 0) return [];
	const c = parseProfileMd(profileMd).profile;
	const lost: string[] = [];
	for (const [name, info] of seen) {
		const f = FIELD[name];
		if (f && (c[f] ?? "").trim().length === 0) lost.push(`${info.heading}→empty ${f}`);
	}
	return lost;
}

describe("CA-17 canary — no false-positive on valid H1 input", () => {
	it("H1 # PERSONALITY with H2 sub-blocks: guard must NOT fire (description survives)", () => {
		const md = [
			"---", "name: Noah", "tags: []", "---", "",
			"# PERSONALITY",
			"## Appearance",
			"Pale skin, dark hair, slight build.",
			"## Neurodivergence & Health",
			"Autistic, hypermobile joints, sensory overload.",
			"## Disposition",
			"Guarded, dry humor.",
			"## Sensitivity",
			"Loud noises, scratchy fabric.",
			"",
		].join("\n");
		const lost = detectLostSections(md);
		expect(lost).toEqual([]); // ← if non-empty, guard fires on VALID input (the reported bug)
		// Sanity: the codec actually captures the prose under # PERSONALITY.
		const desc = parseProfileMd(md).profile.description ?? "";
		expect(desc.length).toBeGreaterThan(0);
	});

	it("H1 # PERSONALITY flat prose (no sub-headings): guard must NOT fire", () => {
		const md = "---\nname: Noah\n---\n\n# PERSONALITY\nDirect and guarded.\n";
		expect(detectLostSections(md)).toEqual([]);
		expect((parseProfileMd(md).profile.description ?? "").trim()).toBe("Direct and guarded.");
	});

	it("regression: ## PERSONALITY (wrong level, H2) with body → guard FIRES (true positive)", () => {
		const md = "---\nname: Noah\n---\n\n## PERSONALITY\nThis should be under H1.\n";
		const lost = detectLostSections(md);
		expect(lost.length).toBeGreaterThan(0); // ← genuine content loss; guard correctly refuses
	});
});

describe("CA-17 canary — round-trip fidelity (validateProfileMd path)", () => {
	it("parse: full body captured under # PERSONALITY (incl. H2 sub-blocks)", () => {
		const md = "---\nname: Noah\ntags: []\n---\n\n# PERSONALITY\n## Appearance\nPale skin, dark hair.\n## Disposition\nGuarded.\n";
		const desc = parseProfileMd(md).profile.description ?? "";
		// Both H2 sub-block contents must survive under the H1 PERSONALITY field.
		expect(desc).toContain("Pale skin");
		expect(desc).toContain("Guarded");
	});

	it("serialize(parse(md)) round-trip: description survives + heading count stable", () => {
		const md = "---\nname: Noah\ntags: []\n---\n\n# PERSONALITY\n## Appearance\nPale skin.\n## Health\nAutistic.\n";
		const rt = serializeProfileMd(parseProfileMd(md));
		const desc2 = parseProfileMd(rt).profile.description ?? "";
		expect(desc2).toContain("Pale skin");
		expect(desc2).toContain("Autistic");
	});

	it("validateProfileMd does not throw on valid H1+H2 input", async () => {
		// Import the real function (not the local mirror) to pin production behavior.
		const mod = await import("../src/domain/chat/coauthor-tools.js");
		// validateProfileMd is not exported; exercise it indirectly via the tool set.
		const tools = (mod as { buildCoauthorTools: () => Record<string, { execute: (a: unknown) => Promise<unknown> }> }).buildCoauthorTools();
		const md = "---\nname: Noah\ntags: []\n---\n\n# PERSONALITY\n## Appearance\nPale skin.\n## Health\nAutistic.\n";
		// edit_profile.execute returns { target, proposed, summary } on success;
		// throws (lost-section guard) on refusal.
		const out = await tools.edit_profile.execute({ profileMd: md, summary: "test" });
		expect(out).toMatchObject({ target: "profile" });
	});
});
