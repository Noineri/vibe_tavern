import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AppCharacter, AppMessage, AppPersona } from "../app-client.js";
import { replaceUiMacros } from "../lib/macros.js";
import { countTokens } from "../utils/tokenizer.js";
import type { MacroContext } from "./snapshot-store.js";
import { useChatList, useSnapshotStore } from "./snapshot-store.js";
import { useChatStore } from "./chat-store.js";

// ---------------------------------------------------------------------------
// Backward-compatible selectors — now delegate to snapshot-store
// for reference stability via Immer. Remove after full migration.
// ---------------------------------------------------------------------------

/** @deprecated Use useSnapshotStore(s => s.messagesById[id]) directly */
export function useDisplayMessage(id: string): DisplayMessage | null {
  const message = useSnapshotStore((s) => s.messagesById[id]);
  const macroContext = useMacroContext();
  return useMemo((): DisplayMessage | null => {
    if (!message) return null;
    const displayContent = macroContext
      ? replaceUiMacros(message.content, macroContext)
      : message.content;
    return {
      ...message,
      displayContent,
      tokenCount: countTokens(displayContent),
    };
  }, [message, macroContext]);
}

/** @deprecated Use useSnapshotStore(s => s.messageOrder) directly */
export function useMessageOrder(): string[] {
  return useSnapshotStore((s) => s.messageOrder);
}

/** @deprecated Use focused snapshot-store selectors directly */
export function useChatMeta() {
  const character = useSnapshotStore((s) => s.character);
  const persona = useSnapshotStore((s) => s.persona);
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const branches = useSnapshotStore((s) => s.branches);
  const summaries = useSnapshotStore((s) => s.summaries);
  const chats = useChatList();
  const allCharacters = useSnapshotStore((s) => s.allCharacters);

  return useMemo(() => {
    if (!character || !activeChat) return null;
    return {
      character,
      persona,
      activeChat,
      activeBranch,
      branches,
      summaries,
      chats,
      allCharacters,
    };
  }, [character, persona, activeChat, activeBranch, branches, summaries, chats, allCharacters]);
}

/** @deprecated Use useSnapshotStore selectors for macro context */
export function useMacroContext(): MacroContext | null {
  return useSnapshotStore(
    useShallow((s) => {
      if (!s.character) return null;
      return {
        characterName: s.character.name,
        personaName: s.persona?.name ?? null,
        personaDescription: s.persona?.description ?? null,
      };
    }),
  );
}

/**
 * Subscribe to the active prompt trace.
 * Derives from snapshot-store.
 */
export function useActiveTrace(
  selectedTraceId: string | null,
): import("@vibe-tavern/domain").PromptTraceRecordDto | import("@vibe-tavern/domain").AssemblePromptResponse | null {
  return useSnapshotStore(
    useShallow((state) => {
      // Traces are branch-scoped. After a fork / activate-branch switch the
      // store still holds the previous branch's `promptTrace` + history (they
      // are only re-fetched lazily), so filter them against the ACTIVE branch
      // to avoid showing the old branch's token count / layers. `contextPreview`
      // is always assembled fresh for the active branch, so it is the safe
      // fallback when no trace exists for this branch yet.
      const activeBranchId = state.activeBranch?.id ?? null;
      const historyForBranch = activeBranchId
        ? state.promptTraceHistory.filter((trace) => trace.branchId === activeBranchId)
        : state.promptTraceHistory;
      const latestForBranch =
        state.promptTrace && state.promptTrace.branchId === activeBranchId
          ? state.promptTrace
          : null;
      const fromHistory =
        historyForBranch.find((trace) => trace.id === selectedTraceId) ??
        latestForBranch ??
        historyForBranch[0];
      if (fromHistory) return fromHistory;
      if (state.contextPreview) return state.contextPreview;
      return null;
    }),
  );
}

// ---------------------------------------------------------------------------
// Types (unchanged)
// ---------------------------------------------------------------------------

export interface DisplayMessage extends AppMessage {
  displayContent: string;
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Narrow per-message selectors (Wave A — render isolation)
// ---------------------------------------------------------------------------
//
// These subscribe only to the slices a single MessageBlock actually reads,
// returning primitives or reference-stable values so that a mutation on
// message B (a streaming tick, a variant swipe, a content edit) does NOT
// re-render MessageBlock A. The broad useChatMeta/useActiveGeneration
// selectors above remain for non-message consumers (Sidebar/Rail/TopBar/
// InputArea/pending singletons) that genuinely need many slices.
//
// The render-isolation invariant test (message-block-isolation.test.tsx)
// gates every future MessageBlock subscription against these contracts.

/**
 * The three slices MessageBlock reads for author rendering: the active
 * character + persona + the active chat id. Reference-stable via useMemo +
 * Immer structural sharing in snapshot-store, so a summary write / branch
 * rename / unrelated chat change does not re-mount author rendering.
 */
export interface MessageAuthorInfo {
  character: AppCharacter;
  persona: AppPersona | null;
  activeChatId: string;
}

export function useMessageAuthor(): MessageAuthorInfo | null {
  const character = useSnapshotStore((s) => s.character);
  const persona = useSnapshotStore((s) => s.persona);
  const activeChatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  return useMemo<MessageAuthorInfo | null>(() => {
    if (!character || !activeChatId) return null;
    return { character, persona, activeChatId };
  }, [character, persona, activeChatId]);
}

/**
 * Answers "is THIS message the one currently being streamed into?" as a
 * boolean primitive. Source-agnostic: reads the explicit streamingMessageId
 * identity field, so it returns the same answer whether one generation is
 * in flight (today) or a sequential queue is running (tomorrow) — the queue
 * runner writes the same field and no MessageBlock code changes.
 *
 * Primitive return → a non-target block's value is `false` across ticks,
 * so it never re-renders on a streaming tick.
 */
export function useIsStreamingTarget(messageId: string): boolean {
  return useChatStore((s) => {
    if (!s.activeChatId) return false;
    const gen = s.generations[s.activeChatId];
    return Boolean(gen?.isSending && gen.streamingMessageId === messageId);
  });
}

export interface StreamingRevealInfo {
  streamingText: string;
  revealedText: string;
  reasoningText: string;
}

/**
 * Module-level empty sentinel — reference-stable, so useShallow returns the
 * same ref for every non-target block and they never re-render.
 */
const EMPTY_STREAMING_REVEAL: StreamingRevealInfo = {
  streamingText: "",
  revealedText: "",
  reasoningText: "",
};

/**
 * Returns the streaming reveal/reasoning text, but ONLY for the message that
 * is currently the streaming target (see useIsStreamingTarget). Non-target
 * blocks receive the stable EMPTY_STREAMING_REVEAL sentinel and thus never
 * subscribe to the mutating generation object. Source-agnostic: keyed on
 * streamingMessageId, identical semantics today (single flight) and tomorrow
 * (sequential queue).
 */
export function useStreamingRevealedFor(messageId: string): StreamingRevealInfo {
  return useChatStore(
    useShallow((s) => {
      if (!s.activeChatId) return EMPTY_STREAMING_REVEAL;
      const gen = s.generations[s.activeChatId];
      if (!gen?.isSending || gen.streamingMessageId !== messageId) {
        return EMPTY_STREAMING_REVEAL;
      }
      return {
        streamingText: gen.streamingText,
        revealedText: gen.streamingRevealedText,
        reasoningText: gen.streamingReasoningText,
      };
    }),
  );
}
