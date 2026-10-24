/**
 * Typed client for the copilot skill-library endpoints
 * (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 / CP-10, per-kind libraries
 * AS-8d1). Mirrors `skill-api.ts` (co-author skills) but against the copilot
 * routes (`client.api.copilot.skills…` and the `…/import` multipart upload
 * whose FIELD NAMES are the files' relative paths). Every call takes the
 * agent kind and sends it as `?kind=` — one library per kind.
 */
import type {
  SkillCatalog,
  SkillCatalogEntryDto,
  SkillContentDto,
  SkillImportResult,
  SkillSaveDto,
} from "@vibe-tavern/api-contracts";
import type { AgentKind } from "../lib/agent-host-registry.js";
import { apiFetch, client, getGatewayBaseUrl, getMobileToken } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/** `GET /api/copilot/skills?kind=` — one kind's merged metadata-only catalog (built-in + user). */
export async function listCopilotSkills(kind: AgentKind): Promise<SkillCatalog> {
  const response = await client.api.copilot.skills.$get({ query: { kind } });
  return unwrapRpc(response);
}

/** One kind-scoped skill entry URL (`?kind=` selects the library — the `:id`
 *  routes declare no query validator, so the hono client types reject `query`
 *  and these two calls go through `apiFetch` like the import below). */
function skillEntryUrl(kind: AgentKind, id: string): string {
  return `${getGatewayBaseUrl()}/api/copilot/skills/${encodeURIComponent(id)}?kind=${encodeURIComponent(kind)}`;
}

/** `GET /api/copilot/skills/:id?kind=` — one catalog entry of one kind's library, or `null` if absent. */
export async function readCopilotSkill(kind: AgentKind, id: string): Promise<SkillCatalogEntryDto | null> {
  const response = await apiFetch(skillEntryUrl(kind, id));
  if (response.status === 404) return null;
  return unwrapRpc(response);
}

/** `GET /api/copilot/skills/:id/content?kind=` — the AP-21 full content view
 *  (`{ id, path, content, body, files }`) of one kind's library, or `null`
 *  when the skill is absent. Lazy-loaded by the skill library detail pane. */
export async function readCopilotSkillContent(kind: AgentKind, id: string): Promise<SkillContentDto | null> {
  const response = await apiFetch(`${skillEntryUrl(kind, id)}/content`);
  if (response.status === 404) return null;
  return unwrapRpc(response);
}

/**
 * `POST /api/copilot/skills?kind=` — save a NEW user skill of one kind's
 * library (AP-23d): body `{ name, description, body }`; the folder id is
 * derived from the name and de-duplicated server-side. Goes through
 * `apiFetch` (not the treaty client) so the `?kind=` query is sent exactly
 * like every other kind-scoped mutation in this file.
 */
export async function createCopilotSkill(kind: AgentKind, input: SkillSaveDto): Promise<SkillCatalogEntryDto> {
  const token = getMobileToken();
  const response = await apiFetch(`${getGatewayBaseUrl()}/api/copilot/skills?kind=${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}

/**
 * `PUT /api/copilot/skills/:id?kind=` — save an EXISTING user skill of one
 * kind's library (AP-23d): same body; rewrites only that skill's SKILL.md.
 * A built-in id is rejected and a missing id is a 404 — both surface via
 * `unwrapError`. Same `apiFetch` + `?kind=` reason as the create above.
 */
export async function updateCopilotSkill(kind: AgentKind, id: string, input: SkillSaveDto): Promise<SkillCatalogEntryDto> {
  const token = getMobileToken();
  const response = await apiFetch(skillEntryUrl(kind, id), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}

/**
 * `DELETE /api/copilot/skills/:id?kind=` — remove one user skill directory
 * from one kind's library. A user shadow of a built-in is deletable; a pure
 * built-in is rejected (400).
 */
export async function deleteCopilotSkill(kind: AgentKind, id: string): Promise<{ id: string }> {
  const response = await apiFetch(skillEntryUrl(kind, id), { method: "DELETE" });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}

/**
 * `PATCH /api/copilot/skills/reorder?kind=` — rewrite ONE kind's skill
 * catalog's manual list order (ML-7; the order is stored server-side in the
 * skill_orders table keyed by the kind id, never local storage). Mirrors
 * `reorderCopilotProfiles`: the kind rides the query param — the reorder
 * route's query validator lets the typed hono client send `query` on a PATCH
 * (the dice.ts pattern) — and the response is the refreshed catalog, the
 * same envelope `listCopilotSkills` unwraps.
 */
export async function reorderCopilotSkills(
  kind: AgentKind,
  updates: Array<{ id: string; sortOrder: number }>,
): Promise<SkillCatalog> {
  const response = await client.api.copilot.skills.reorder.$patch({ query: { kind }, json: { updates } });
  return unwrapRpc(response);
}

/**
 * `POST /api/copilot/skills/import?kind=` — atomically import a skill tree
 * into one kind's library. Each file's FIELD NAME must be its relative path
 * (`<skill>/SKILL.md`, …). Returns the imported skill ids.
 */
export async function importCopilotSkills(kind: AgentKind, files: File[]): Promise<SkillImportResult> {
  const formData = new FormData();
  for (const file of files) {
    const relativePath = file.webkitRelativePath && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name;
    formData.append(relativePath, file);
  }
  const token = getMobileToken();
  const response = await apiFetch(`${getGatewayBaseUrl()}/api/copilot/skills/import?kind=${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Skill import failed (${response.status}): ${errorBody}`);
  }
  return (await response.json()) as SkillImportResult;
}
