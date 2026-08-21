/**
 * Conversation visual starter (IR-63) — compact history, composer, typing
 * state, and Finish.
 *
 * Suited to Messenger, radio, terminal, and mail experiences. Renders a scroll
 * of messages from the projected `state.messages` (each {from, text, partial}),
 * a composer (textarea + send) that submits a `reply` action carrying the typed
 * text, a typing indicator driven by the host's pending phase, and a Finish
 * control. A partial message reveals incrementally; once it arrives without
 * `partial`, it is the final full text.
 *
 * NO hard-coded provider access: the visual never calls an AI provider. The
 * composer only submits a `reply` intention through the bridge; the host routes
 * it (a model-controlled counterpart's response is a durable host effect, never
 * a direct provider call from the frame). This keeps provider access on the
 * trusted host side of the boundary.
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK.
 */
import type { VisualStarter } from "./types.js";
import { CONVERSATION_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";

export { CONVERSATION_VISUAL_SOURCE };

export const conversationStarter: VisualStarter = {
  id: "conversation",
  label: "Conversation",
  description: "Compact message history, composer, typing state, and Finish. Suited to Messenger, radio, terminal, and mail experiences.",
  source: CONVERSATION_VISUAL_SOURCE,
  fixtures: {
    setup: { state: { messages: [{ from: "them", text: "Connection established. Say hello." }] }, actions: [{ type: "reply" }], revision: 0, status: "active" },
    ordinary: { state: { messages: [{ from: "them", text: "Did you get the coordinates?" }, { from: "you", text: "Affirmative. Sending now." }] }, actions: [{ type: "reply" }, { type: "finish" }], revision: 2, status: "active" },
    pending: { state: { messages: [{ from: "them", text: "Did you get the coordinates?" }, { from: "you", text: "Affirmative. Sending now." }] }, actions: [], revision: 2, status: "active" },
    error: { state: { messages: [{ from: "them", text: "Did you get the coordinates?" }] }, actions: [{ type: "reply" }], revision: 2, status: "active" },
    completed: { state: { messages: [{ from: "them", text: "Understood. Closing channel." }] }, actions: [], revision: 6, status: "completed" },
  },
};
