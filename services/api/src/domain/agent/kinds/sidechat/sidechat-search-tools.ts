/**
 * The sidechat-OOC kind's context-search tools (SIDECHAT_PLAN Wave 3 / SC-10) —
 * the sidechat's own thin `search_context` / `read_context_item` twin of the
 * Co-Author's pair, over the SAME `ContextSearchSession` (created per turn by
 * the stream's buildTools seam with the ONE extracted store-reads mapping, no
 * Co-Author skill catalog, and the branch view the turn's sync already read —
 * `sidechat-stream.ts` wires it; see there for the "one view per turn" rule).
 *
 * Result count is the session's own `DEFAULT_SEARCH_LIMIT` (the shared,
 * owner-fixed default — owner decision 5, SIDECHAT_PLAN), and the outputs keep
 * the Co-Author's exact shapes so the tool cards' captions (SC-13) parse them
 * through the same `parseAgentToolOutput` path.
 *
 * fork #1 of coauthor-tools.ts search_context/read_context_item
 * (services/api/src/domain/chat/coauthor-tools.ts:563-624) — the two-step
 * search-then-read structure, the null-session guard + IN/OK logging pattern,
 * the `scope` enum, and the result types are the Co-Author's; the BODIES below
 * are the sidechat's own. Correspondence map (coauthor → sidechat):
 * - `search_context.execute` guard/log/search → verbatim shape (own logger
 *   tag); the `{ results }` return type is the Co-Author's verbatim.
 * - `read_context_item.execute` guard/log/read → verbatim shape; the read
 *   result type is the Co-Author's verbatim.
 * - tool-set gating: the Co-Author filters inside `buildCoauthorTools`'s
 *   toolSet block; here `buildSidechatSearchTools` filters the SAME way on the
 *   resolved sidechat profile's tool set (the kind's toggles, SC-5).
 * Named deviations (deliberate, SC-10):
 * - descriptions written for the sidechat (the model discusses the story
 *   beside the RP chat, and can search THIS chat's branch).
 * - the `types` enum carries `rp-message` and NOT `skill`: the sidechat's
 *   session indexes the branch's RP messages (current model-facing text) and
 *   no Co-Author skills (its own skills come through `@` pins, SC-5).
 * - `read_context_item`'s type enum carries `rp-message` (read = the message
 *   plus its immediate neighbours); there is no `read_skill_file` note — that
 *   tool belongs to the Co-Author, not this kind.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { log } from "@vibe-tavern/domain";
import type {
  ContextSearchReadResult,
  ContextSearchSession,
  ContextSearchToolResult,
} from "../../../context/context-search-service.js";

/** Same observability discipline as the Co-Author's tool logger (CA-17/CANARY):
 *  without the IN/OK lines a sidechat tool call is invisible server-side. */
const logger = log.tag("sidechat.tool");

/**
 * Build the sidechat's `search_context` / `read_context_item` over a
 * per-turn {@link ContextSearchSession}. `toolSet` is the RESOLVED profile's
 * set (the kind's toggles, SC-5): a tool whose key is not enabled is not
 * served — a tool landed with its toggle off is not landed.
 */
export function buildSidechatSearchTools(input: {
  session: ContextSearchSession;
  toolSet: Record<string, boolean>;
}): ToolSet {
  const { session } = input;
  const allTools = {
    search_context: tool({
      description:
        "Search the user's library AND this chat's RP branch by keyword (characters, personas, lorebooks, lore entries, scripts, and the RP messages of this chat's branch). " +
        "Returns compact locator metadata only (type, id, title, scope, meta, match kind) — no full content. " +
        "Use concise source-language keywords; retry with synonyms or translation if the first search misses. " +
        "When you know the item's title, pass it as the query — exact-title matches rank above content matches. " +
        "HOW TO READ RESULTS: call `read_context_item` with a result's type and id to get full content — for every type, including 'rp-message' (an RP message of this chat's branch, returned with its immediate neighbours as the current text the RP model sees).",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search keywords. Short, content-language, no operators needed."),
        types: z.array(z.enum(["character", "persona", "lorebook", "lore-entry", "script", "rp-message"]))
          .optional()
          .describe("Restrict results to these types. Omit to search all (entities + this branch's RP messages)."),
        scope: z.enum(["active_first", "library"])
          .optional()
          .describe("'active_first' (default) boosts the active character/persona and their bound resources; RP messages are never boosted. 'library' disables boosting."),
      }),
      execute: async ({ query, types, scope }): Promise<{ results: ContextSearchToolResult[] }> => {
        logger.info("search_context IN query=%s types=%s scope=%s", query, types?.join(",") ?? "(all)", scope ?? "active_first");
        const results = await session.search(query, {
          types,
          scopeMode: scope ?? "active_first",
        });
        logger.info("search_context OK results=%d", results.length);
        return { results };
      },
    }),

    read_context_item: tool({
      description:
        "Read the full content of one item found via `search_context` " +
        "(a character, persona, lorebook, lore-entry, script, or an RP message of this chat's branch). " +
        "Returns the item's complete text (character profile, persona description, lorebook metadata + enabled entries, " +
        "lore entry content + keys, script description + code, or an RP message TOGETHER with its immediate neighbours in story order). " +
        "Use this AFTER `search_context` identified the correct item. " +
        "Never call this without a prior search — the type and id come from search results. " +
        "RP message text is the CURRENT text as the RP model sees it now (macros resolved, prompt regex applied), not a frozen event copy.",
      inputSchema: z.object({
        type: z.enum(["character", "persona", "lorebook", "lore-entry", "script", "rp-message"])
          .describe("Item type from a search_context result."),
        id: z.string().min(1)
          .describe("Item id from a search_context result."),
      }),
      execute: async ({ type, id }): Promise<ContextSearchReadResult> => {
        logger.info("read_context_item IN type=%s id=%s", type, id);
        const result = await session.read(type, id);
        logger.info("read_context_item OK type=%s id=%s contentLen=%d", type, id, result.content.length);
        return result;
      },
    }),
  };

  // The kind's toggles (the resolved profile's set): only enabled keys are
  // served — the same filter the Co-Author applies to its module tool set.
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => input.toolSet[name] === true),
  ) as typeof allTools;
}
