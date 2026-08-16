/**
 * Typed client for the copilot skill-library endpoints
 * (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 / CP-10). Mirrors `skill-api.ts`
 * (co-author skills) but against the copilot routes (`client.api.copilot.skills…`
 * and the `…/import` multipart upload whose FIELD NAMES are the files' relative
 * paths).
 */
import type {
  SkillCatalog,
  SkillCatalogEntryDto,
  SkillImportResult,
} from "@vibe-tavern/api-contracts";
import { client, getGatewayBaseUrl, getMobileToken } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/** `GET /api/copilot/skills` — merged metadata-only catalog (built-in + user). */
export async function listCopilotSkills(): Promise<SkillCatalog> {
  const response = await client.api.copilot.skills.$get();
  return unwrapRpc<SkillCatalog>(response);
}

/** `GET /api/copilot/skills/:id` — one catalog entry, or `null` if absent. */
export async function readCopilotSkill(id: string): Promise<SkillCatalogEntryDto | null> {
  const response = await client.api.copilot.skills[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc<SkillCatalogEntryDto>(response);
}

/**
 * `DELETE /api/copilot/skills/:id` — remove one user skill directory. A user
 * shadow of a built-in is deletable; a pure built-in is rejected (400).
 */
export async function deleteCopilotSkill(id: string): Promise<{ id: string }> {
  const response = await client.api.copilot.skills[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc<{ id: string }>(response);
}

/**
 * `POST /api/copilot/skills/import` — atomically import a skill tree. Each
 * file's FIELD NAME must be its relative path (`<skill>/SKILL.md`, …). Returns
 * the imported skill ids.
 */
export async function importCopilotSkills(files: File[]): Promise<SkillImportResult> {
  const formData = new FormData();
  for (const file of files) {
    const relativePath = file.webkitRelativePath && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name;
    formData.append(relativePath, file);
  }
  const token = getMobileToken();
  const response = await fetch(`${getGatewayBaseUrl()}/api/copilot/skills/import`, {
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
