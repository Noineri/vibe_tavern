/**
 * TanStack Query hooks for provider profile domain.
 * All server state reads go through useQuery; all writes go through useMutation
 * with automatic cache invalidation.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  activateProviderProfile,
  addFavoriteProviderModel,
  deleteProviderProfile,
  fetchModelsByEndpoint,
  fetchProviderProfile,
  fetchProviderProfileModels,
  listFavoriteProviderModels,
  listProviderProfiles,
  removeFavoriteProviderModel,
  saveProviderProfile,
  testProfileChat,
  testProviderChat,
  testProviderDraft,
  testProviderProfile,
  updateProviderProfile,
  type FavoriteProviderModelRecord,
  type ProviderProfileRecord,
  type TestChatResponse,
} from "../app-client.js";
import type { ProviderProbeResponse } from "@rp-platform/domain";
import { providerKeys } from "./query-keys.js";

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

export function useProviderProfilesQuery() {
  return useQuery({
    queryKey: providerKeys.list(),
    queryFn: () => listProviderProfiles(),
  });
}

export function useProviderProfileDetailQuery(profileId: string | null) {
  return useQuery({
    queryKey: providerKeys.detail(profileId ?? ""),
    queryFn: () => fetchProviderProfile(profileId!),
    enabled: Boolean(profileId),
  });
}

export function useProviderModelsQuery(profileId: string | null) {
  return useQuery({
    queryKey: providerKeys.models(profileId ?? ""),
    queryFn: () => fetchProviderProfileModels(profileId!),
    enabled: Boolean(profileId),
  });
}

export function useFavoriteModelsQuery(profileId: string | null) {
  return useQuery({
    queryKey: providerKeys.favorites(profileId ?? ""),
    queryFn: () => listFavoriteProviderModels(profileId!),
    enabled: Boolean(profileId),
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useSaveProviderProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof saveProviderProfile>[0]) =>
      saveProviderProfile(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: providerKeys.list() });
    },
  });
}

export function useUpdateProviderProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof updateProviderProfile>[1] }) =>
      updateProviderProfile(args.id, args.patch),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: providerKeys.list() });
      void qc.invalidateQueries({ queryKey: providerKeys.detail(variables.id) });
    },
  });
}

export function useDeleteProviderProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProviderProfile(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: providerKeys.list() });
    },
  });
}

export function useActivateProviderProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => activateProviderProfile(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: providerKeys.list() });
    },
  });
}

export function useTestProviderProfileMutation() {
  return useMutation({
    mutationFn: (id: string) => testProviderProfile(id),
  });
}

export function useTestProviderDraftMutation() {
  return useMutation({
    mutationFn: (input: { endpoint: string; apiKey: string; providerType?: string }) =>
      testProviderDraft(input),
  });
}

export function useTestProfileChatMutation() {
  return useMutation({
    mutationFn: (args: { profileId: string; model: string }) =>
      testProfileChat(args.profileId, args.model),
  });
}

export function useTestProviderChatMutation() {
  return useMutation({
    mutationFn: (args: { baseUrl: string; apiKey: string; model: string; providerType?: string }) =>
      testProviderChat(args.baseUrl, args.apiKey, args.model, args.providerType),
  });
}

export function useFetchModelsByEndpointMutation() {
  return useMutation({
    mutationFn: (args: { baseUrl: string; apiKey?: string; providerType?: string }) =>
      fetchModelsByEndpoint(args.baseUrl, args.apiKey, args.providerType),
  });
}

export function useToggleFavoriteModelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      profileId: string;
      modelId: string;
      label?: string | null;
      contextLength?: number | null;
      removing: boolean;
    }) => {
      if (args.removing) {
        await removeFavoriteProviderModel(args.profileId, args.modelId);
        return null;
      }
      return addFavoriteProviderModel(args.profileId, {
        modelId: args.modelId,
        label: args.label,
        contextLength: args.contextLength,
      });
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: providerKeys.favorites(variables.profileId) });
    },
  });
}

export function useRefreshProviderProfilesMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Just invalidate — the queries will refetch automatically
      return true;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: providerKeys.list() });
    },
  });
}

// ---------------------------------------------------------------------------
// Re-export types used by the hook
// ---------------------------------------------------------------------------

export type { FavoriteProviderModelRecord, ProviderProfileRecord, TestChatResponse };
export type { ProviderProbeResponse };
