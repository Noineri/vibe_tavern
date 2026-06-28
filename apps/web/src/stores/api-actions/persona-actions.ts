import {
  createPersona,
  deletePersona,
  duplicatePersona,
  setDefaultPersona,
  updatePersona,
  type AppSnapshot,
} from "../../app-client.js";
import type { ChatId, PronounForms } from "@vibe-tavern/domain";
import { useSnapshotStore } from "../snapshot-store.js";
import { fetchPersonasAction } from "./bootstrap-actions.js";
import type { PersonaRecord } from "../../app-client.js";

export async function createPersonaAction(
  input: Parameters<typeof createPersona>[0]
): Promise<PersonaRecord> {
  const result = await createPersona(input);
  void fetchPersonasAction();
  return result;
}

export async function updatePersonaAction(input: {
  personaId: string;
  patch: {
    chatId?: ChatId;
    name?: string;
    description?: string;
    pronouns?: string | null;
    pronounForms?: PronounForms | null;
    avatarAssetId?: string | null;
    avatarFullAssetId?: string | null;
    avatarCropJson?: string | null;
    // Avatar-appearance prompt injection (MEDIA_GALLERY). Same out-of-band
    // PATCH path as the character side (see character-schema.ts comment);
    // mirror the client signature exactly.
    includeAvatarInPrompt?: boolean;
    avatarDescription?: string | null;
  };
}): Promise<AppSnapshot> {
  const snapshot = await updatePersona(input.personaId, input.patch);
  useSnapshotStore.getState().ingestSnapshot(snapshot);
  void fetchPersonasAction();
  return snapshot;
}

export async function deletePersonaAction(personaId: string): Promise<void> {
  await deletePersona(personaId);
  void fetchPersonasAction();
}

export async function duplicatePersonaAction(personaId: string): Promise<PersonaRecord> {
  const result = await duplicatePersona(personaId);
  void fetchPersonasAction();
  return result;
}

export async function setDefaultPersonaAction(personaId: string): Promise<void> {
  await setDefaultPersona(personaId);
  void fetchPersonasAction();
}
