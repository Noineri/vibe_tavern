/**
 * Typed client for the Co-Author skill-library endpoints (CTX-S2 + CTX-S3 +
 * CTX-S7). The catalog / read / delete routes are plain JSON on both sides, so
 * they use the Hono treaty client (`client.api.coauthor.skills…`) like
 * chat-api. The import route is a multipart upload whose FIELD NAMES are the
 * files' relative paths (`<skill>/SKILL.md`, `<skill>/assets/…`) — the natural
 * shape a `webkitdirectory` input produces and the established pattern for
 * uploads in this client (see gallery-api's `uploadCharacterAsset`). It is sent
 * via raw `fetch` so the dynamic field names serialize exactly as given.
 *
 * Wire types (`SkillCatalog`, `SkillCatalogEntryDto`, `SkillImportResult`) are
 * the canonical definitions in @vibe-tavern/api-contracts.
 */
import type {
  SkillCatalog,
  SkillCatalogEntryDto,
  SkillContentDto,
  SkillImportResult,
  SkillSaveDto,
} from "@vibe-tavern/api-contracts";
import { apiFetch, client, getGatewayBaseUrl, getMobileToken } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/** `GET /api/coauthor/skills` — merged metadata-only catalog (built-in + user). */
export async function listCoauthorSkills(): Promise<SkillCatalog> {
  const response = await client.api.coauthor.skills.$get();
  return unwrapRpc(response);
}

/** `GET /api/coauthor/skills/:id` — one catalog entry, or `null` if absent. */
export async function readCoauthorSkill(id: string): Promise<SkillCatalogEntryDto | null> {
  const response = await client.api.coauthor.skills[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc(response);
}

/** `GET /api/coauthor/skills/:id/content` — the AP-21 full content view
 *  (`{ id, path, content, body, files }`), or `null` when the skill is
 *  absent. Lazy-loaded by the skill library detail pane. Goes through
 *  `apiFetch` (not the treaty client) so the URL is built the same way as
 *  every other `:id`-suffixed skill route in this file. */
export async function readCoauthorSkillContent(id: string): Promise<SkillContentDto | null> {
  const response = await apiFetch(`${getGatewayBaseUrl()}/api/coauthor/skills/${encodeURIComponent(id)}/content`);
  if (response.status === 404) return null;
  return unwrapRpc(response);
}

/**
 * `POST /api/coauthor/skills` — save a NEW user skill (AP-23d): body
 * `{ name, description, body }`; the folder id is derived from the name and
 * de-duplicated server-side. 201 + the fresh catalog entry DTO.
 */
export async function createCoauthorSkill(input: SkillSaveDto): Promise<SkillCatalogEntryDto> {
  const response = await client.api.coauthor.skills.$post({ json: input });
  return unwrapRpc(response);
}

/**
 * `PUT /api/coauthor/skills/:id` — save an EXISTING user skill (AP-23d):
 * same body; rewrites only that skill's SKILL.md. A built-in id is rejected
 * (409) and a missing id is a 404 — both surface via `unwrapError`.
 */
export async function updateCoauthorSkill(id: string, input: SkillSaveDto): Promise<SkillCatalogEntryDto> {
  const response = await client.api.coauthor.skills[":id"].$put({ param: { id }, json: input });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}

/**
 * `DELETE /api/coauthor/skills/:id` — remove one user skill directory. A user
 * shadow of a built-in is deletable; a pure built-in is rejected (400). The
 * reference guard (modules still binding this skill) is a frontend concern —
 * see `coauthor-skill-store.remove`.
 */
export async function deleteCoauthorSkill(id: string): Promise<{ id: string }> {
  const response = await client.api.coauthor.skills[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}

/**
 * `PATCH /api/coauthor/skills/reorder` — rewrite the skill catalog's manual
 * list order (ML-7; skills are folders on disk, so the order is stored
 * server-side in the skill_orders table, never local storage). Payload
 * mirrors `reorderProxies` ({ updates: [{ id, sortOrder }] }); the response
 * is the refreshed catalog — the same envelope `listCoauthorSkills`
 * unwraps (known ids in stored positions, unknown ids last, alphabetically).
 */
export async function reorderCoauthorSkills(
  updates: Array<{ id: string; sortOrder: number }>,
): Promise<SkillCatalog> {
  const response = await client.api.coauthor.skills.reorder.$patch({ json: { updates } });
  return unwrapRpc(response);
}

/**
 * `POST /api/coauthor/skills/import` — atomically import a skill tree. Each
 * file's FIELD NAME must be its relative path (`<skill>/SKILL.md`,
 * `<skill>/references/…`); the server validates the whole tree before writing.
 * Returns the imported skill ids (top-level dirs that contain a SKILL.md).
 */
export async function importCoauthorSkills(files: File[]): Promise<SkillImportResult> {
  const formData = new FormData();
  for (const file of files) {
    // `webkitRelativePath` is set by `<input webkitdirectory>` and is the
    // portable relative path including the selected folder name. It IS the
    // field name — self-describing, order-independent, no companion array.
    const relativePath = file.webkitRelativePath && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name;
    formData.append(relativePath, file);
  }
  const token = getMobileToken();
  const response = await apiFetch(`${getGatewayBaseUrl()}/api/coauthor/skills/import`, {
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
