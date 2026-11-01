import { isRecord } from "@vibe-tavern/domain";
import type { CoauthorReviewResult } from "./coauthor-review-service.js";

/** Producer-owned activity collector. The shared terminal relay flushes after
 * message persistence and before finish/abort/error reaches any subscriber. */
export class CoauthorReviewPersistence {
  private readonly calls = new Map<string, { toolName: string; args?: unknown }>();
  private readonly results = new Map<string, CoauthorReviewResult>();

  constructor(private readonly chatId: string, private readonly save: (chatId: string, results: readonly CoauthorReviewResult[]) => Promise<void>) {}

  observe(event: { event: string; data: string }): void {
    if (event.event !== "tool-call" && event.event !== "tool-result") return;
    let info: unknown;
    try { info = JSON.parse(event.data); } catch { return; }
    if (!isRecord(info) || typeof info.toolCallId !== "string" || typeof info.toolName !== "string") return;
    if (event.event === "tool-call") {
      this.calls.set(info.toolCallId, { toolName: info.toolName, args: info.args });
    } else {
      const call = this.calls.get(info.toolCallId);
      this.results.set(info.toolCallId, { toolCallId: info.toolCallId, toolName: call?.toolName ?? info.toolName,
        ...(call?.args !== undefined ? { args: call.args } : {}), result: info.output, isError: info.isError === true });
    }
  }

  async persist(): Promise<void> {
    // Stable call order, not parallel result completion order. Native cumulative
    // lore revisions remain on each activity for the existing Apply aggregator.
    const ordered = [...this.calls.keys(), ...[...this.results.keys()].filter((id) => !this.calls.has(id))];
    await this.save(this.chatId, ordered.flatMap((id) => this.results.get(id) ?? []));
  }
}
