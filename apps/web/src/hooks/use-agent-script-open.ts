import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { listAllScripts } from "../api/script-api.js";
import type { ScriptRecord } from "../api/types.js";
import { useBuildNavigationStore } from "../stores/build-navigation-store.js";
import { useT } from "../i18n/context.js";

/** Resolve an Open intent against the current server list, never a stale scope
 * filter. Selection reuses each editor's normal draft/visual initialization. */
export function useAgentScriptOpen(kind: "experience" | "script", select: (row: ScriptRecord) => void, enabled = true): void {
  const intent = useBuildNavigationStore((s) => s.agentOpenIntent);
  const { t } = useT();
  const latest = useRef({ select, t });
  latest.current = { select, t };
  useEffect(() => {
    if (!enabled || intent?.kind !== kind) return;
    let mounted = true;
    void listAllScripts().then((rows) => {
      if (!mounted || useBuildNavigationStore.getState().agentOpenIntent !== intent) return;
      const row = rows.find((item) => item.id === intent.scriptId && (kind === "experience" ? item.scriptKind === "interactive" : item.scriptKind !== "interactive"));
      if (row) latest.current.select(row);
      else toast.error(latest.current.t("request_failed"));
      useBuildNavigationStore.getState().consumeAgentOpen(intent);
    }).catch((error: unknown) => {
      if (!mounted || useBuildNavigationStore.getState().agentOpenIntent !== intent) return;
      console.warn("[agent-run] opening script failed", error);
      toast.error(latest.current.t("request_failed"));
      useBuildNavigationStore.getState().consumeAgentOpen(intent);
    });
    return () => { mounted = false; };
  }, [intent, kind, enabled]);
}
