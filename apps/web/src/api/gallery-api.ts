/**
 * Typed client for the character media-gallery endpoints
 * (MEDIA_GALLERY_BACKEND_PLAN). Mirrors the raw-`fetch` + mobile-token shape of
 * {@link uploadCharacterAvatar} / {@link uploadAsset}: these routes use manual
 * `parseBody` / `req.json` on the server, so the Hono RPC client does not model
 * them cleanly — raw fetch is the established pattern here.
 *
 * `CharacterAsset` (folder-resident: `gallery/{id}.{ext}`) comes from
 * @vibe-tavern/domain. The row `id` IS the file identifier — there is no
 * separate flat `assetId` (see CHARACTER_FOLDER_STORAGE).
 */
import type { CharacterAsset } from "@vibe-tavern/domain";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";

/** Absolute serve URL for a gallery image (`/api/characters/:id/assets/:rowId`). */
export function serveCharacterAssetUrl(characterId: string, rowId: string): string {
  return `${getGatewayBaseUrl()}/api/characters/${characterId}/assets/${rowId}`;
}

// ─── internal fetch helpers ─────────────────────────────────────────────

function authHeaders(): Record<string, string> | undefined {
  const token = getMobileToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

async function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return response;
}

/** Throw a typed error carrying the server's message. Used after jsonRequest. */
async function unwrapJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Gallery request failed (${response.status}): ${errorBody}`);
  }
  // 204 No Content (reorder / delete) — nothing to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ─── Gallery CRUD ───────────────────────────────────────────────────────

/** `GET /api/characters/:id/assets` — list a character's gallery images (ordered). */
export async function listCharacterAssets(characterId: string): Promise<CharacterAsset[]> {
  return unwrapJson<CharacterAsset[]>(await jsonRequest("GET", `/api/characters/${characterId}/assets`));
}

/** `POST /api/characters/:id/assets` — upload one image (multipart `file`). */
export async function uploadCharacterAsset(characterId: string, file: File): Promise<CharacterAsset> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${getGatewayBaseUrl()}/api/characters/${characterId}/assets`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  return unwrapJson<CharacterAsset>(response);
}

/** `PATCH /api/characters/:id/assets/:rowId` — edit caption, description, and/or per-image prompt inclusion (D7). */
export async function updateCharacterAsset(
  characterId: string,
  rowId: string,
  patch: { caption?: string; description?: string | null; includeInPrompt?: boolean },
): Promise<CharacterAsset> {
  return unwrapJson<CharacterAsset>(
    await jsonRequest("PATCH", `/api/characters/${characterId}/assets/${rowId}`, patch),
  );
}

/** `PUT /api/characters/:id/assets/reorder` — persist a new display order. */
export async function reorderCharacterAssets(characterId: string, orderedIds: string[]): Promise<void> {
  await unwrapJson<void>(await jsonRequest("PUT", `/api/characters/${characterId}/assets/reorder`, { orderedIds }));
}

/** `DELETE /api/characters/:id/assets/:rowId` — remove one image (file + row). */
export async function deleteCharacterAsset(characterId: string, rowId: string): Promise<void> {
  await unwrapJson<void>(await jsonRequest("DELETE", `/api/characters/${characterId}/assets/${rowId}`));
}

// ─── Vision describe ────────────────────────────────────────────────────

/**
 * `POST /api/characters/:id/assets/describe` — vision-describe gallery images.
 * Per-image: slow, may fail. Returns the ids that were updated and the ids
 * that failed (NOT optimistic — the store shows a per-image loading state and
 * writes results when this resolves).
 */
export async function describeCharacterAssets(
  characterId: string,
  assetRowIds?: string[],
): Promise<{ updated: string[]; failed: string[] }> {
  return unwrapJson<{ updated: string[]; failed: string[] }>(
    await jsonRequest(
      "POST",
      `/api/characters/${characterId}/assets/describe`,
      assetRowIds ? { assetRowIds } : {},
    ),
  );
}

/**
 * `POST /api/characters/:id/avatar/describe` — vision-describe the character's
 * avatar. Backend persists the result to `avatarDescription` via
 * `setMediaFields`; the returned description is also handed to the snapshot
 * refresh (see `describeAndApplyCharacterAvatar`).
 */
export async function describeCharacterAvatar(characterId: string): Promise<{ description: string }> {
  return unwrapJson<{ description: string }>(
    await jsonRequest("POST", `/api/characters/${characterId}/avatar/describe`),
  );
}

/** `POST /api/personas/:id/avatar/describe` — mirror of the character path. */
export async function describePersonaAvatar(personaId: string): Promise<{ description: string }> {
  return unwrapJson<{ description: string }>(
    await jsonRequest("POST", `/api/personas/${personaId}/avatar/describe`),
  );
}
