/**
 * Copilot-profile resolution (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-6).
 *
 * Resolves the effective copilot profile for an experience (script): the
 * script's soft-linked `copilotProfileId` → the `copilot_profiles` row, with
 * the built-in read-only seed (CP-4) as the fallback for every "no profile"
 * case. The thread → script hop happens in the stream (which already loads the
 * thread for history) and hands the resolver its `scriptId`; this module owns
 * only the script → profile part so it stays unit-testable against a bare store
 * container.
 *
 * Fallback rule (zero behavior change for unassigned experiences): a null
 * scriptId, a missing script, a null/empty `copilotProfileId`, or a DANGLING id
 * (the profile row was deleted — the soft link is never FK-enforced) all resolve
 * to the built-in seed, exactly matching the pre-plan ER-16 module.
 *
 * SC-0f adds the chat-owned twin, `resolveForChat`: a chat-owned thread (no
 * script to hop through) resolves `chat_agent_settings.profile_id` (the
 * chat's own choice) → `agent_kind_settings.default_profile_id` (the kind's
 * default, SC-0d's column made a real consumer) → the kind's built-in seed.
 * The same dangling policy governs BOTH hops: a stored id pointing at a
 * deleted profile row falls through to the next step, never errors.
 */

import type { StoreContainer, CopilotProfileRow } from "@vibe-tavern/db";
import { COPILOT_TOOL_KEYS, SCRIPT_AGENT_TOOL_KEYS, SIDECHAT_OOC_TOOL_KEYS, type CopilotProfile, type CopilotToolSet, type ScriptAgentToolSet, type SidechatOocToolSet } from "@vibe-tavern/api-contracts";
import { resolveKindForScript } from "../../agent/agent-kind-registry.js";
import { BUILTIN_PROFILE_ID } from "../../agent/agent-kind.js";
import {
  isBuiltinCopilotProfileOfKind,
  resolveBuiltinCopilotProfile,
} from "./experience-copilot-module.js";

/**
 * The literal chat-row/default value pinning the FIRST built-in seed (SC-0k).
 * Built-ins are synthetic seeds, never DB rows, so seed ids ("builtin",
 * "builtin-director", …) cannot collide with a real `copilot_profiles` id
 * (user rows are store-minted `cprof_…`, and the strict create contract
 * carries no `id` field). DR-1 widened the acceptance test from this one
 * literal to the kind's declared seed list — see
 * {@link isBuiltinCopilotProfileOfKind}; the constant stays the first seed's
 * own id (the chain's final fallback resolves it).
 */
const BUILTIN_PROFILE_SENTINEL = BUILTIN_PROFILE_ID;

/**
 * Project a stored user-profile row into the wire `CopilotProfile` shape.
 * `isBuiltIn` is always false here (the built-in seed is code-defined, never a
 * row); `createdAt`/`updatedAt` are dropped (the wire profile has no timestamps).
 * The stored `toolSet` is a loose partial record — it is projected through
 * the OWNING KIND's wire-contract tool keys (AS-7: `script` rows project
 * through `SCRIPT_AGENT_TOOL_KEYS`; SC-5: `sidechat-ooc` rows through
 * `SIDECHAT_OOC_TOOL_KEYS`; everything else through `COPILOT_TOOL_KEYS`) so
 * only the kind's toggleable-tool keys (and only their `true` entries)
 * survive, producing a strict per-kind tool set.
 * `skillIds` is NOT projected (PM-8, owner ruling 2026-10-12): the skill
 * catalog is ungated, so the stored `skill_ids_json` column is legacy data
 * the resolver simply never reads. DR-7b adds `sourceBuiltinId`: a user
 * row emits its recorded provenance (null = none) so the web's starter
 * inheritance can resolve the source's starters; built-in seeds never
 * carry the field (they ARE the source, and their empty state is served
 * by their own presentation derivation).
 */
export function copilotProfileRowToWire(row: CopilotProfileRow): CopilotProfile {
	// Per-kind projection (AS-7): a script row projects through the script tool
	// keys, a sidechat row through the sidechat ones, everything else through
	// the experience keys — a union-typed key array cannot index one concrete
	// tool-set type, so the projections branch explicitly. Extend the branch
	// when a fourth kind registers.
	let toolSet: CopilotProfile["toolSet"];
	if (row.agentKind === "script") {
		const scriptToolSet: ScriptAgentToolSet = {};
		for (const key of SCRIPT_AGENT_TOOL_KEYS) {
			if (row.toolSet[key] === true) scriptToolSet[key] = true;
		}
		toolSet = scriptToolSet;
	} else if (row.agentKind === "sidechat-ooc") {
		const sidechatToolSet: SidechatOocToolSet = {};
		for (const key of SIDECHAT_OOC_TOOL_KEYS) {
			if (row.toolSet[key] === true) sidechatToolSet[key] = true;
		}
		toolSet = sidechatToolSet;
	} else {
		const copilotToolSet: CopilotToolSet = {};
		for (const key of COPILOT_TOOL_KEYS) {
			if (row.toolSet[key] === true) copilotToolSet[key] = true;
		}
		toolSet = copilotToolSet;
	}
	return {
		id: row.id,
		name: row.name,
		isBuiltIn: false,
		basePrompt: row.basePrompt,
		toolSet,
		agentKind: row.agentKind,
		sourceBuiltinId: row.sourceBuiltinId,
	};
}

