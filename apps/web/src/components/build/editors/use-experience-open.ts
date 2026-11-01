import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { useAgentScriptOpen } from "../../../hooks/use-agent-script-open.js";
import { firstExistingBoundVisual } from "./experience-gallery-card.js";
import { isLocalId } from "./experience-local-helpers.js";

/** Existing mini-app selection/backfill, shared by gallery and notification
 * entry. The first bound visual wins only while no visual has been selected. */
export function useExperienceOpen(activeScriptId: string | null, activeVisualId: string | null,
  boundVisuals: Record<string, ExperienceVisualRow[]>, visuals: ExperienceVisualRow[],
  setActiveScriptId: (id: string) => void, setActiveVisualId: (id: string | null) => void,
  setScripts: Dispatch<SetStateAction<ScriptRecord[]>>,
) {
  const openScript = useCallback((scriptId: string) => {
    setActiveScriptId(scriptId);
    const first = firstExistingBoundVisual(boundVisuals[scriptId] ?? [], visuals);
    setActiveVisualId(first?.id ?? null);
  }, [boundVisuals, visuals, setActiveScriptId, setActiveVisualId]);
  useAgentScriptOpen("experience", (row) => {
    setScripts((rows) => [...rows.filter((item) => item.id !== row.id), row]);
    openScript(row.id);
  });
  useEffect(() => {
    if (!activeScriptId || isLocalId(activeScriptId) || activeVisualId !== null) return;
    const bound = boundVisuals[activeScriptId];
    if (!bound || bound.length === 0) return;
    const first = firstExistingBoundVisual(bound, visuals);
    if (first) setActiveVisualId(first.id);
  }, [activeScriptId, activeVisualId, boundVisuals, visuals, setActiveVisualId]);
  return openScript;
}
