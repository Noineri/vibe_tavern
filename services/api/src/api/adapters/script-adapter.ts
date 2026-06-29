import type { ScriptRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { testScript, parseScriptImport } from "../../domain/scripts-engine/script-test-service.js";

export class ScriptAdapter implements ScriptRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listAllScripts = () => this.stores.scripts.listAll();
	listScripts = (scopeType: string, ownerId?: string) =>
		this.stores.scripts.listByScope(scopeType, ownerId);

	getScript = (scriptId: string) =>
		this.stores.scripts.getById(scriptId);

	createScript = (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.create(body);

	updateScript = (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.update(scriptId, body);

	setScriptScope = (scriptId: string, scopeType: 'global' | 'character' | 'persona' | 'chat', ownerId: string | null) =>
		this.stores.scripts.setScope(scriptId, scopeType, ownerId);

	deleteScript = async (scriptId: string) => {
		await this.stores.scripts.delete(scriptId);
	};

	testScript = (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) =>
		testScript(this.stores, { scriptId, ...body });

	importScript = async (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => {
		const { name, code } = parseScriptImport(body);
		return this.stores.scripts.create({
			name,
			code,
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
}
