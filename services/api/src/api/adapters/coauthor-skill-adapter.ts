import type { CoauthorSkillsRuntimeApi } from "../contract/runtime-api.js";
import type { SkillLibraryService } from "../../domain/coauthor/skills/skill-library.js";

/**
 * Thin adapter between the `CoauthorSkillsRuntimeApi` contract and the
 * {@link SkillLibraryService}. No business logic — the service owns root
 * resolution, atomic import, and built-in-immutability enforcement.
 */
export class CoauthorSkillAdapter implements CoauthorSkillsRuntimeApi {
	constructor(private readonly skillLibrary: SkillLibraryService) {}

	importSkills = (files: Parameters<CoauthorSkillsRuntimeApi["importSkills"]>[0]) =>
		this.skillLibrary.importSkills(files);

	deleteSkill = (id: string) => this.skillLibrary.deleteSkill(id);
}
