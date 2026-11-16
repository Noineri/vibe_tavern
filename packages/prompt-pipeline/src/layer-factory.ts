/**
 * Shared layer factory for the prompt pipeline.
 *
 * Extracted from assemble.ts (arch-gate file-size ratchet): the generic
 * `PromptLayer` construction seam (`joinNonEmpty`, `makeLayer`) plus the
 * request-local one-shot instruction builder (director message tools DMT-12).
 * Pure module: no I/O, no imports beyond the package's own sources.
 */
import { estimateTokens } from "./compaction.js";
import {
  DEFAULT_PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_ID,
  PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_REASON,
  PROMPT_LAYER_SOURCE_TYPE,
} from "./prompt-layer-constants.js";
import type { PromptAssemblyContext, PromptLayer, PromptLayerPosition } from "./types.js";

export function joinNonEmpty(parts: Array<string | null | undefined>, separator = "\n"): string {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean).join(separator);
}

/**
 * Factory for creating a {@link PromptLayer} with sensible defaults.
 *
 * - `position` defaults to `"in_prompt"` when not specified.
 * - `priority` defaults to `DEFAULT_PROMPT_LAYER_PRIORITY` (0).
 */
export function makeLayer(input: {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceName?: string;
  position?: PromptLayerPosition;
  priority?: number;
  enabled?: boolean;
  reason?: string;
  role?: string;
  subPosition?: number;
  insertionOrder?: number;
  text: string;
  /** Pre-computed cost for this layer's text — skips the estimate call (`??`, so a passed 0 counts). */
  readonly tokenCount?: number;
}): PromptLayer {
  return {
    id: input.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceName: input.sourceName ?? input.sourceType,
    position: input.position ?? "in_prompt",
    priority: input.priority ?? DEFAULT_PROMPT_LAYER_PRIORITY,
    enabled: input.enabled ?? true,
    reason: input.reason ?? PROMPT_LAYER_REASON.included,
    tokenCount: input.tokenCount ?? estimateTokens(input.text),
    text: input.text.trim(),
    ...(input.role ? { role: input.role as "system" | "user" | "assistant" } : {}),
    ...(input.subPosition != null ? { subPosition: input.subPosition } : {}),
    ...(input.insertionOrder != null ? { insertionOrder: input.insertionOrder } : {}),
  };
}

/**
 * Request-local one-shot instruction (director message tools DMT-12): the
 * user-approved instruction for ONE regeneration (request_message_swipe
 * Allow), built as an ordinary `user` in_chat layer at depth 1 so it is
 * budgeted by the history-compaction planner (never free-floating), lands in
 * the stored layer trace, and follows the depth rule in the final interleave
 * — appending a raw provider message after assembly would bypass all three.
 *
 * Request-local by construction: the field is an assembly INPUT, so an
 * assembly without it emits nothing here and no later turn, manual swipe or
 * summary inherits it (the summary path additionally filters to
 * SUMMARY_LAYER_IDS, which never contains this id). The text is the approved
 * literal — no wrapper label, framed like every other user-authored
 * instruction layer in this pipeline; macros resolve in applyMacrosToContext
 * exactly as they do for every other user-authored text field.
 *
 * Returns `null` for an absent/null/blank instruction: the caller's output is
 * unchanged.
 */
export function buildRequestInstructionLayer(context: PromptAssemblyContext): PromptLayer | null {
  if (!context.requestInstruction?.trim()) return null;
  const layer = makeLayer({
    id: PROMPT_LAYER_ID.requestInstruction,
    sourceType: PROMPT_LAYER_SOURCE_TYPE.requestInstruction,
    sourceId: context.identity.chatId,
    sourceName: "Request Instruction",
    position: "in_chat",
    priority: PROMPT_LAYER_PRIORITY.requestInstruction,
    role: "user",
    reason: "included as the one-shot request-local instruction at depth 1",
    text: context.requestInstruction,
  });
  layer.injectionDepth = 1;
  return layer;
}
