import type { CoauthorSkillsRuntimeApi, CopilotSkillsByKindRuntimeApi, SkillCatalogEntryDto } from "../contract/runtime-api.js";
import type { SkillCatalogEntry } from "../../domain/coauthor/skills/skill-scanner.js";
import type { SkillLibraryService, SkillSaveInput } from "../../domain/coauthor/skills/skill-library.js";
import type { SkillOrderStore } from "@vibe-tavern/db";
import { validation } from "../../shared/errors.js";
import { getAgentKind, UnknownAgentKindError } from "../../domain/agent/agent-kind-registry.js";
import type { AgentKindId } from "../../domain/agent/agent-kind.js";

/**
 * Thin adapter between the `CoauthorSkillsRuntimeApi` contract and a copilot-rooted
 * {@link SkillLibraryService} (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-5). Mirrors
 * {@link CoauthorSkillAdapter} exactly — no business logic; the service owns root
 * resolution, atomic import, built-in-immutability, and the merged catalog,
 * and {@link SkillOrderStore.applyOrder} supplies the stored order (ML-7). The
 * adapter only maps domain catalog entries to the wire DTO (stripping absolute
 * filesystem paths). The `library` order key is the AGENT KIND id — the same
 * string the per-kind routes resolve through the kind registry — so each kind
 * keeps its own stored order.
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
	constructor(
		private readonly skillLibrary: SkillLibraryService,
		/** This kind's stored order (ML-7) — its rows of the skill_orders table. */
		private readonly orderStore: SkillOrderStore,
		/** This library's order key: the agent-kind id (one key per kind). */
		private readonly library: string,
	) {}

	importSkills = (files: Parameters<CoauthorSkillsRuntimeApi["importSkills"]>[0]) =>
		this.skillLibrary.importSkills(files);

	deleteSkill = (id: string) => this.skillLibrary.deleteSkill(id);

	/** The save seam (AP-23a) — mirrors {@link CoauthorSkillAdapter}: the
	 *  service owns the whole operation; the adapter only maps the returned
	 *  entry to the wire DTO (stripping absolute paths). */
	saveSkill = async (input: SkillSaveInput): Promise<SkillCatalogEntryDto> =>
		toDto(await this.skillLibrary.saveSkill(input));

	listSkills = async () => {
		const { entries, errors } = await this.skillLibrary.listCatalog();
		return {
			// ML-7 (mirrors CoauthorSkillAdapter): the stored order (known ids in
			// stored positions; unknown ids last, alphabetical) applied to the
			// domain entries before the DTO mapping.
			entries: (await this.orderStore.applyOrder(this.library, entries)).map(toDto),
			errors: errors.map((e) => ({
				source: e.source,
				id: e.skillDir.split(/[\\/]/).pop() ?? e.skillDir,
				reason: e.reason,
			})),
		};
	};

	/** Rewrite this kind's stored order (ML-7) and serve the refreshed catalog
	 *  — the same envelope `listSkills` returns (mirrors CoauthorSkillAdapter). */
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

/**
 * The kind-keyed copilot-skills seam (AS-8d1): one adapter per agent kind,
 * each over that kind's OWN skill roots. Resolving a kind goes through the
 * agent-kind registry first, so an unknown kind is the SAME 400
 * `UNKNOWN_AGENT_KIND` the copilot-profile adapter returns (mirroring its
 * `requireKind`); never a silent fallback to another kind's roots. A kind the
 * registry knows but the table lacks (a future kind before its library is
 * wired) carries the same code, so clients see one error shape.
 */
export function createCopilotSkillKindResolver(
	adapters: ReadonlyMap<AgentKindId, CopilotSkillAdapter>,
): CopilotSkillsByKindRuntimeApi {
	return {
		copilotSkillsForKind: (kind: string) => {
			try {
				getAgentKind(kind);
			} catch (err) {
				if (err instanceof UnknownAgentKindError) {
					throw validation(`Unknown agent kind '${kind}'.`, { code: err.code });
				}
				throw err;
			}
			const adapter = adapters.get(kind);
			if (adapter === undefined) {
				// Registry-known but unwired — same code as an unknown id (one shape).
				throw validation(`No copilot skill library is wired for agent kind '${kind}'.`, {
					code: "UNKNOWN_AGENT_KIND",
				});
			}
			return adapter;
		},
	};
}
