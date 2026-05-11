/**
 * TanStack Query hooks for persona CRUD operations.
 * Replaces manual loadPersonas() calls with useQuery + targeted invalidation.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createPersona,
  deletePersona,
  listPersonas,
  updatePersona,
  type PersonaRecord,
} from "../app-client.js";
import type { ChatId } from "@rp-platform/domain";
import { personaKeys } from "./query-keys.js";

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

export function usePersonaList() {
  return useQuery({
    queryKey: personaKeys.list(),
    queryFn: () => listPersonas(),
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreatePersonaMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createPersona>[0]) =>
      createPersona(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personaKeys.all() });
    },
  });
}

export function useUpdatePersonaMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      personaId: string;
      patch: {
        chatId?: ChatId;
        name: string;
        description: string;
        pronouns?: string | null;
        avatarAssetId?: string | null;
      };
    }) => updatePersona(input.personaId, input.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personaKeys.all() });
    },
  });
}

export function useDeletePersonaMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (personaId: string) => deletePersona(personaId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personaKeys.all() });
    },
  });
}
