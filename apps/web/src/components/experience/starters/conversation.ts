/**
 * Conversation visual starter — the owner's finished Messenger (copilot
 * grounding report step 4a, owner 2026-10-06): a three-tab messenger (Chats /
 * Characters / Profile) whose every control is gated on the projected view.
 *
 * What it renders from the projected state: the chat list (previews, unread
 * badges, and the typing indicator from `state.typing`), character cards bound
 * to model seats (`state.models` names the model participants), an editable
 * user profile, and bottom sheets that submit `create_character` /
 * `create_chat` / `edit_profile`. Inside a chat the history renders each
 * message as a `{from, fromName, text}` bubble and the composer submits `reply`
 * with `{chatId, text}`; while a character's reply is pending the rules expose
 * no human action, so the composer locks and only the typing dots move — the
 * exact behavior the step-4a owner check pins (in the messenger, nothing can
 * be sent while the characters are replying).
 *
 * NO hard-coded provider access: the visual never calls an AI provider. The
 * composer only submits a `reply` intention through the bridge; the host routes
 * it (a character's response is a durable host effect on the character's model
 * seat, never a direct provider call from the frame). This keeps provider
 * access on the trusted host side of the boundary.
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK.
 * The source body is re-exported byte-exactly from the domain package (the
 * same constant the server seeds), mirroring the Breakout starter.
 */
import type { VisualStarter } from "./types.js";
import { CONVERSATION_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";

export { CONVERSATION_VISUAL_SOURCE };

export const conversationStarter: VisualStarter = {
  id: "conversation",
  label: "Conversation",
  description: "The owner's Messenger: your profile, characters bound to model seats, one-on-one and group chats; the composer locks while each character replies through its own model.",
  source: CONVERSATION_VISUAL_SOURCE,
  fixtures: {
    setup: {
      state: {
        role: "human", phase: "setup", userProfile: { name: "", bio: "" }, models: ["AI"],
        characters: [], chats: [], activeChatId: null, typing: null, characterLimit: 24, chatLimit: 12,
      },
      actions: [
        { type: "edit_profile", label: "Profile" },
        { type: "create_character", label: "New character" },
        { type: "finish", label: "Finish" },
      ],
      revision: 0, status: "active",
    },
    ordinary: {
      state: {
        role: "human", phase: "chat", userProfile: { name: "Alex", bio: "Night owl, quiet hours" }, models: ["AI"],
        characters: [{ id: 1, name: "Elias", description: "A calm scholar who answers slowly.", modelId: "ai_seat", modelLabel: "AI" }],
        chats: [{
          id: 1, name: "Elias", characterIds: [1], replyMode: "all", nextSpeaker: 0,
          messages: [
            { from: "you", characterId: null, fromName: "Alex", text: "Good evening." },
            { from: "character", characterId: 1, fromName: "Elias", text: "Good evening. What kept you?" },
          ],
          unread: 0, preview: "Elias: Good evening. What kept you?",
        }],
        activeChatId: 1, typing: null, characterLimit: 24, chatLimit: 12,
      },
      actions: [
        { type: "edit_profile", label: "Profile" },
        { type: "create_character", label: "New character" },
        { type: "delete_character", label: "Delete character" },
        { type: "create_chat", label: "New chat" },
        { type: "open_chat", label: "Open chat" },
        { type: "delete_chat", label: "Delete chat" },
        { type: "reply", label: "Send" },
        { type: "finish", label: "Finish" },
      ],
      revision: 6, status: "active",
    },
    pending: {
      state: {
        role: "human", phase: "chat", userProfile: { name: "Alex", bio: "Night owl, quiet hours" }, models: ["AI"],
        characters: [{ id: 1, name: "Elias", description: "A calm scholar who answers slowly.", modelId: "ai_seat", modelLabel: "AI" }],
        chats: [{
          id: 1, name: "Elias", characterIds: [1], replyMode: "all", nextSpeaker: 0,
          messages: [
            { from: "you", characterId: null, fromName: "Alex", text: "Good evening." },
            { from: "character", characterId: 1, fromName: "Elias", text: "Good evening. What kept you?" },
            { from: "you", characterId: null, fromName: "Alex", text: "Are you still there?" },
          ],
          unread: 0, preview: "You: Are you still there?",
        }],
        activeChatId: 1, typing: { chatId: 1, characterId: 1, characterName: "Elias" }, characterLimit: 24, chatLimit: 12,
      },
      // No legal action while a reply is pending — the composer stays locked.
      actions: [],
      revision: 7, status: "active",
    },
    error: {
      state: {
        role: "human", phase: "chat", userProfile: { name: "Alex", bio: "Night owl, quiet hours" }, models: ["AI"],
        characters: [{ id: 1, name: "Elias", description: "A calm scholar who answers slowly.", modelId: "ai_seat", modelLabel: "AI" }],
        chats: [{
          id: 1, name: "Elias", characterIds: [1], replyMode: "all", nextSpeaker: 0,
          messages: [
            { from: "you", characterId: null, fromName: "Alex", text: "Good evening." },
          ],
          unread: 0, preview: "You: Good evening.",
        }],
        activeChatId: 1, typing: null, characterLimit: 24, chatLimit: 12,
      },
      actions: [
        { type: "edit_profile", label: "Profile" },
        { type: "create_character", label: "New character" },
        { type: "delete_character", label: "Delete character" },
        { type: "create_chat", label: "New chat" },
        { type: "open_chat", label: "Open chat" },
        { type: "delete_chat", label: "Delete chat" },
        { type: "reply", label: "Send" },
        { type: "finish", label: "Finish" },
      ],
      revision: 8, status: "active",
    },
    completed: {
      state: {
        role: "human", phase: "chat", userProfile: { name: "Alex", bio: "Night owl, quiet hours" }, models: ["AI"],
        characters: [{ id: 1, name: "Elias", description: "A calm scholar who answers slowly.", modelId: "ai_seat", modelLabel: "AI" }],
        chats: [{
          id: 1, name: "Elias", characterIds: [1], replyMode: "all", nextSpeaker: 0,
          messages: [
            { from: "you", characterId: null, fromName: "Alex", text: "Good evening." },
            { from: "character", characterId: 1, fromName: "Elias", text: "Good evening. What kept you?" },
            { from: "character", characterId: 1, fromName: "Elias", text: "Rest well. We will speak tomorrow." },
          ],
          unread: 0, preview: "Elias: Rest well. We will speak tomorrow.",
        }],
        activeChatId: 1, typing: null, characterLimit: 24, chatLimit: 12,
      },
      actions: [],
      revision: 12, status: "completed",
    },
  },
};
