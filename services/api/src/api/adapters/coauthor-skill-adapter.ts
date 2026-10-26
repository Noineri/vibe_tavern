import type { CoauthorSkillsRuntimeApi, SkillCatalogEntryDto } from "../contract/runtime-api.js";
import type { SkillCatalogEntry } from "../../domain/coauthor/skills/skill-scanner.js";
import type { SkillLibraryService, SkillSaveInput } from "../../domain/coauthor/skills/skill-library.js";
import type { SkillOrderStore } from "@vibe-tavern/db";

/**
 * Thin adapter between the `CoauthorSkillsRuntimeApi` contract and the
 * {@link SkillLibraryService}. No business logic — the service owns root
 * resolution, atomic import, built-in-immutability enforcement, and the merged
 * catalog. The adapter only maps domain catalog entries to the wire DTO
 * (stripping absolute filesystem paths — only the portable root-relative
 * manifest path crosses the boundary) and applies the library's STORED ORDER
 * (ML-7) through {@link SkillOrderStore.applyOrder} — the one merge-rule
 * derivation. Skills are folders on disk with no row of their own, so the
 * order lives in the `skill_orders` table keyed by (library, skill id),
 * written by `reorderSkills` below.
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
	constructor(
		private readonly skillLibrary: SkillLibraryService,
		/** This library's stored order (ML-7) — its rows of the skill_orders table. */
		private readonly orderStore: SkillOrderStore,
		/** This library's order key (COAUTHOR_SKILL_LIBRARY here; the agent-kind
		 *  id on the copilot side — one key per library). */
		private readonly library: string,
	) {}

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
			// ML-7: the stored order (known ids in stored positions; unknown ids
			// last, alphabetical) — applied to the domain entries BEFORE the DTO
			// mapping, so ordering never depends on wire-only fields.
			entries: (await this.orderStore.applyOrder(this.library, entries)).map(toDto),
			// Surface malformed-manifest errors with the skill id (directory name)
			// instead of an absolute path, keeping filesystem internals off the wire.
			errors: errors.map((e) => ({
				source: e.source,
				id: e.skillDir.split(/[\\/]/).pop() ?? e.skillDir,
				reason: e.reason,
			})),
		};
	};

	/** Rewrite this library's stored order (ML-7) and serve the refreshed
	 *  catalog — the same envelope `listSkills` returns. */
	reorderSkills = async (updates: Array<{ id: string; sortOrder: number }>) => {
		await this.orderStore.reorder(this.library, updates);
		return await this.listSkills();
	};

	readSkill = async (id: string): Promise<SkillCatalogEntryDto | null> => {
		const entry = await this.skillLibrary.readCatalogEntry(id);
		return entry ? toDto(entry) : null;
	};

	readSkillContent = (id: string) => this.skillLibrary.readSkillContent(id);
}
