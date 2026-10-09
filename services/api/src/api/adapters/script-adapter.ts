import type { ScriptRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer, ExperienceVisualRow } from "@vibe-tavern/db";
import type { ScriptKind } from "@vibe-tavern/domain";
import { conflict, notFound } from "../../shared/errors.js";
import { testScript, parseScriptImport } from "../../domain/scripts-engine/script-test-service.js";
import { resolveEffectiveDiceScripts } from "../../domain/scripts-engine/dice-script-service.js";
import { BUILTIN_EXPERIENCE_CATALOG } from "../../domain/interactive/builtin-experiences/index.js";

export class ScriptAdapter implements ScriptRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listAllScripts = () => this.stores.scripts.listAll();
	listScripts = (scopeType: string, ownerId?: string) =>
		this.stores.scripts.listByScope(scopeType, ownerId);

	listParticipatingScripts = async (chatId: string) => {
		// Fail-closed: the chat's character/persona pairing defines the bindings —
		// an unknown chat has no participating set.
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
		const bound = await this.stores.scripts.listParticipatingForChat(chat.characterId, chat.personaId, chatId);
		// No chat-local dice selection → the binding-based answer IS «Текущие»
		// (unchanged, attached-list semantics for both kinds).
		const { diceScriptIds } = chat.insightsConfig;
		if (!Array.isArray(diceScriptIds)) return bound;
		// Chat-local dice selection (LOREBOOK_LIST_FILTERS step 8): it REPLACES
		// the binding-resolved dice scripts at runtime, so «Текущие» shows exactly
		// what runs — the bound PROMPT scripts plus the selection resolved by the
		// SAME one-source rule the Dice runtime reads (`resolveEffectiveDiceScripts`
		// in dice-script-service.ts — never a second copy of the override rule).
		const effectiveDice = await resolveEffectiveDiceScripts(this.stores, {
			characterId: chat.characterId,
			personaId: chat.personaId,
			chatId,
			diceScriptIds,
		});
		return [
			...bound.filter((script) => script.scriptKind === "prompt"),
			...effectiveDice,
		].sort((a, b) => a.sortOrder - b.sortOrder);
	};

	getScript = (scriptId: string) =>
		this.stores.scripts.getById(scriptId);

	createScript = (body: { name: string; description?: string; code?: string; scriptKind?: ScriptKind; creationIntentId?: string; scopeType: string; links?: Array<{ targetType: string; targetId: string }>; chatId?: string; enabled?: boolean; sortOrder?: number; origin?: "imported" }) =>
		this.stores.scripts.create({
			...body,
			// Interactive rules are trusted executable code. Publicly authored
			// revisions always begin disabled; app-owned seeds may still use the
			// lower-level store directly for their reviewed shipped source.
			// Imported-origin creates arrive disabled for EVERY kind
			// (SCRIPT_SAFETY_PLAN decision 2): `origin: 'imported'` is the mini-app
			// file-import path (decision 9), and its trust moment can only be a
			// later explicit enable through updateScript — an `enabled: true` in the
			// same request never short-circuits the warning flow.
			enabled: body.origin === "imported" || body.scriptKind === "interactive" ? false : body.enabled,
		});

	updateScript = async (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number; defaultVisualId?: string | null; copilotProfileId?: string | null }) => {
		const existing = await this.stores.scripts.getById(scriptId);
		if (existing?.scriptKind !== "interactive") return this.stores.scripts.update(scriptId, body);

		// Reviewed-source gate (SCRIPT_SAFETY_PLAN decision 8): fires ONLY for
		// untrusted imports — origin 'imported' with no first enable yet. A
		// trusted script (created in VT, or imported and once enabled) edits
		// freely: a source change never disables it again.
		const untrustedImport = existing.origin === "imported" && existing.firstEnabledAt === null;
		if (!untrustedImport) return this.stores.scripts.update(scriptId, body);

		// Enabling must name the exact reviewed source. A bare enabled=true can
		// race a concurrent source save and accidentally trust a different body.
		const sourceChanged = body.code !== undefined && body.code !== existing.code;
		const lacksReviewedSource = body.enabled === true && body.code === undefined;
		return this.stores.scripts.update(
			scriptId,
			sourceChanged || lacksReviewedSource ? { ...body, enabled: false } : body,
		);
	};

	setScriptScope = (scriptId: string, scopeType: 'global' | 'entity' | 'chat', ownerId: string | null) =>
		this.stores.scripts.setScope(scriptId, scopeType, ownerId);

	deleteScript = async (scriptId: string) => {
		// Fix item 12: deleting a built-in script records a dismissal so the seed
		// never re-creates/re-binds what the user explicitly removed.
		const existing = await this.stores.scripts.getById(scriptId);
		const builtinId = existing?.extensions && typeof existing.extensions.builtinId === "string"
			? existing.extensions.builtinId
			: null;
		const entry = builtinId === null ? undefined : BUILTIN_EXPERIENCE_CATALOG.find((e) => e.id === builtinId);
		await this.stores.scripts.delete(scriptId);
		if (entry !== undefined) {
			await this.stores.experienceResources.dismissBuiltinExperience(entry.id, entry.visuals[0]!.stableKey);
		}
	};

	testScript = async (scriptId: string, body: { code?: string; messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; personaName?: string; personaDescription?: string; lastMessage?: string; warningAcknowledged?: boolean }) => {
		// Server gate where the script id is known (SCRIPT_SAFETY_PLAN decision
		// 14): an imported script that has never been enabled does not execute —
		// not even in the test panel — unless the request carries the
		// warning-acknowledged flag set by the web warning modal. Wire shape
		// follows the DiceBindError precedent: DomainError kind Conflict → 409
		// with the typed code in `details`.
		if (body.warningAcknowledged !== true) {
			const script = await this.stores.scripts.getById(scriptId);
			if (script !== null && script.origin === "imported" && script.firstEnabledAt === null) {
				throw conflict(
					"Script is imported and has never been enabled — acknowledge the import warning to run it",
					{ code: "script_not_enabled" },
				);
			}
		}
		const { personaName, personaDescription, warningAcknowledged: _ack, ...rest } = body;
		void _ack;
		const persona = personaName !== undefined ? { name: personaName, description: personaDescription ?? '' } : undefined;
		return testScript(this.stores, { scriptId, ...rest, persona });
	};

	importScript = async (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scriptKind?: ScriptKind; scopeType?: string; chatId?: string }) => {
		const { name, code } = parseScriptImport(body);
		return this.stores.scripts.create({
			name,
			code,
			scriptKind: body.scriptKind,
			// External content is never executable on arrival (SCRIPT_SAFETY_PLAN
			// decision 2): EVERY kind imports stamped 'imported' and disabled —
			// the first explicit enable through updateScript is the trust moment.
			origin: "imported",
			enabled: false,
			scopeType: body.scopeType ?? "entity",
			chatId: body.chatId,
		});
	};

	getScriptLinks = (scriptId: string) =>
		this.stores.scripts.getLinks(scriptId);

	setScriptLinks = (scriptId: string, links: Array<{ targetType: string; targetId: string }>) =>
		this.stores.scripts.setLinks(scriptId, links);

	// ── Visual bindings (script_visuals junction, BE-5) ──────────────────────

	getScriptVisuals = async (scriptId: string): Promise<ExperienceVisualRow[]> => {
		const ids = await this.stores.scripts.getBoundVisualIds(scriptId);
		const rows = await Promise.all(
			ids.map((id) => this.stores.experienceResources.getVisualById(id)),
		);
		// A bound id may resolve to null if the visual was deleted and the soft
		// default went stale; drop those rather than surfacing nulls to the UI.
		return rows.filter((v): v is ExperienceVisualRow => v !== null);
	};

	bindScriptVisual = (scriptId: string, visualId: string): Promise<void> =>
		this.stores.scripts.bindVisual(scriptId, visualId);

	unbindScriptVisual = async (scriptId: string, visualId: string) => {
		// Fix item 12: unbinding a built-in visual records a dismissal so the
		// seed never re-binds it on the next startup.
		const visual = await this.stores.experienceResources.getVisualById(visualId);
		const entry = visual === null
			? undefined
			: BUILTIN_EXPERIENCE_CATALOG.find((candidate) =>
				candidate.visuals.some((builtinVisual) => builtinVisual.stableKey === visual.stableKey),
			);
		await this.stores.scripts.unbindVisual(scriptId, visualId);
		if (entry !== undefined) {
			await this.stores.experienceResources.dismissBuiltinExperience(entry.id, visual!.stableKey!);
		}
	};
}
