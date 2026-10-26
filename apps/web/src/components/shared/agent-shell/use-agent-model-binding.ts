import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import {
  agentOwnerKey,
  getAgentHost,
  type AgentKind,
} from "../../../lib/agent-host-registry.js";
import type { ProviderModel } from "../../../lib/provider-model-capabilities.js";
import { patchAgentKindSettings } from "../../../api/agent-kind-settings-api.js";
import { useProviderModels } from "../../../hooks/use-provider-models.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import {
  patchAgentKindSettingsAction,
  useBootstrapStore,
} from "../../../stores/api-actions/bootstrap-actions.js";

/**
 * Per-kind provider/model binding (SIDECHAT_PLAN SC-0e) — extracted from
 * `AgentShell.tsx` so every assistant keeps its own model choice.
 *
 * Resolution, in order — the kind's saved pair when the profile still
 * exists → the host's optional `defaultModelBinding(ctx)` → the first
 * available profile (today's fallback). A dangling saved id (deleted
 * profile) falls through to the next step, never blocks. The descriptor
 * hook is consulted ONLY when the kind has no usable saved provider, so a
 * user who never touched anything sees the same model as before the upgrade
 * (a kind without a row reads the legacy global pair through the bootstrap
 * map — owner decision 2).
 *
 * Writes PATCH only this kind's settings (`provider_profile_id`,
 * `model_name`); the global `ui_settings` pair is never written here
 * (other consumers of the legacy pair keep reading it untouched). The PATCH
 * result merges into the bootstrap store's per-kind map, so the sibling
 * assistant's hook (subscribed to its own kind entry) never re-resolves.
 *
 * One-shot restore (the pre-split shell's guarantee): once local state is
 * set, later store arrivals never clobber it — only an explicit picker
 * change writes. Store reads inside the async write callback go through
 * `useBootstrapStore.getState()` — render closures hold pre-action state.
 */
export function useAgentModelBinding(kind: AgentKind, owner: AgentThreadOwner): {
  providerProfileId: string | null;
  model: string | undefined;
  models: ProviderModel[];
  handleProviderChange: (profileId: string, nextModel?: string) => void;
} {
  const { t } = useT();
  const host = getAgentHost(kind);
  // The session effects key on the owner's logical identity, never on the
  // object identity — a fresh-but-equal owner literal must not re-resolve.
  // The ref carries the value (call args), the key carries the identity.
  const ownerKey = agentOwnerKey(owner);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const profiles = useProviderDataStore((s) => s.profiles);
  const saved = useBootstrapStore((s) => s.data?.agentKindSettings?.[kind]);
  const [providerProfileId, setProviderProfileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const { models } = useProviderModels(providerProfileId);

  // Which step resolved the provider — the model step honors the SAME
  // source (a saved model is only valid for a saved provider; the hook's
  // model only for the hook's provider). Set synchronously beside the
  // provider so the model effect (declared below, runs after) reads it in
  // the same commit.
  const providerSourceRef = useRef<"saved" | "hook" | "first" | null>(null);

  // The host's optional default, memoized so both restore effects share one
  // proposal. Gated on the saved provider: when the kind has a usable saved
  // provider the hook is never consulted (SC-0e — descriptor hook only
  // without a saved pair).
  const savedProviderId = saved?.providerProfileId ?? null;
  const savedProviderExists = savedProviderId !== null && profiles.some((p) => p.id === savedProviderId);
  const hookFallback = useMemo(() => {
    if (savedProviderExists) return undefined;
    return host.defaultModelBinding?.({ owner: ownerRef.current, profiles });
    // ownerKey carries the owner identity (the ref carries the value).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, ownerKey, profiles, savedProviderExists]);

  // Resolve the provider ONCE: the saved binding wins when it still exists;
  // a dangling/absent saved id falls through to the host default, then the
  // first available profile. (One effect — a separate "default" effect would
  // race the restore in the same commit, exactly the bug the pre-split
  // shell's single-effect shape fixed.)
  useEffect(() => {
    if (providerProfileId !== null) return;
    if (savedProviderExists && savedProviderId !== null) {
      providerSourceRef.current = "saved";
      setProviderProfileId(savedProviderId);
      return;
    }
    const fallbackId = hookFallback?.providerProfileId;
    if (fallbackId && profiles.some((p) => p.id === fallbackId)) {
      providerSourceRef.current = "hook";
      setProviderProfileId(fallbackId);
      return;
    }
    const first = profiles[0];
    if (first) {
      providerSourceRef.current = "first";
      setProviderProfileId(first.id);
    }
  }, [profiles, providerProfileId, savedProviderExists, savedProviderId, hookFallback]);

  // Same one-shot resolution for the model: the saved model when it is still
  // offered by the (restored) profile and the provider came from the saved
  // pair; the hook's model when the provider came from the hook; else the
  // first available model. A dangling model id falls through to the default.
  const savedModelName = saved?.modelName ?? null;
  const hookModelName = hookFallback?.modelName ?? null;
  useEffect(() => {
    if (model !== undefined) return;
    if (
      providerSourceRef.current === "saved" &&
      savedModelName &&
      models.some((m) => m.id === savedModelName)
    ) {
      setModel(savedModelName);
      return;
    }
    if (
      providerSourceRef.current === "hook" &&
      hookModelName &&
      models.some((m) => m.id === hookModelName)
    ) {
      setModel(hookModelName);
      return;
    }
    const first = models[0];
    if (first) setModel(first.id);
  }, [models, model, savedModelName, hookModelName]);

  const handleProviderChange = useCallback(
    (profileId: string, nextModel?: string) => {
      setProviderProfileId(profileId);
      setModel(nextModel);
      // Persist the explicit selection against THIS kind only (fire-and-
      // forget; a failure only means the next entry defaults again —
      // surfaced via toast for transparency).
      void patchAgentKindSettingsAction(
        kind,
        {
          ...(profileId ? { providerProfileId: profileId } : { providerProfileId: null }),
          ...(nextModel ? { modelName: nextModel } : { modelName: null }),
        },
        patchAgentKindSettings,
      ).catch(() => {
        toast.error(t("agent_binding_save_error"));
      });
    },
    [kind, t],
  );

  return { providerProfileId, model, models, handleProviderChange };
}
