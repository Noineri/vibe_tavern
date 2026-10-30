/** Shared live/replay projection, extracted from the chat controller. */
import { coauthorToolOutputSchema, coauthorSkillReadOutputSchema, coauthorLoreBundleOutputSchema, coauthorSearchOutputSchema, coauthorContextReadOutputSchema } from "@vibe-tavern/api-contracts";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import type { StreamOpts } from "../api/stream.js";

export function chatStreamToolCallbacks(chatId: string): Pick<StreamOpts, "onToolCall" | "onToolInputStart" | "onToolResult"> {
  const upsert = (activity: Parameters<ReturnType<typeof useCoauthorTurnStore.getState>["upsertActivity"]>[1]) =>
    useCoauthorTurnStore.getState().upsertActivity(chatId, activity);
  return {
    // Inputs and outputs merge into the same operation card (CED-5).
    onToolCall: (info) => upsert({ toolCallId: info.toolCallId, toolName: info.toolName, args: info.args, status: "streaming" }),
    onToolInputStart: (info) => upsert({ toolCallId: info.toolCallId, toolName: info.toolName, status: "streaming" }),
    onToolResult: (info) => {
      const base = { toolCallId: info.toolCallId, toolName: info.toolName };
      // Reads are not proposals, but still render as successful activity cards.
      if (info.toolName === "read_skill_file") {
        const read = coauthorSkillReadOutputSchema.safeParse(info.output);
        upsert({ ...base, status: info.isError || !read.success ? "error" : "done", ...(read.success ? { readPath: read.data.path } : {}) });
        return;
      }
      // The discriminator recognizes all lore mutations, not a tool-name list.
      const lore = coauthorLoreBundleOutputSchema.safeParse(info.output);
      if (lore.success) {
        upsert({ ...base, status: info.isError ? "error" : "done", loreBundle: lore.data.bundle, summary: lore.data.summary });
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
      const parsed = coauthorToolOutputSchema.safeParse(info.output);
      upsert({ ...base, status: info.isError || !parsed.success ? "error" : "done", ...(parsed.success ? {
        summary: parsed.data.summary, target: parsed.data.target, proposed: parsed.data.proposed,
        greetingIndex: parsed.data.greetingIndex, isAdd: parsed.data.isAdd,
      } : {}) });
    },
  };
}
