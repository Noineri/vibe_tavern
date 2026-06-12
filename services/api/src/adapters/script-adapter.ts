import type { ScriptRuntimeApi } from "../routes/types.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { executeScripts } from "../scripts-engine/script-sandbox.js";

export class ScriptAdapter implements ScriptRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listScripts = (scopeType: string, ownerId?: string) =>
		this.stores.scripts.listByScope(scopeType, ownerId);

	getScript = (scriptId: string) =>
		this.stores.scripts.getById(scriptId);

	createScript = (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.create(body);

	updateScript = (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.update(scriptId, body);

	deleteScript = async (scriptId: string) => {
		await this.stores.scripts.delete(scriptId);
	};

	testScript = async (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => {
		const script = await this.stores.scripts.getById(scriptId);
		if (!script) throw new Error(`Script not found: ${scriptId}`);
		const messages = (body.messages && body.messages.length > 0) ? body.messages : (body.lastMessage ? [{ role: "user", content: body.lastMessage }] : []);
		const sandboxMessages = messages.map(m => ({ message: m.content, role: m.role }));
		const result = executeScripts({
			scripts: [{
				id: script.id,
				name: script.name,
				code: script.code,
				sortOrder: script.sortOrder,
			}],
			chat: {
				messages: sandboxMessages,
			},
			character: {
				name: body.characterName ?? "Assistant",
				personality: body.characterPersonality ?? "",
				scenario: body.characterScenario ?? "",
			},
			activeLoreEntries: [],
			scriptState: {},
		});
		return {
			personality: result.character.personality,
			scenario: result.character.scenario,
			state: result.updatedScriptState[scriptId] ?? {},
			errors: result.errors,
		};
	};

	importScript = async (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => {
		let name = body.name ?? "Imported Script";
		let code = "";
		if (body.format === "js" && body.code) {
			code = body.code;
		} else if (body.format === "json" && body.jsonText) {
			try {
				const parsed = JSON.parse(body.jsonText);
				if (typeof parsed === "object" && parsed !== null) {
					name = parsed.name ?? name;
					code = parsed.code ?? parsed.script ?? "";
				}
			} catch {
				throw new Error("Invalid JSON in script import");
			}
		}
		return this.stores.scripts.create({
			name,
			code,
			scopeType: body.scopeType ?? "character",
			characterId: body.characterId,
			personaId: body.personaId,
			chatId: body.chatId,
		});
	};
}
