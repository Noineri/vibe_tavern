import type { CoauthorSkillsRuntimeApi, SkillCatalogEntryDto } from "../contract/runtime-api.js";
import type { SkillCatalogEntry } from "../../domain/coauthor/skills/skill-scanner.js";
import type { SkillLibraryService, SkillSaveInput } from "../../domain/coauthor/skills/skill-library.js";

/**
 * Thin adapter between the `CoauthorSkillsRuntimeApi` contract and the
 * {@link SkillLibraryService}. No business logic — the service owns root
 * resolution, atomic import, built-in-immutability enforcement, and the merged
 * catalog. The adapter only maps domain catalog entries to the wire DTO
 * (stripping absolute filesystem paths — only the portable root-relative
 * manifest path crosses the boundary).
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

export class CoauthorSkillAdapter implements CoauthorSkillsRuntimeApi {
	constructor(private readonly skillLibrary: SkillLibraryService) {}

	importSkills = (files: Parameters<CoauthorSkillsRuntimeApi["importSkills"]>[0]) =>
		this.skillLibrary.importSkills(files);

	deleteSkill = (id: string) => this.skillLibrary.deleteSkill(id);

	/** The save seam (AP-23a): the service owns id derivation, manifest
	 *  rebuild, parse-before-write, and the atomic swap; the adapter only maps
	 *  the returned entry to the wire DTO (stripping absolute paths). */
	saveSkill = async (input: SkillSaveInput): Promise<SkillCatalogEntryDto> =>
		toDto(await this.skillLibrary.saveSkill(input));

	listSkills = async () => {
		const { entries, errors } = await this.skillLibrary.listCatalog();
		return {
			entries: entries.map(toDto),
			// Surface malformed-manifest errors with the skill id (directory name)
			// instead of an absolute path, keeping filesystem internals off the wire.
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

	readSkillContent = (id: string) => this.skillLibrary.readSkillContent(id);
}
