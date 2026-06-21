import type { ScriptRecord } from "./types.js";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

export async function listScripts(scopeType: string, ownerId?: string): Promise<ScriptRecord[]> {
  const response = await client.api.scripts.$get({ query: { scopeType, ownerId } });
  return unwrapRpc<ScriptRecord[]>(response);
}

export async function listAllScripts(): Promise<ScriptRecord[]> {
  const response = await client.api.scripts.all.$get();
  return unwrapRpc<ScriptRecord[]>(response);
}

export async function getScript(scriptId: string): Promise<ScriptRecord> {
  const response = await client.api.scripts[":scriptId"].$get({ param: { scriptId } });
  return unwrapRpc<ScriptRecord>(response);
}

export async function createScript(body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }): Promise<ScriptRecord> {
  const response = await client.api.scripts.$post({ json: body });
  return unwrapRpc<ScriptRecord>(response);
}

export async function updateScript(scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }): Promise<ScriptRecord> {
  const response = await client.api.scripts[":scriptId"].$patch({ param: { scriptId }, json: body });
  return unwrapRpc<ScriptRecord>(response);
}

export async function deleteScript(scriptId: string): Promise<void> {
  const response = await client.api.scripts[":scriptId"].$delete({ param: { scriptId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function testScript(scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }): Promise<{ personality: string; scenario: string; state: Record<string, unknown>; errors: string[] }> {
  const response = await client.api.scripts[":scriptId"].test.$post({ param: { scriptId }, json: body });
  return unwrapRpc<{ personality: string; scenario: string; state: Record<string, unknown>; errors: string[] }>(response);
}

export async function importScript(body: { format: "js"; code: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string } | { format: "json"; jsonText: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }): Promise<ScriptRecord> {
  const response = await client.api.scripts.import.$post({ json: body });
  return unwrapRpc<ScriptRecord>(response);
}