/**
 * The built-in seed kind for a script row — the script kind's registered kind
 * (prompt/dice → `script`; interactive → `experience`), resolved through the
 * ONE sanctioned mapping seam (AS-8b: before this, every fallback hardcoded
 * the experience seed — unreachable for script threads pre-dispatch, wrong
 * the moment the stream began routing them). A null scriptId (a draft,
 * pre-save) and a missing/dangling row keep the experience seed (today's
 * draft semantics — drafts have no kind).
 */
async function builtinSeedKindForScript(
  stores: StoreContainer,
  scriptId: string | null,
): Promise<string> {
  if (scriptId === null) return "experience";
  const script = await stores.scripts.getById(scriptId);
  if (script === null) return "experience"; // dangling soft link — draft semantics
  return resolveKindForScript(script.scriptKind).id;
}

export class CopilotProfileResolver {
	constructor(private readonly stores: StoreContainer) {}

	/**
	 * Resolve the profile for a script. `scriptId === null` (a draft, pre-save)
	 * or any missing/dangling link falls back to the built-in seed — of the
	 * kind that SERVES the script row (AS-8b: prompt/dice scripts seed the
	 * `script` kind's builtin, interactive scripts the experience one).
	 */
	async resolveForScript(scriptId: string | null): Promise<CopilotProfile> {
		if (scriptId === null) return resolveBuiltinCopilotProfile("experience", this.stores.db);
		const script = await this.stores.scripts.getById(scriptId);
		const profileId = script?.copilotProfileId ?? null;
		if (profileId === null) {
			return resolveBuiltinCopilotProfile(await builtinSeedKindForScript(this.stores, scriptId), this.stores.db);
		}
		const row = await this.stores.copilotProfiles.getById(profileId);
		if (row === null) {
			return resolveBuiltinCopilotProfile(await builtinSeedKindForScript(this.stores, scriptId), this.stores.db);
		}
		return copilotProfileRowToWire(row);
	}

	/**
	 * Resolve the profile for a CHAT-OWNED thread's (chat, kind) pair (SC-0f):
	 * the chat's own choice (`chat_agent_settings.profile_id`, the "use here"
	 * override) → the kind-wide default (`agent_kind_settings
	 * .default_profile_id`, SC-0d's column — this chain is its first consumer)
	 * → the kind's built-in seed (`resolveBuiltinCopilotProfile(agentKind)` —
	 * the per-kind seed AS-3 made registry-backed; a registered kind without
	 * its own seed content gets the generic seed, never another kind's). Both
	 * stored hops follow the dangling policy: an id whose profile row was
	 * deleted falls through to the NEXT step (kind default, then built-in),
	 * never errors — the same soft-link rule as `resolveForScript`.
	 *
	 * SC-0k — the built-in pin, widened by DR-1: a chat choice holding ANY
	 * built-in seed id OF THIS KIND resolves THAT seed and NEVER falls through
	 * to the kind default (a chat can run a built-in while the default is a
	 * custom profile). A built-in id of ANOTHER kind is not one of this
	 * kind's — it falls through the row lookup exactly like a dangling id. A
	 * kind default holding a built-in id of the kind resolves that seed (the
	 * pre-DR-1 `"builtin"` reads-as-null outcome, now seed-aware); the final
	 * fallback is the kind's FIRST seed. Dangling CUSTOM ids still fall
	 * through at both hops.
	 */
	async resolveForChat(chatId: string, agentKind: string): Promise<CopilotProfile> {
		const chatChoice = await this.stores.chatAgentSettings.get(chatId, agentKind);
		if (
			chatChoice.profileId !== null &&
			isBuiltinCopilotProfileOfKind(chatChoice.profileId, agentKind)
		) {
			return resolveBuiltinCopilotProfile(agentKind, this.stores.db, chatChoice.profileId);
		}
		if (chatChoice.profileId !== null) {
			const chatRow = await this.stores.copilotProfiles.getById(chatChoice.profileId);
			if (chatRow !== null) return copilotProfileRowToWire(chatRow);
		}
		const kindDefault = await this.stores.agentKindSettings.get(agentKind);
		if (kindDefault.defaultProfileId !== null) {
			if (isBuiltinCopilotProfileOfKind(kindDefault.defaultProfileId, agentKind)) {
				return resolveBuiltinCopilotProfile(agentKind, this.stores.db, kindDefault.defaultProfileId);
			}
			const kindRow = await this.stores.copilotProfiles.getById(kindDefault.defaultProfileId);
			if (kindRow !== null) return copilotProfileRowToWire(kindRow);
		}
		return resolveBuiltinCopilotProfile(agentKind, this.stores.db, BUILTIN_PROFILE_SENTINEL);
	}
}
