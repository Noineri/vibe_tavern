import { create } from "zustand";

export interface DiceCreateIntent {
  panel: "lorebook";
  tab: "scripts";
  action: "create";
  scriptKind: "dice";
  scope: { type: "chat"; id: string } | { type: "global" } | { type: "character"; id: string } | { type: "persona"; id: string };
  template?: "fate_die";
  createIntentId: string;
}

export interface BuildNavigationState {
  diceCreateIntent: DiceCreateIntent | null;
}
export interface BuildNavigationActions {
  requestDiceCreate: (input: Omit<DiceCreateIntent, "panel" | "tab" | "action" | "scriptKind" | "createIntentId">) => DiceCreateIntent;
  consumeDiceCreateIntent: () => DiceCreateIntent | null;
}
export type BuildNavigationStore = BuildNavigationState & BuildNavigationActions;

export const useBuildNavigationStore = create<BuildNavigationStore>()((set, get) => ({
  diceCreateIntent: null,
  requestDiceCreate: (input) => {
    const intent: DiceCreateIntent = {
      ...input,
      panel: "lorebook",
      tab: "scripts",
      action: "create",
      scriptKind: "dice",
      createIntentId: crypto.randomUUID(),
    };
    set({ diceCreateIntent: intent });
    return intent;
  },
  consumeDiceCreateIntent: () => {
    const intent = get().diceCreateIntent;
    if (intent) {
      set({ diceCreateIntent: null });
    }
    return intent;
  },
}));
