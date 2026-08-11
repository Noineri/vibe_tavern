import type { ScriptRecord, ScriptLinkRecord } from "./types.js";
import type { ScriptKind } from "@vibe-tavern/domain";
import type { ScriptTestResult } from "@vibe-tavern/api-contracts";
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

export async function createScript(body: { name: string; description?: string; code?: string; scriptKind?: ScriptKind; creationIntentId?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }): Promise<ScriptRecord> {
  const response = await client.api.scripts.$post({ json: body });
  return unwrapRpc<ScriptRecord>(response);
}

export async function updateScript(scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number; defaultVisualId?: string | null }): Promise<ScriptRecord> {
  const response = await client.api.scripts[":scriptId"].$patch({ param: { scriptId }, json: body });
  return unwrapRpc<ScriptRecord>(response);
}

/** Reassign a script's scope atomically (PR-6 binding). `ownerId` is null/omitted for 'global'. */
export async function setScriptScope(scriptId: string, scopeType: "global" | "character" | "persona" | "chat", ownerId?: string | null): Promise<ScriptRecord> {
  const response = await client.api.scripts[":scriptId"].scope.$patch({ param: { scriptId }, json: { scopeType, ownerId: ownerId ?? null } });
  return unwrapRpc<ScriptRecord>(response);
}

export async function deleteScript(scriptId: string): Promise<void> {
  const response = await client.api.scripts[":scriptId"].$delete({ param: { scriptId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function testScript(scriptId: string, body: { code?: string; messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; personaName?: string; personaDescription?: string; lastMessage?: string }): Promise<ScriptTestResult> {
  const response = await client.api.scripts[":scriptId"].test.$post({ param: { scriptId }, json: body });
  return unwrapRpc<ScriptTestResult>(response);
}

export async function importScript(body: { format: "js"; code: string; name?: string; scriptKind?: ScriptKind; scopeType?: string; characterId?: string; personaId?: string; chatId?: string } | { format: "json"; jsonText: string; name?: string; scriptKind?: ScriptKind; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }): Promise<ScriptRecord> {
  const response = await client.api.scripts.import.$post({ json: body });
  return unwrapRpc<ScriptRecord>(response);
}

export async function getScriptLinks(scriptId: string): Promise<ScriptLinkRecord[]> {
  const response = await client.api.scripts[":scriptId"].links.$get({ param: { scriptId } });
  return unwrapRpc<ScriptLinkRecord[]>(response);
}

export async function setScriptLinks(scriptId: string, links: Array<{ targetType: "character" | "persona"; targetId: string }>): Promise<ScriptLinkRecord[]> {
  const response = await client.api.scripts[":scriptId"].links.$put({ param: { scriptId }, json: { links } });
  return unwrapRpc<ScriptLinkRecord[]>(response);
}
