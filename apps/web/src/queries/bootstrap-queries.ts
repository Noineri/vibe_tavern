/**
 * TanStack Query hooks for bootstrap and persona loading.
 * Replaces manual loadBootstrap() and loadPersonas() in useRpPlatformApp.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bootstrapApp, listPersonas } from "../app-client.js";
import { bootstrapKeys, personaKeys } from "./query-keys.js";
import { useChatStore, useCharacterStore } from "../stores/index.js";
import { getT } from "../i18n/context.js";

// ---------------------------------------------------------------------------
// Bootstrap query
// ---------------------------------------------------------------------------

export function useBootstrapQuery() {
  return useQuery({
    queryKey: bootstrapKeys.snapshot(),
    queryFn: async () => {
      const boot = await bootstrapApp();

      // Write to stores — same logic as old loadBootstrap()
      useChatStore.getState().setActiveChatId(boot.initialChatId);
      useChatStore.getState().setSnapshot(boot.snapshot);
      useCharacterStore.getState().setPromptPresets(boot.promptPresets);
      useCharacterStore.getState().setActivePromptPresetId(
        boot.snapshot?.activeChat.promptPresetId ?? null,
      );
      useCharacterStore.getState().setIsFirstRun(
        boot.isFirstRun || import.meta.env.VITE_FORCE_FIRST_RUN === 'true',
      );

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
  const setPersonas = useCharacterStore((s) => s.setPersonas);

  return useQuery({
    queryKey: personaKeys.list(),
    queryFn: async () => {
      const personas = await listPersonas();
      setPersonas(personas);
      return personas;
    },
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
