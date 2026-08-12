import type { ScriptRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer, ExperienceVisualRow } from "@vibe-tavern/db";
import { testScript, parseScriptImport } from "../../domain/scripts-engine/script-test-service.js";

export class ScriptAdapter implements ScriptRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listAllScripts = () => this.stores.scripts.listAll();
	listScripts = (scopeType: string, ownerId?: string) =>
		this.stores.scripts.listByScope(scopeType, ownerId);

	getScript = (scriptId: string) =>
		this.stores.scripts.getById(scriptId);

	createScript = (body: { name: string; description?: string; code?: string; scriptKind?: string; creationIntentId?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.create({
			...body,
			// Interactive rules are trusted executable code. Publicly authored
			// revisions always begin disabled; app-owned seeds may still use the
			// lower-level store directly for their reviewed shipped source.
			enabled: body.scriptKind === "interactive" ? false : body.enabled,
		});

	updateScript = async (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number; defaultVisualId?: string | null }) => {
		const existing = await this.stores.scripts.getById(scriptId);
		if (existing?.scriptKind !== "interactive") return this.stores.scripts.update(scriptId, body);

		const sourceChanged = body.code !== undefined && body.code !== existing.code;
		// Enabling must name the exact reviewed source. A bare enabled=true can
		// race a concurrent source save and accidentally trust a different body.
		const lacksReviewedSource = body.enabled === true && body.code === undefined;
		return this.stores.scripts.update(
			scriptId,
			sourceChanged || lacksReviewedSource ? { ...body, enabled: false } : body,
		);
	};

	setScriptScope = (scriptId: string, scopeType: 'global' | 'character' | 'persona' | 'chat', ownerId: string | null) =>
		this.stores.scripts.setScope(scriptId, scopeType, ownerId);

	deleteScript = async (scriptId: string) => {
		await this.stores.scripts.delete(scriptId);
	};

	testScript = (scriptId: string, body: { code?: string; messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; personaName?: string; personaDescription?: string; lastMessage?: string }) => {
		const { personaName, personaDescription, ...rest } = body;
		const persona = personaName !== undefined ? { name: personaName, description: personaDescription ?? '' } : undefined;
		return testScript(this.stores, { scriptId, ...rest, persona });
	};

	importScript = async (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scriptKind?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => {
		const { name, code } = parseScriptImport(body);
		return this.stores.scripts.create({
			name,
			code,
			scriptKind: body.scriptKind,
			enabled: body.scriptKind === "interactive" ? false : undefined,
			scopeType: body.scopeType ?? "character",
			characterId: body.characterId,
			personaId: body.personaId,
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

	unbindScriptVisual = (scriptId: string, visualId: string): Promise<void> =>
		this.stores.scripts.unbindVisual(scriptId, visualId);
}
