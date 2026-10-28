import { createContext } from "react";

/** Begin explicit reading navigation; finish after the content's layout settles. */
export type RevealMessageStart = (target: HTMLElement) => () => void;

/** Scoped to one list: message rows never discover scrollers via global DOM queries. */
export const MessageScrollContext = createContext<RevealMessageStart | null>(null);
