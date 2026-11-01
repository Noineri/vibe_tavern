import { useEffect } from "react";
import { useBuildNavigationStore } from "../../../stores/build-navigation-store.js";
import { writeStickyWorldLoreTab, type Tab } from "./use-lorebook-editor-state.js";
import type { Scope } from "./LorebookAccordion.js";

/** Shared world-lore navigation preselection. The script editor consumes each
 * intent only after the requested browsing scope has reached its props. */
export function useBuildScriptIntents(tab: Tab, scope: Scope, setTab: (tab: Tab) => void, setScope: (scope: Scope) => void): void {
  const create = useBuildNavigationStore((s) => s.diceCreateIntent);
  const open = useBuildNavigationStore((s) => s.agentOpenIntent);
  useEffect(() => {
    if (!create && open?.kind !== "script") return;
    if (tab !== "scripts") {
      setTab("scripts");
      writeStickyWorldLoreTab("scripts");
    }
    const requested = open?.kind === "script" ? "all" : create!.scope.type as Scope;
    if (requested !== scope) setScope(requested);
  }, [create, open, tab, scope, setTab, setScope]);
}
