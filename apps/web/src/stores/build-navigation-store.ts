import { create } from "zustand";
import { randomUUID } from "../lib/uuid.js";

export type DiceScope =
  | { type: "chat"; id: string }
  | { type: "global" }
  | { type: "character"; id: string }
  | { type: "persona"; id: string };

export interface DiceCreateIntent {
  panel: "lorebook";
  tab: "scripts";
  action: "create";
  scriptKind: "dice";
  scope: DiceScope;
  template?: "fate_die";
  createIntentId: string;
}

export interface BuildNavigationState {
  diceCreateIntent: DiceCreateIntent | null;
  agentOpenIntent: { kind: "experience" | "script"; scriptId: string } | null;
}
export interface BuildNavigationActions {
  requestAgentOpen: (kind: "experience" | "script", scriptId: string) => void;
  consumeAgentOpen: (intent: NonNullable<BuildNavigationState["agentOpenIntent"]>) => void;
  requestDiceCreate: (input: Omit<DiceCreateIntent, "panel" | "tab" | "action" | "scriptKind" | "createIntentId">) => DiceCreateIntent;
  consumeDiceCreateIntent: () => DiceCreateIntent | null;
}
export type BuildNavigationStore = BuildNavigationState & BuildNavigationActions;

export const useBuildNavigationStore = create<BuildNavigationStore>()((set, get) => ({
  diceCreateIntent: null,
  agentOpenIntent: null,
  requestAgentOpen: (kind, scriptId) => set({ agentOpenIntent: { kind, scriptId } }),
  consumeAgentOpen: (intent) => { if (get().agentOpenIntent === intent) set({ agentOpenIntent: null }); },
  requestDiceCreate: (input) => {
    const intent: DiceCreateIntent = {
      ...input,
      panel: "lorebook",
      tab: "scripts",
      action: "create",
      scriptKind: "dice",
      createIntentId: randomUUID(),
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
