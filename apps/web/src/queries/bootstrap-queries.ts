/**
 * TanStack Query hooks for bootstrap and persona loading.
 * Replaces manual loadBootstrap() and loadPersonas() in useRpPlatformApp.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bootstrapApp, listPersonas } from "../app-client.js";
import { bootstrapKeys, chatKeys, personaKeys } from "./query-keys.js";
import { useChatStore } from "../stores/index.js";

// ---------------------------------------------------------------------------
// Bootstrap query
// ---------------------------------------------------------------------------

export function useBootstrapQuery() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: bootstrapKeys.snapshot(),
    queryFn: async () => {
      const boot = await bootstrapApp();

      if (boot.initialChatId && boot.snapshot) {
        qc.setQueryData(chatKeys.snapshot(boot.initialChatId), boot.snapshot);
      }
      useChatStore.getState().setActiveChatId(boot.initialChatId);

      return boot;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// Personas query
// ---------------------------------------------------------------------------

export function usePersonasQuery() {
  return useQuery({
    queryKey: personaKeys.list(),
    queryFn: () => listPersonas(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// Refetch helpers (used by retry button in app.tsx)
// ---------------------------------------------------------------------------

export function useRefetchBootstrap() {
  const qc = useQueryClient();
  return () => qc.refetchQueries({ queryKey: bootstrapKeys.snapshot() });
}
