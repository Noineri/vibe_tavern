import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot, PersonaRecord } from "./types.js";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { normalizeSnapshot } from "./normalize.js";

export async function listPersonas(): Promise<PersonaRecord[]> {
  const response = await client.api.personas.$get();
  return unwrapRpc<PersonaRecord[]>(response);
}

export async function createPersona(input: {
  name: string;
  description: string;
  pronouns?: string | null;
  defaultForNewChats?: boolean;
}): Promise<PersonaRecord> {
  const response = await client.api.personas.$post({ json: input });
  return unwrapRpc<PersonaRecord>(response);
}

export async function updatePersona(
  personaId: string,
  input: {
    chatId?: ChatId;
    name: string;
    description: string;
    pronouns?: string | null;
    avatarAssetId?: string | null;
    avatarFullAssetId?: string | null;
    avatarCropJson?: string | null;
  },
): Promise<AppSnapshot> {
  const response = await client.api.personas[":personaId"].$patch({ param: { personaId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  if (!data.character) return data;
  return normalizeSnapshot(data);
}

export async function deletePersona(personaId: string): Promise<void> {
  const response = await client.api.personas[":personaId"].$delete({ param: { personaId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function duplicatePersona(personaId: string): Promise<PersonaRecord> {
  const response = await client.api.personas[":personaId"].duplicate.$post({ param: { personaId } });
  return unwrapRpc<PersonaRecord>(response);
}

export async function setDefaultPersona(personaId: string): Promise<void> {
  await client.api.personas[":personaId"]["set-default"].$post({ param: { personaId } });
}
