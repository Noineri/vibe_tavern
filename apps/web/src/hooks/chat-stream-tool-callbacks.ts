/** Shared live/replay projection, extracted from the chat controller. */
import { coauthorReviewActivityFromResult, coauthorSkillReadOutputSchema, coauthorSearchOutputSchema, coauthorContextReadOutputSchema } from "@vibe-tavern/api-contracts";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import type { StreamOpts } from "../api/stream.js";

export function chatStreamToolCallbacks(chatId: string, isCurrent = () => true): Pick<StreamOpts, "onToolCall" | "onToolInputStart" | "onToolResult"> {
  const upsert = (activity: Parameters<ReturnType<typeof useCoauthorTurnStore.getState>["upsertActivity"]>[1]) =>
    isCurrent() && useCoauthorTurnStore.getState().upsertActivity(chatId, activity);
  return {
    // Inputs and outputs merge into the same operation card (CED-5).
    onToolCall: (info) => upsert({ toolCallId: info.toolCallId, toolName: info.toolName, args: info.args, status: "streaming" }),
    onToolInputStart: (info) => upsert({ toolCallId: info.toolCallId, toolName: info.toolName, status: "streaming" }),
    onToolResult: (info) => {
      const base = { toolCallId: info.toolCallId, toolName: info.toolName };
      const proposal = coauthorReviewActivityFromResult({ ...base, result: info.output, isError: info.isError });
      if (proposal) { upsert(proposal); return; }
      // Reads are not proposals, but still render as successful activity cards.
      if (info.toolName === "read_skill_file") {
        const read = coauthorSkillReadOutputSchema.safeParse(info.output);
        upsert({ ...base, status: info.isError || !read.success ? "error" : "done", ...(read.success ? { readPath: read.data.path } : {}) });
        return;
      }
      if (info.toolName === "search_context") {
        const search = coauthorSearchOutputSchema.safeParse(info.output);
        upsert({ ...base, status: info.isError || !search.success ? "error" : "done", ...(search.success ? { search: { results: search.data.results } } : {}) });
        return;
      }
      if (info.toolName === "read_context_item") {
        const read = coauthorContextReadOutputSchema.safeParse(info.output);
        upsert({ ...base, status: info.isError || !read.success ? "error" : "done", ...(read.success ? { contextRead: { type: read.data.type, title: read.data.title } } : {}) });
        return;
      }
      upsert({ ...base, status: "error" });
    },
  };
}
