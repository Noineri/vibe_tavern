import { resolve } from "node:path";

import { importCharacterCardV3Json } from "./cards/chara-card-v3.js";
import { importStLorebookJson } from "./lorebooks/st-lorebook.js";

interface FixtureSummary {
	file: string;
	kind: "character" | "lorebook";
	name: string;
	warnings: number;
	details: string;
}

async function readJsonFile(path: string): Promise<string> {
	return Bun.file(path).text();
}

async function main(): Promise<void> {
	const workspaceRoot = resolve(import.meta.dir, "../../../../../../");
	const fixtures = [
		resolve(workspaceRoot, "Oliver(telepath)", "Oliver.json"),
		resolve(workspaceRoot, "Silvius", "Silvius.json"),
		resolve(workspaceRoot, "Mikhael Smith", "Mikhael Smith.json"),
		resolve(workspaceRoot, "Mikhael Smith", "Random Events.json"),
	];

	const summaries: FixtureSummary[] = [];

	for (const fixture of fixtures) {
		const raw = await readJsonFile(fixture);

		if (fixture.endsWith("Random Events.json")) {
			const imported = importStLorebookJson(raw);
			summaries.push({
				file: fixture,
				kind: "lorebook",
				name: imported.lorebook.name,
				warnings: imported.warnings.length,
				details: `entries=${imported.entries.length} scope=${imported.lorebook.scopeType}`,
			});
			continue;
		}

		const imported = importCharacterCardV3Json(raw);
		summaries.push({
			file: fixture,
			kind: "character",
			name: imported.character.name,
			warnings: imported.warnings.length,
			details: `slug=${imported.character.slug} format=${imported.version.cardFormat}`,
		});
	}

	for (const summary of summaries) {
		console.log(
			`[${summary.kind}] ${summary.name} | warnings=${summary.warnings} | ${summary.details} | ${summary.file}`,
		);
	}
}

main().catch((error: unknown) => {
	const message =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	console.error(message);
	process.exitCode = 1;
});
