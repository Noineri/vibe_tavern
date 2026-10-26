/**
 * The context-links wire path (CX-4; SC-23c extraction) — the GET/PATCH
 * bodies behind `ExperienceCopilotAdapter.experienceCopilot{Get,Set}ContextLinks`,
 * extracted under the file-size ratchet when the adapter crossed the 800-line
 * cap (the extraction is the gate's prescribed remedy, not a behavior change).
 *
 * GET returns the thread row's parsed links. SET is a full replace behind the
 * SC-23c preset-pin ownership guard (`assertPresetLinksChatOwned` — a
 * `prompt_preset` link on a script/draft thread is the typed 400
 * `preset_link_not_chat_owned`, nothing written) and re-reads after the write
 * so the response reflects the persisted set.
 */

import type { ExperienceCopilotStore } from "@vibe-tavern/db";
import type { ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import { notFound } from "../../shared/errors.js";
import { assertPresetLinksChatOwned } from "../../domain/sidechat/preset-link-guard.js";

/** The store subset this path reads/writes through. */
type ContextLinksStore = Pick<ExperienceCopilotStore, "getById" | "setContextLinks">;

/** GET: the thread's pinned-context links (404 for a missing thread). */
export async function readContextLinks(
  store: ContextLinksStore,
  threadId: string,
): Promise<ExperienceCopilotContextLink[]> {
  const thread = await store.getById(threadId);
  if (!thread) {
    throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
  }
  return thread.contextLinks;
}

/** PATCH: full-replace the thread's links (SC-23c: a preset pin on a
 *  non-chat-owned thread refuses the whole replace before any write). The
 *  re-read after the write mirrors the original adapter body so the response
 *  reflects the persisted set. */
export async function replaceContextLinks(
  store: ContextLinksStore,
  threadId: string,
  links: ExperienceCopilotContextLink[],
): Promise<ExperienceCopilotContextLink[]> {
  const thread = await store.getById(threadId);
  if (!thread) {
    throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
  }
  assertPresetLinksChatOwned({ threadId, thread, links });
  await store.setContextLinks(threadId, links);
  const refreshed = await store.getById(threadId);
  return refreshed ? refreshed.contextLinks : links;
}
