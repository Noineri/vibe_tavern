import type { CopilotProfileRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { CopilotProfile, CopilotProfileCreate, CopilotProfileUpdate } from "@vibe-tavern/api-contracts";
import { validation } from "../../shared/errors.js";
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
 */
export class CopilotProfileAdapter implements CopilotProfileRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listCopilotProfiles = async (): Promise<CopilotProfile[]> => {
		const [builtin, userRows] = await Promise.all([
			resolveBuiltinCopilotProfile(),
			this.stores.copilotProfiles.list(),
		]);
		return [builtin, ...userRows.map(copilotProfileRowToWire)];
	};

	createCopilotProfile = async (input: CopilotProfileCreate): Promise<CopilotProfile> =>
		copilotProfileRowToWire(await this.stores.copilotProfiles.create(input));

	updateCopilotProfile = async (id: string, input: CopilotProfileUpdate): Promise<CopilotProfile> => {
		if (id === BUILTIN_PROFILE_ID) {
			throw validation("The built-in profile is read-only.");
		}
		return copilotProfileRowToWire(await this.stores.copilotProfiles.update(id, input));
	};

	deleteCopilotProfile = async (id: string): Promise<void> => {
		if (id === BUILTIN_PROFILE_ID) {
			throw validation("The built-in profile is read-only.");
		}
		await this.stores.copilotProfiles.delete(id);
	};
}
