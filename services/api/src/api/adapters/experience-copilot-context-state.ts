/**
 * The thread-context read + patch pair — the bodies behind
 * `ExperienceCopilotAdapter.experienceCopilot{Get,Patch}Context`, extracted
 * under the file-size ratchet when the `feat/attachments` merge pushed the
 * adapter past the 800-line cap (the extraction is the gate's prescribed
 * remedy, not a behavior change; the `experience-copilot-context-links.ts`
 * sibling pattern).
 *
 * GET returns the thread's metrics + auto-compact toggle. PATCH persists the
 * optional `autoCompact` flag and re-reads so the response reflects the
 * persisted toggle (metrics unchanged). Both 404 for a missing thread.
 */

import type { ExperienceCopilotContextState } from "../contract/experience-copilot-contracts.js";
import type { ExperienceCopilotStore } from "@vibe-tavern/db";
import { notFound } from "../../shared/errors.js";
import { toMetricsWire } from "./experience-copilot-wire-mappers.js";

/** The store subset this path reads/writes through. */
type ContextStateStore = Pick<ExperienceCopilotStore, "getById" | "setAutoCompact">;

/** GET: the thread's context metrics + auto-compact toggle (404 for a missing thread). */
export async function readCopilotContextState(
  store: ContextStateStore,
  threadId: string,
): Promise<ExperienceCopilotContextState> {
  const thread = await store.getById(threadId);
  if (!thread) {
    throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
  }
  return {
    metrics: thread.contextMetrics ? toMetricsWire(thread.contextMetrics) : null,
    autoCompact: thread.autoCompact,
  };
}

/** PATCH: persist the optional auto-compact flag, re-read, and answer in the wire shape. */
export async function patchCopilotContextState(
  store: ContextStateStore,
  threadId: string,
  body: { autoCompact?: boolean },
): Promise<ExperienceCopilotContextState> {
  const thread = await store.getById(threadId);
  if (!thread) {
    throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
  }
  if (body.autoCompact !== undefined) {
    await store.setAutoCompact(threadId, body.autoCompact);
  }
  // Re-read so the response reflects the persisted toggle (metrics unchanged).
  const refreshed = await store.getById(threadId);
  return {
    metrics: refreshed?.contextMetrics ? toMetricsWire(refreshed.contextMetrics) : null,
    autoCompact: refreshed?.autoCompact ?? true,
  };
}
