/**
 * TanStack Query hooks for character CRUD operations.
 * Replaces manual loading state and loadBootstrap() calls with mutations + targeted invalidation.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  archiveCharacter,
  createCharacter,
  deleteCharacter,
  exportCharacter,
  exportChatJsonl,
  exportPromptTrace,
  importJson,
  unarchiveCharacter,
  updateCharacter,
  updateCharacterAvatar,
  uploadAsset,
  type ImportJsonResponse,
} from "../app-client.js";
import type { ChatId } from "@rp-platform/domain";
import { bootstrapKeys, characterKeys } from "./query-keys.js";

// ---------------------------------------------------------------------------
// Character mutations
// ---------------------------------------------------------------------------

export function useSaveCharacterMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      characterId: string;
      patch: Parameters<typeof updateCharacter>[1];
    }) => updateCharacter(input.characterId, input.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

export function useCreateCharacterMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createCharacter>[0]) =>
      createCharacter(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

export function useArchiveCharacterMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (characterId: string) => archiveCharacter(characterId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

export function useUnarchiveCharacterMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (characterId: string) => unarchiveCharacter(characterId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

export function useDeleteCharacterMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (characterId: string) => deleteCharacter(characterId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

export function useAvatarUploadMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      characterId: string;
      chatId: ChatId;
    }) => {
      const asset = await uploadAsset(input.file);
      const snapshot = await updateCharacterAvatar(input.characterId, input.chatId, asset.assetId);
      return snapshot;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

export function useImportCharacterMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      fileName: string;
      jsonText: string;
      chatId?: ChatId;
    }) =>
      importJson({
        fileName: input.fileName,
        jsonText: input.jsonText,
        chatId: input.chatId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

// Fire-and-forget export mutations — no cache invalidation needed

export function useExportCharacterMutation() {
  return useMutation({
    mutationFn: (characterId: string) => exportCharacter(characterId),
  });
}

export function useExportChatJsonlMutation() {
  return useMutation({
    mutationFn: (chatId: ChatId) => exportChatJsonl(chatId),
  });
}

export function useExportPromptTraceMutation() {
  return useMutation({
    mutationFn: (traceId: string) => exportPromptTrace(traceId),
  });
}
