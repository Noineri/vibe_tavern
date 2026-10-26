import { useMemo } from "react";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import type { AgentKind } from "../../../lib/agent-host-registry.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import type { MentionAutocompleteItem } from "../mention-autocomplete-query.js";

/**
 * The RP prompt-preset catalog arm (SC-23d) — the sidechat's `@` picker
 * group, offered per host: the sidechat only (the mini-app and script
 * assistants get the empty list, so they never offer preset pins).
 *
 * Folded in reactively from the bootstrap store, like the shell's character
 * fold: the Prompt Manager edits presets while a sidechat may stay open, so
 * a fetch-once arm would serve stale names — renames propagate to picker
 * rows and pin chips, and a deleted preset falls back to the raw id through
 * the shell's dangling pattern. Presets carry no description field, so rows
 * are label-only (the existing row shape, no hint).
 */
export function useAgentPresetCatalog(kind: AgentKind): MentionAutocompleteItem[] {
  const promptPresets = useBootstrapStore((s) => s.data?.promptPresets);
  return useMemo<MentionAutocompleteItem[]>(() => {
    if (kind !== SIDECHAT_AGENT_KIND) return [];
    return (promptPresets ?? []).map((p) => ({ targetType: "prompt_preset", id: p.id, label: p.name }));
  }, [kind, promptPresets]);
}
