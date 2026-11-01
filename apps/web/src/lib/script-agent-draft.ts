/** Native code review over the same store/lifecycle adapter and API as the
 * mini-app. Only the kind namespace and single-buffer round mapping differ. */
import { streamScriptAgent, answerScriptAgentAsk } from "../api/script-agent-api.js";
import { createBufferAgentReviewPersistence } from "./buffer-agent-review-persistence.js";

const persistence = createBufferAgentReviewPersistence("script");
export const scriptAgentRuns = persistence.runs;

export const rehydrateScriptAgentDraft = (threadId: string): Promise<void> => persistence.hydrate(threadId);
export const syncPersistedScriptAgentRound = (threadId: string): Promise<void> => persistence.sync(threadId);
export const prepareScriptAgentReviewTurn = (threadId: string, signal: AbortSignal, code: string): Promise<void> =>
  persistence.prepare(threadId, signal, { rules: code, visual: "" });

export const streamPersistedScriptAgent: typeof streamScriptAgent = (threadId, body, opts) =>
  persistence.run(threadId, opts.signal, () => streamScriptAgent(threadId, body, opts));
export const answerPersistedScriptAgentAsk: typeof answerScriptAgentAsk = (threadId, body, opts) =>
  persistence.run(threadId, opts.signal, () => answerScriptAgentAsk(threadId, body, opts));
