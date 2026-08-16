import type { CoauthorSkillsRuntimeApi, SkillCatalogEntryDto } from "../contract/runtime-api.js";
import type { SkillCatalogEntry } from "../../domain/coauthor/skills/skill-scanner.js";
import type { SkillLibraryService } from "../../domain/coauthor/skills/skill-library.js";

/**
 * Thin adapter between the `CoauthorSkillsRuntimeApi` contract and a copilot-rooted
 * {@link SkillLibraryService} (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-5). Mirrors
 * {@link CoauthorSkillAdapter} exactly — no business logic; the service owns root
 * resolution, atomic import, built-in-immutability, and the merged catalog. The
 * adapter only maps domain catalog entries to the wire DTO (stripping absolute
 * filesystem paths).
 */
function toDto(entry: SkillCatalogEntry): SkillCatalogEntryDto {
	return {
		id: entry.id,
		source: entry.source,
		name: entry.name,
		description: entry.description,
		manifestPath: entry.rootRelativeManifestPath,
		shadowsBuiltin: entry.shadowsBuiltin,
	};
}

export class CopilotSkillAdapter implements CoauthorSkillsRuntimeApi {
	constructor(private readonly skillLibrary: SkillLibraryService) {}

	importSkills = (files: Parameters<CoauthorSkillsRuntimeApi["importSkills"]>[0]) =>
		this.skillLibrary.importSkills(files);

	deleteSkill = (id: string) => this.skillLibrary.deleteSkill(id);

	listSkills = async () => {
		const { entries, errors } = await this.skillLibrary.listCatalog();
		return {
			entries: entries.map(toDto),
			errors: errors.map((e) => ({
				source: e.source,
				id: e.skillDir.split(/[\\/]/).pop() ?? e.skillDir,
				reason: e.reason,
			})),
		};
	};

	readSkill = async (id: string): Promise<SkillCatalogEntryDto | null> => {
		const entry = await this.skillLibrary.readCatalogEntry(id);
		return entry ? toDto(entry) : null;
	};
}
