import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PromptPresetDto } from "@rp-platform/domain";
import {
  createPromptPreset,
  deletePromptPreset,
  listPromptPresets,
  setChatPromptPreset,
  updatePromptPreset,
  type AppSnapshot,
} from "../app-client.js";
import type { ChatId } from "@rp-platform/domain";
import { bootstrapKeys, chatKeys } from "./query-keys.js";

function writePromptPresetsToBootstrap(qc: ReturnType<typeof useQueryClient>, list: PromptPresetDto[]): void {
  qc.setQueryData(bootstrapKeys.snapshot(), (current: unknown) => current ? { ...current as object, promptPresets: list } : current);
}

export function useLoadPromptPresetsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => listPromptPresets(),
    onSuccess: (list) => {
      writePromptPresetsToBootstrap(qc, list);
    },
  });
}

export function useCreatePromptPresetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createPromptPreset>[0]) => createPromptPreset(input),
    onSuccess: async () => {
      writePromptPresetsToBootstrap(qc, await listPromptPresets());
    },
  });
}

export function useUpdatePromptPresetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { presetId: string; patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">> }) =>
      updatePromptPreset(args.presetId, args.patch),
    onSuccess: async () => {
      writePromptPresetsToBootstrap(qc, await listPromptPresets());
    },
  });
}

export function useDeletePromptPresetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (presetId: string) => deletePromptPreset(presetId),
    onSuccess: async () => {
      writePromptPresetsToBootstrap(qc, await listPromptPresets());
    },
  });
}

export function useSetChatPromptPresetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; presetId: string }) => setChatPromptPreset(args.chatId, args.presetId),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}
