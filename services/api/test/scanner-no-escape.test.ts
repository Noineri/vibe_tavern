import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTopLevelDirs } from "../src/domain/coauthor/skills/skill-library.js";
import { scanSkillRoot } from "../src/domain/coauthor/skills/skill-scanner.js";
import { scanSillyTavernDirectory } from "../src/shared/st-directory-scanner.js";

const tmpRoots: string[] = [];
const skillManifest = "---\nname: Escape Target\ndescription: outside root\n---\n";

// Windows directory links require junction semantics; Linux uses ordinary directory
// symlinks. Windows runners were validated in the Wave 1 CI probes.
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

async function makeRoot(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `scanner-no-escape-${label}-`));
	tmpRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scanner configured-root security boundary", () => {
	test("ST scanner does not follow character file symlinks outside its root", async () => {
		// Given
		const scanRoot = await makeRoot("st-file-root");
		const outsideRoot = await makeRoot("st-file-outside");
		const charactersDir = join(scanRoot, "characters");
		const outsideCard = join(outsideRoot, "outside-card.json");
		await mkdir(charactersDir, { recursive: true });
		await Bun.write(
			outsideCard,
			JSON.stringify({ spec: "chara_card_v2", data: { name: "Outside Character" } }),
		);
		await symlink(outsideCard, join(charactersDir, "outside.JSON"), "file");
		await symlink("/etc/passwd", join(charactersDir, "system.JSON"), "file");

		// When
		const result = await scanSillyTavernDirectory(scanRoot);

		// Then
		expect(result.characters).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("ST scanner does not follow chat directory symlinks outside its root", async () => {
		// Given
		const scanRoot = await makeRoot("st-dir-root");
		const outsideRoot = await makeRoot("st-dir-outside");
		const chatsDir = join(scanRoot, "chats");
		const outsideChatDir = join(outsideRoot, "outside-character");
		await Promise.all([
			mkdir(chatsDir, { recursive: true }),
			mkdir(outsideChatDir, { recursive: true }),
		]);
		await Bun.write(
			join(outsideChatDir, "outside.JSONL"),
			`${JSON.stringify({ user_name: "User", character_name: "Outside" })}\n`,
		);
		await symlink(outsideChatDir, join(chatsDir, "linked-character"), directoryLinkType);

		// When
		const result = await scanSillyTavernDirectory(scanRoot);

		// Then
		expect(result.chats).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("ST scanner does not resolve a nested file-symlink chain outside its root", async () => {
		// Given
		const scanRoot = await makeRoot("st-chain-root");
		const outsideRoot = await makeRoot("st-chain-outside");
		const charactersDir = join(scanRoot, "characters");
		const outsideCard = join(outsideRoot, "outside-card.json");
		const firstLink = join(charactersDir, "a.JSON");
		const secondLink = join(charactersDir, "b.JSON");
		const thirdLink = join(charactersDir, "c.JSON");
		await mkdir(charactersDir, { recursive: true });
		await Bun.write(
			outsideCard,
			JSON.stringify({ spec: "chara_card_v2", data: { name: "Outside Chain Target" } }),
		);
		await symlink(secondLink, firstLink, "file");
		await symlink(thirdLink, secondLink, "file");
		await symlink(outsideCard, thirdLink, "file");

		// When
		const result = await scanSillyTavernDirectory(scanRoot);

		// Then
		expect(result.characters).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("skill scanner does not discover a symlinked skill directory", async () => {
		// Given
		const skillRoot = await makeRoot("skill-dir-root");
		const outsideRoot = await makeRoot("skill-dir-outside");
		const outsideSkillDir = join(outsideRoot, "outside-skill");
		await mkdir(outsideSkillDir, { recursive: true });
		await Bun.write(join(outsideSkillDir, "SKILL.md"), skillManifest);
		await symlink(outsideSkillDir, join(skillRoot, "linked-skill"), directoryLinkType);

		// When
		const result = await scanSkillRoot({ path: skillRoot, source: "user" });

		// Then
		expect(result.skills).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("skill scanner reports but does not follow a symlinked SKILL.md", async () => {
		// Given
		const skillRoot = await makeRoot("skill-manifest-root");
		const outsideRoot = await makeRoot("skill-manifest-outside");
		const skillDir = join(skillRoot, "linked-manifest");
		const outsideManifest = join(outsideRoot, "SKILL.md");
		await mkdir(skillDir, { recursive: true });
		await Bun.write(outsideManifest, skillManifest);
		await symlink(outsideManifest, join(skillDir, "SKILL.md"), "file");

		// When
		const result = await scanSkillRoot({ path: skillRoot, source: "user" });

		// Then
		expect(result.skills).toEqual([]);
		expect(result.errors).toEqual([
			{
				source: "user",
				skillDir,
				reason: "manifest SKILL.md is a symlink (rejected)",
			},
		]);
	});

	test("listTopLevelDirs excludes a symlinked directory outside its root", async () => {
		// Given
		const root = await makeRoot("list-root");
		const outsideRoot = await makeRoot("list-outside");
		const realDir = join(root, "real-dir");
		const outsideDir = join(outsideRoot, "outside-dir");
		await Promise.all([
			mkdir(realDir, { recursive: true }),
			mkdir(outsideDir, { recursive: true }),
		]);
		await Bun.write(join(outsideDir, "secret.txt"), "outside root");
		await symlink(outsideDir, join(root, "linked-dir"), directoryLinkType);

		// When
		const result = await listTopLevelDirs(root);

		// Then
		expect(result).toEqual(["real-dir"]);
	});
});
