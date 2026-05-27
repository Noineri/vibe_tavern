import {
  createPersona,
  deletePersona,
  duplicatePersona,
  updatePersona,
  type AppSnapshot,
} from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";
import { useChatDataStore } from "../chat-data-store.js";
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
    name: string;
    description: string;
    pronouns?: string | null;
    avatarAssetId?: string | null;
    avatarFullAssetId?: string | null;
  };
}): Promise<AppSnapshot> {
  const snapshot = await updatePersona(input.personaId, input.patch);
  useChatDataStore.getState().setSnapshot(snapshot);
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
