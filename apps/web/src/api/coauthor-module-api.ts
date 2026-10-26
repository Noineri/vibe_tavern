/**
 * Typed RPC client for the Co-Author module endpoints (CS-24; stored order
 * ML-5) — extracted from chat-api.ts for its size ratchet, the
 * copilot-profile-api.ts pattern. Chat-scoped module calls (assignment,
 * context links, apply) stay in chat-api.ts; this file owns the module
 * catalog CRUD + the manual list order.
 */
import type { CoauthorModule, CoauthorModuleCreate, CoauthorModuleUpdate } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

export async function listCoauthorModules(): Promise<CoauthorModule[]> {
  const response = await client.api.coauthor.modules.$get();
  const data = await unwrapRpc(response);
  return data.modules;
}

export async function createCoauthorModule(input: CoauthorModuleCreate): Promise<CoauthorModule> {
  const response = await client.api.coauthor.modules.$post({ json: input });
  return unwrapRpc(response);
}

export async function updateCoauthorModule(moduleId: string, input: CoauthorModuleUpdate): Promise<CoauthorModule> {
  const response = await client.api.coauthor.modules[":moduleId"].$patch({ param: { moduleId }, json: input });
  return unwrapRpc(response);
}

/** Rewrite the user modules' manual list order (ML-5). Mirrors
 *  `reorderProxies`' shape ({ updates: [{ id, sortOrder }] } via PATCH); the
 *  response is the refreshed merged module list — the same envelope
 *  `listCoauthorModules` unwraps. */
export async function reorderCoauthorModules(updates: Array<{ id: string; sortOrder: number }>): Promise<CoauthorModule[]> {
  const response = await client.api.coauthor.modules.reorder.$patch({ json: { updates } });
  const data = await unwrapRpc(response);
  return data.modules;
}

export async function deleteCoauthorModule(moduleId: string): Promise<void> {
  const response = await client.api.coauthor.modules[":moduleId"].$delete({ param: { moduleId } });
  if (!response.ok) throw await unwrapError(response);
}
