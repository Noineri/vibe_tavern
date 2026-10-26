import type { CopilotProfileRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer, AgentProfileModel } from "@vibe-tavern/db";
import type {
  AgentProfileModelPutRequest,
  AgentProfileModelWire,
  CopilotProfile,
  CopilotProfileCreate,
  CopilotProfileUpdate,
} from "@vibe-tavern/api-contracts";
import { notFound, unprocessable, validation } from "../../shared/errors.js";
import { getAgentKind, UnknownAgentKindError } from "../../domain/agent/agent-kind-registry.js";
import {
  isBuiltinCopilotProfileId,
  isBuiltinCopilotProfileOfKind,
  resolveBuiltinCopilotProfile,
} from "../../domain/interactive/copilot/experience-copilot-module.js";
import { copilotProfileRowToWire } from "../../domain/interactive/copilot/copilot-profile-resolver.js";

/**
 * Thin adapter between the `CopilotProfileRuntimeApi` contract and the
 * `@vibe-tavern/db` `copilotProfiles` store (EXPERIENCE_COPILOT_PROFILES_PLAN,
 * Wave 3). Mirrors the co-author module adapter's role: built-in seeds are
 * code-defined (resolved via `resolveBuiltinCopilotProfile`), user profiles
 * are DB rows projected to the wire shape via `copilotProfileRowToWire`.
 * Built-in seeds are READ-ONLY — update/delete reject ANY built-in seed id
 * with a 400 (`isBuiltinCopilotProfileId`).
 *
 * AS-3 (per-kind profiles): lists filter by `agentKind` (default
 * `'experience'`); create validates the tool set against the owning kind's
 * `toolSetSchema` (422 `copilot_profile_invalid_tool_set`); update re-validates
 * a supplied tool set against the profile's OWN stored kind (the kind itself is
 * immutable — the update contract omits it and the store never writes it).
 *
 * DR-1: a kind ships a LIST of built-in seeds — the list serves ALL of the
 * kind's built-ins first (declared order, the descriptor's `builtinSeeds`)
 * before the kind's user rows, and `reorderCopilotProfiles` returns the same
 * envelope. User rows keep their stored manual order (ML-6) after the
 * built-ins.
 *
 * DR-2 (owner ruling M1): any profile — built-ins included — may carry its
 * OWN model (`{ providerProfileId, modelName }`), stored per (kind,
 * profile id) with no row meaning same as sidechat (the existing chain). The
 * model is a SETTING,
 * not an edit: set/clear is served for built-in seed ids too (the read-only
 * guard above protects prompt/tools only), and deleting a USER profile
 * removes its model row with it.
 */
export class CopilotProfileAdapter implements CopilotProfileRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	/** The kind's built-in seeds resolved in declared order (DR-1) — the
	 *  head of both list envelopes this adapter serves. */
	private async builtinProfiles(kind: string): Promise<CopilotProfile[]> {
		const descriptor = this.requireKind(kind);
		return Promise.all(
			descriptor.builtinSeeds.map((seed) =>
				resolveBuiltinCopilotProfile(descriptor.id, undefined, seed.id),
			),
		);
	}

	listCopilotProfiles = async (kind: string = "experience"): Promise<CopilotProfile[]> => {
		const descriptor = this.requireKind(kind);
		const [builtins, userRows] = await Promise.all([
			this.builtinProfiles(descriptor.id),
			this.stores.copilotProfiles.list(descriptor.id),
		]);
		return [...builtins, ...userRows.map(copilotProfileRowToWire)];
	};

	/** Rewrite one kind's user profiles' manual list order (ML-6) and serve
	 *  the refreshed merged list — the same envelope `listCopilotProfiles`
	 *  returns (every built-in seed first in declared order, then user rows
	 *  in the new stored order). */
	reorderCopilotProfiles = async (
		kind: string,
		updates: Array<{ id: string; sortOrder: number }>,
	): Promise<CopilotProfile[]> => {
		const descriptor = this.requireKind(kind);
		const [builtins, userRows] = await Promise.all([
			this.builtinProfiles(descriptor.id),
			this.stores.copilotProfiles.reorder(descriptor.id, updates),
		]);
		return [...builtins, ...userRows.map(copilotProfileRowToWire)];
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
		if (isBuiltinCopilotProfileId(id)) {
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
		if (isBuiltinCopilotProfileId(id)) {
			throw validation("The built-in profile is read-only.");
		}
		await this.stores.copilotProfiles.delete(id);
		// DR-2: the profile's own-model row dies with it — a dangling model row
		// keyed to a deleted profile can never resolve again, so the delete is
		// total (idempotent store call; never reached for built-in ids above).
		await this.stores.agentProfileModels.deleteForProfile(id);
	};

	// ── DR-2 (owner ruling M1): a profile's own model ─────────────────────

	getCopilotProfileModel = async (
		kind: string,
		profileId: string,
	): Promise<{ model: AgentProfileModelWire | null }> => {
		this.requireKind(kind);
		await this.requireAddressableProfile(kind, profileId);
		return { model: this.toModelWire(await this.stores.agentProfileModels.get(kind, profileId)) };
	};

	setCopilotProfileModel = async (
		kind: string,
		profileId: string,
		input: AgentProfileModelPutRequest,
	): Promise<{ model: AgentProfileModelWire }> => {
		this.requireKind(kind);
		await this.requireAddressableProfile(kind, profileId);
		const row = await this.stores.agentProfileModels.set(kind, profileId, {
			providerProfileId: input.providerProfileId,
			...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
		});
		return { model: this.toModelWire(row)! };
	};

	clearCopilotProfileModel = async (kind: string, profileId: string): Promise<{ ok: true }> => {
		this.requireKind(kind);
		await this.requireAddressableProfile(kind, profileId);
		await this.stores.agentProfileModels.clear(kind, profileId);
		return { ok: true };
	};

	/**
	 * The (kind, profile id) pair a model row may be keyed by: a built-in seed
	 * id the kind DECLARES (DR-1's list — `builtin-director` under
	 * `sidechat-ooc`, but a foreign kind's built-in id is NOT one of this
	 * kind's), or an existing user row of THIS kind. Anything else — a
	 * dangling user id, another kind's profile, another kind's built-in — is
	 * the shared not-found (the same fall-through shape the profile chains
	 * give dangling ids, surfaced as 404 at this management surface).
	 */
	private async requireAddressableProfile(kind: string, profileId: string): Promise<void> {
		if (isBuiltinCopilotProfileOfKind(profileId, kind)) return;
		const row = await this.stores.copilotProfiles.getById(profileId);
		if (row === null || row.agentKind !== kind) {
			throw notFound("CopilotProfile", `Copilot profile '${profileId}' of kind '${kind}' was not found.`);
		}
	}

	/** Project a stored own-model row onto the strict wire shape (the store
	 *  row's key/timestamp columns never ride the response). */
	private toModelWire(row: AgentProfileModel | null): AgentProfileModelWire | null {
		return row === null ? null : { providerProfileId: row.providerProfileId, modelName: row.modelName };
	}

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
