import type { StoreContainer } from "@vibe-tavern/db";
import { executeScripts } from "./script-sandbox.js";

export interface ScriptTestInput {
	scriptId: string;
	messages?: Array<{ role: string; content: string }>;
	characterName?: string;
	characterPersonality?: string;
	characterScenario?: string;
	lastMessage?: string;
}

export interface ScriptTestResult {
	personality: string;
	scenario: string;
	state: Record<string, unknown>;
	errors: Array<{ scriptId: string; scriptName: string; error: string; line?: number }>;
}

export async function testScript(
	stores: StoreContainer,
	input: ScriptTestInput,
): Promise<ScriptTestResult> {
	const script = await stores.scripts.getById(input.scriptId);
	if (!script) throw new Error(`Script not found: ${input.scriptId}`);

	const messages =
		input.messages && input.messages.length > 0
			? input.messages
			: input.lastMessage
				? [{ role: "user", content: input.lastMessage }]
				: [];

	const sandboxMessages = messages.map((m) => ({ message: m.content, role: m.role }));

	const result = executeScripts({
		scripts: [
			{
				id: script.id,
				name: script.name,
				code: script.code,
				sortOrder: script.sortOrder,
			},
		],
		chat: { messages: sandboxMessages },
		character: {
			name: input.characterName ?? "Assistant",
			personality: input.characterPersonality ?? "",
			scenario: input.characterScenario ?? "",
		},
		activeLoreEntries: [],
		scriptState: {},
	});

	return {
		personality: result.character.personality,
		scenario: result.character.scenario,
		state: result.updatedScriptState[script.id] ?? {},
		errors: result.errors,
	};
}

export interface ParsedScriptImport {
	name: string;
	code: string;
}

export function parseScriptImport(
	body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string },
): ParsedScriptImport {
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

	return { name, code };
}
