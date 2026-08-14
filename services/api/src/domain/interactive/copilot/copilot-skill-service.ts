/**
 * Copilot user-skill library (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-5).
 *
 * The copilot REUSES the generic Co-Author skill-library service verbatim —
 * `SkillLibraryService` already owns root-agnostic import/delete/catalog/read
 * over a `{userRoot, builtinRoot}` pair. The only copilot-specific thing is
 * WHICH roots it is constructed with (the copilot built-in skill root +
 * `<dataDir>/experience-copilot/skills`). This factory keeps the server wiring a
 * one-liner and names the copilot instance explicitly for DI.
 */

import { SkillLibraryService } from "../../coauthor/skills/skill-library.js";

/** Construct the copilot skill-library service over the given copilot roots. */
export function createCopilotSkillService(
	userRoot: string,
	builtinRoot: string,
): SkillLibraryService {
	return new SkillLibraryService(userRoot, builtinRoot);
}
