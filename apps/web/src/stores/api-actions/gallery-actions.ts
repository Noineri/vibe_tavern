/**
 * Vision-describe the character / persona avatar and reflect the persisted
 * `avatarDescription` in the snapshot (MEDIA_GALLERY_FRONTEND F5).
 *
 * The describe endpoints return only `{ description }` — the backend persists
 * `avatarDescription` out-of-band via `setMediaFields`, so to make the frontend
 * see it we re-fetch the snapshot. `fetchBootstrapAction({ silent: true })` is
 * the established refresh path (same one `avatarUploadAction` uses after an
 * avatar upload): it re-fetches and `syncBootstrapSnapshotForActiveChat`
 * re-fetches the active chat's snapshot, so the editor's avatar-description
 * block picks up the new value.
 */
import { describeCharacterAvatar, describePersonaAvatar } from "../../app-client.js";
import { fetchBootstrapAction } from "./bootstrap-actions.js";

export async function describeAndApplyCharacterAvatar(characterId: string): Promise<string> {
  const { description } = await describeCharacterAvatar(characterId);
  await fetchBootstrapAction({ silent: true });
  return description;
}

export async function describeAndApplyPersonaAvatar(personaId: string): Promise<string> {
  const { description } = await describePersonaAvatar(personaId);
  await fetchBootstrapAction({ silent: true });
  return description;
}
