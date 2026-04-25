import { useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface UseDirtyStateResult {
  dirty: boolean;
  saveState: SaveState;
  markDirty: () => void;
  triggerSave: (saveFn?: () => void) => void;
  reset: () => void;
}

export function useDirtyState(): UseDirtyStateResult {
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  function markDirty(): void {
    setDirty(true);
  }

  function triggerSave(saveFn?: () => void): void {
    if (!dirty) return;
    setSaveState("saving");
    setTimeout(() => {
      saveFn?.();
      setDirty(false);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    }, 400);
  }

  function reset(): void {
    setDirty(false);
    setSaveState("idle");
  }

  return { dirty, saveState, markDirty, triggerSave, reset };
}
