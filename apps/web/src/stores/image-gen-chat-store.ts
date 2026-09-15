/**
 * Image-gen chat UI state (IMAGE_GENERATION_PLAN IG-16): the per-chat
 * "Fine tuning" toggle + the in-flight generation tracking that powers the
 * message-action Stop control. Plain zustand — UI state only, never canonical
 * data (the dictation-store precedent); profile POINTERs are chat-local
 * choices here, not server-side ui_settings.
 *
 * `activeProfileIdByChat` is the per-chat image-gen profile choice IG-2
 * deliberately kept out of the DB (no is_default column — the "active"
 * profile is a chat-level consumer concern). IG-17's fine-tuning chip reads
 * and writes the same map.
 *
 * One in-flight generation per chat (v1): starting a second while one runs
 * is prevented by the UI (the trigger morphs into Stop) and guarded here.
 * The AbortControllers live in a module-level map, NOT in zustand state —
 * controllers are imperative handles, not renderable state.
 */

import { create } from "zustand";
import { toast } from "sonner";

import { brandId, type ChatId } from "@vibe-tavern/domain";
import { generateImageGen } from "../api/image-gen-api.js";
import { fetchChatAction } from "./api-actions/chat-actions.js";
import type { GenerateImageGenInput } from "@vibe-tavern/api-contracts";

/** What the UI needs about a running generation (renderable projection —
 *  the AbortController stays in the module map below). */
export interface ImageGenRunState {
  mode: string;
  anchorMessageId: string;
}

interface ImageGenChatState {
  /** Per-chat "Fine tuning" toggle (default off — the IG-16 gate). */
  fineTuningByChat: Record<string, boolean>;
  /** Per-chat image-gen profile choice (undefined = first profile). */
  activeProfileIdByChat: Record<string, string | undefined>;
  /** ChatId → in-flight run; undefined = idle. */
  runningByChat: Record<string, ImageGenRunState | undefined>;
}

interface ImageGenChatActions {
  setFineTuning(chatId: string, on: boolean): void;
  setActiveProfile(chatId: string, profileId: string | undefined): void;
  /** Fire ONE generation (guarded one-per-chat); resolves when the run
   *  settles. User-aborts are silent; failures toast the normalized server
   *  message; success refreshes the chat through fetchChatAction. */
  runGeneration(chatId: string, input: GenerateImageGenInput): Promise<void>;
  /** Abort the chat's in-flight generation (the Stop control). The pending
   *  runGeneration settles silently via its AbortError path. */
  abortGeneration(chatId: string): void;
}

export type ImageGenChatStore = ImageGenChatState & ImageGenChatActions;

/** Imperative abort handles, keyed by chatId (kept OUT of zustand state). */
const controllers = new Map<string, AbortController>();

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const useImageGenChatStore = create<ImageGenChatStore>()((set, get) => ({
  fineTuningByChat: {},
  activeProfileIdByChat: {},
  runningByChat: {},

  setFineTuning: (chatId, on) => {
    set((s) => ({ fineTuningByChat: { ...s.fineTuningByChat, [chatId]: on } }));
  },

  setActiveProfile: (chatId, profileId) => {
    set((s) => ({ activeProfileIdByChat: { ...s.activeProfileIdByChat, [chatId]: profileId } }));
  },

  runGeneration: async (chatId, input) => {
    if (get().runningByChat[chatId] !== undefined || controllers.has(chatId)) return;
    const controller = new AbortController();
    controllers.set(chatId, controller);
    set((s) => ({
      runningByChat: {
        ...s.runningByChat,
        [chatId]: { mode: input.mode, anchorMessageId: input.anchorMessageId ?? "" },
      },
    }));
    try {
      await generateImageGen(chatId, input, controller.signal);
      // Still the current run (not aborted-and-restarted mid-flight).
      if (controllers.get(chatId) === controller) {
        controllers.delete(chatId);
        set((s) => {
          const next = { ...s.runningByChat };
          delete next[chatId];
          return { runningByChat: next };
        });
        // The server already appended the image slot — pull the fresh
        // snapshot through the standard chat refresh path.
        try {
          await fetchChatAction(brandId<ChatId>(chatId));
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Chat refresh failed");
        }
      }
    } catch (err) {
      if (controllers.get(chatId) === controller) {
        controllers.delete(chatId);
        set((s) => {
          const next = { ...s.runningByChat };
          delete next[chatId];
          return { runningByChat: next };
        });
        // User cancel is silent by design (the owner's explicit Stop — the
        // route maps it to a silent abort, not an error).
        if (!isAbortError(err)) {
          toast.error(err instanceof Error ? err.message : "Image generation failed");
        }
      }
    }
  },

  abortGeneration: (chatId) => {
    controllers.get(chatId)?.abort();
  },
}));

if (typeof window !== "undefined") {
  (window as { __useImageGenChatStore?: typeof useImageGenChatStore }).__useImageGenChatStore =
    useImageGenChatStore;
}
