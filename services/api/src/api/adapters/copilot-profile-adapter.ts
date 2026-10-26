import type { CopilotProfileRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { CopilotProfile, CopilotProfileCreate, CopilotProfileUpdate } from "@vibe-tavern/api-contracts";
import { unprocessable, validation } from "../../shared/errors.js";
import { getAgentKind, UnknownAgentKindError } from "../../domain/agent/agent-kind-registry.js";
import { resolveBuiltinCopilotProfile } from "../../domain/interactive/copilot/experience-copilot-module.js";
import { copilotProfileRowToWire } from "../../domain/interactive/copilot/copilot-profile-resolver.js";

/** The built-in read-only seed profile id (EXPERIENCE_COPILOT_PROFILES_PLAN). */
const BUILTIN_PROFILE_ID = "builtin";

/**
 * Thin adapter between the `CopilotProfileRuntimeApi` contract and the
 * `@vibe-tavern/db` `copilotProfiles` store (EXPERIENCE_COPILOT_PROFILES_PLAN,
 * Wave 3). Mirrors the co-author module adapter's role: the built-in seed is
 * code-defined (resolved via `resolveBuiltinCopilotProfile`), user profiles are
 * DB rows projected to the wire shape via `copilotProfileRowToWire`. The
 * built-in seed is READ-ONLY — update/delete reject its id with a 400.
 *
 * AS-3 (per-kind profiles): lists filter by `agentKind` (default
 * `'experience'`); create validates the tool set against the owning kind's
 * `toolSetSchema` (422 `copilot_profile_invalid_tool_set`); update re-validates
 * a supplied tool set against the profile's OWN stored kind (the kind itself is
 * immutable — the update contract omits it and the store never writes it).
 */
export class CopilotProfileAdapter implements CopilotProfileRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listCopilotProfiles = async (kind: string = "experience"): Promise<CopilotProfile[]> => {
		const descriptor = this.requireKind(kind);
		const [builtin, userRows] = await Promise.all([
			resolveBuiltinCopilotProfile(descriptor.id),
			this.stores.copilotProfiles.list(descriptor.id),
		]);
		return [builtin, ...userRows.map(copilotProfileRowToWire)];
	};

	/** Rewrite one kind's user profiles' manual list order (ML-6) and serve
	 *  the refreshed merged list — the same envelope `listCopilotProfiles`
	 *  returns (seed first, then user rows in the new stored order). */
	reorderCopilotProfiles = async (
		kind: string,
		updates: Array<{ id: string; sortOrder: number }>,
	): Promise<CopilotProfile[]> => {
		const descriptor = this.requireKind(kind);
		const [builtin, userRows] = await Promise.all([
			resolveBuiltinCopilotProfile(descriptor.id),
			this.stores.copilotProfiles.reorder(descriptor.id, updates),
		]);
		return [builtin, ...userRows.map(copilotProfileRowToWire)];
	};

	createCopilotProfile = async (input: CopilotProfileCreate): Promise<CopilotProfile> => {
		// The create schema defaults a missing kind to 'experience' (the current
		// web client sends none), so `agentKind` is always a concrete string here.
		const agentKind = input.agentKind ?? "experience";
		const descriptor = this.requireKind(agentKind);
		this.requireToolSetForKind(descriptor.id, input.toolSet);
		return copilotProfileRowToWire(
			await this.stores.copilotProfiles.create({ ...input, agentKind: descriptor.id }),
		);
	};

	updateCopilotProfile = async (id: string, input: CopilotProfileUpdate): Promise<CopilotProfile> => {
		if (id === BUILTIN_PROFILE_ID) {
			throw validation("The built-in profile is read-only.");
		}
		if (input.toolSet !== undefined) {
			const row = await this.stores.copilotProfiles.getById(id);
			// A missing row falls through to the store's own not-found throw
			// below (unchanged behavior); only a present row is kind-checked.
			if (row !== null) this.requireToolSetForKind(row.agentKind, input.toolSet);
		}
		return copilotProfileRowToWire(await this.stores.copilotProfiles.update(id, input));
	};

	deleteCopilotProfile = async (id: string): Promise<void> => {
		if (id === BUILTIN_PROFILE_ID) {
			throw validation("The built-in profile is read-only.");
		}
		await this.stores.copilotProfiles.delete(id);
	};

	/**
	 * Resolve a kind id through the registry — an unknown kind is a 400
	 * carrying the registry error's machine-readable `code`
	 * (`UNKNOWN_AGENT_KIND`), never a silent fallback to another kind's seed.
	 */
	private requireKind(kind: string) {
		try {
			return getAgentKind(kind);
		} catch (err) {
			if (err instanceof UnknownAgentKindError) {
				throw validation(`Unknown agent kind '${kind}'.`, { code: err.code });
			}
			throw err;
		}
	}

	/** Reject a tool set the owning kind's schema does not accept (422). */
	private requireToolSetForKind(kind: string, toolSet: Record<string, boolean | undefined>): void {
		const descriptor = this.requireKind(kind);
		if (!descriptor.toolSetSchema.safeParse(toolSet).success) {
			throw unprocessable(`Tool set is not valid for agent kind '${descriptor.id}'.`, {
				code: "copilot_profile_invalid_tool_set",
			});
		}
	}
}
