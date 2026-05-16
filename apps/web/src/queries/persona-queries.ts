/**
 * TanStack Query hooks for persona CRUD operations.
 * Replaces manual loadPersonas() calls with targeted invalidation.
 */
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createPersona,
  deletePersona,
  updatePersona,
} from "../app-client.js";
import type { ChatId } from "@rp-platform/domain";
import { personaKeys } from "./query-keys.js";

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
        avatarFullAssetId?: string | null;
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
