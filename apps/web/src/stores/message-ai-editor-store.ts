/**
 * Message AI editor — ephemeral UI store (MAE-43, MESSAGE_AI_EDITOR_PLAN Wave 4).
 *
 * Owns two pieces of modal-session state that must outlive any single
 * component: the open editor's target and the per-message starred variant
 * selections. The store lives at module level (NOT in component state), so
 * stars survive Virtuoso unmount/remount of message rows and `closeEditor`
 * alike — a star is cleared ONLY by an explicit user action or by the
 * successful merge-save path, both of which call `clearStars`.
 *
 * EPHEMERAL ONLY: no SQLite, no localStorage/persist middleware, no canonical
 * snapshot state. A page reload loses every star; that is intentional.
 *
 * KEY SHAPE: `starredVariantIdsByMessage` is keyed by the bare message ID —
 * no chat namespacing. `messages.id` is a single-column TEXT PRIMARY KEY
 * (packages/db/src/db-schema.ts), so message IDs are globally unique across
 * chats and branches; the same messageId can never appear in two chats. Star
 * VALUES are immutable `MessageVariantId`s (also a single-column PRIMARY KEY
 * on message_variants.id) — NEVER `variantIndex`, which is display order only
 * and is recompacted on variant deletion (SCENE_TRACKER_PLAN). When variants
 * are deleted/compacted, `pruneStaleStars` drops star entries whose ID no
 * longer exists, so a star can never silently retarget another variant.
 */
import { create } from "zustand";
import type { ChatId, MessageId, MessageVariantId } from "@vibe-tavern/domain";

export type MessageAiEditorMode = "message_edit" | "message_merge";

export interface MessageAiEditorTarget {
  targetChatId: ChatId;
  targetMessageId: MessageId;
  requestedMode: MessageAiEditorMode;
  /** Edit mode only: the immutable variant that was selected when the editor
   *  opened — the diff base for the guarded Apply. Always null for merge,
   *  whose sources are the current stars read at request time. */
  selectedSourceVariantId: MessageVariantId | null;
}

export type OpenMessageAiEditorArgs =
  | {
      requestedMode: "message_edit";
      targetChatId: ChatId;
      targetMessageId: MessageId;
      /** The variant selected on the message row when Edit was invoked. */
      selectedVariantId: MessageVariantId;
    }
  | {
      requestedMode: "message_merge";
      targetChatId: ChatId;
      targetMessageId: MessageId;
    };

export interface MessageAiEditorState {
  /** Null = editor closed. Opening replaces any previous target — only one
   *  editor can be open at a time. */
  target: MessageAiEditorTarget | null;
  /** Ordered star lists keyed by message ID. Order is insertion order (first
   *  starred first); membership is a set — toggling the same variant twice
   *  restores the pre-toggle state. A message with no stars has NO key. */
  starredVariantIdsByMessage: Record<string, MessageVariantId[]>;
}

export interface MessageAiEditorActions {
  openEditor: (args: OpenMessageAiEditorArgs) => void;
  /** Closes the editor and KEEPS all stars — closing is never a clear. */
  closeEditor: () => void;
  toggleStar: (messageId: MessageId, variantId: MessageVariantId) => void;
  /** The single clearing call: explicit user clearing AND the successful
   *  merge-save path (the Wave 5 modal calls this after the append-new-variant
   *  mutation succeeds). No-op when the message has no stars. */
  clearStars: (messageId: MessageId) => void;
  /** Drops starred IDs absent from `validVariantIds` (call after variant
   *  deletion/index compaction). Pure filtering: preserves the surviving
   *  order and NEVER adds or reassigns an ID. */
  pruneStaleStars: (messageId: MessageId, validVariantIds: readonly MessageVariantId[]) => void;
}

export type MessageAiEditorStore = MessageAiEditorState & MessageAiEditorActions;

export const useMessageAiEditorStore = create<MessageAiEditorStore>()((set) => ({
  target: null,
  starredVariantIdsByMessage: {},

  openEditor: (args) =>
    set({
      target: {
        targetChatId: args.targetChatId,
        targetMessageId: args.targetMessageId,
        requestedMode: args.requestedMode,
        selectedSourceVariantId:
          args.requestedMode === "message_edit" ? args.selectedVariantId : null,
      },
    }),

  closeEditor: () => set({ target: null }),

  toggleStar: (messageId, variantId) =>
    set((state) => {
      const next = { ...state.starredVariantIdsByMessage };
      const current = next[messageId] ?? [];
      if (current.includes(variantId)) {
        const remaining = current.filter((id) => id !== variantId);
        if (remaining.length === 0) {
          delete next[messageId];
        } else {
          next[messageId] = remaining;
        }
      } else {
        next[messageId] = [...current, variantId];
      }
      return { starredVariantIdsByMessage: next };
    }),

  clearStars: (messageId) =>
    set((state) => {
      if (!(messageId in state.starredVariantIdsByMessage)) return state;
      const next = { ...state.starredVariantIdsByMessage };
      delete next[messageId];
      return { starredVariantIdsByMessage: next };
    }),

  pruneStaleStars: (messageId, validVariantIds) =>
    set((state) => {
      const current = state.starredVariantIdsByMessage[messageId];
      if (!current) return state;
      const valid = new Set<MessageVariantId>(validVariantIds);
      const surviving = current.filter((id) => valid.has(id));
      const next = { ...state.starredVariantIdsByMessage };
      if (surviving.length === 0) {
        delete next[messageId];
      } else {
        next[messageId] = surviving;
      }
      return { starredVariantIdsByMessage: next };
    }),
}));

if (typeof window !== "undefined") window.__useMessageAiEditorStore = useMessageAiEditorStore;
