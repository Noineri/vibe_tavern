import { buildAgentReviewEnvelope, experienceCopilotToolOutputSchema, type AgentReviewEnvelope, type AgentToolActivity } from "@vibe-tavern/api-contracts";
import type { AgentReviewService } from "../../agent/agent-review-service.js";
import type { ExperienceCopilotStreamEvent } from "./experience-copilot-stream-contract.js";

/** Turn-local projection of the SAME call/result events the browser receives.
 * Only successful finalized buffer results enter review persistence. No tool
 * output is changed and no draft buffer is written or auto-applied here. */
export class ExperienceCopilotReviewPersistence {
  private previous: AgentReviewEnvelope | null = null;
  private buffers: { rules: string; visual: string } | null = null;
  private readonly activities = new Map<string, AgentToolActivity>();

  constructor(private readonly service: Pick<AgentReviewService, "get" | "put">, private readonly threadId: string) {}

  async begin(buffers: { rules: string; visual: string }): Promise<void> {
    this.previous = await this.service.get(this.threadId);
    this.buffers = buffers;
  }

  observe(event: ExperienceCopilotStreamEvent): void {
    if (event.event !== "tool-call" && event.event !== "tool-result") return;
    const info = JSON.parse(event.data) as { toolCallId: string; toolName: string; args?: unknown; output?: unknown; isError?: boolean };
    if (info.toolName !== "write_buffer" && info.toolName !== "edit_buffer") return;
    const previous = this.activities.get(info.toolCallId);
    if (event.event === "tool-call") {
      this.activities.set(info.toolCallId, { ...previous, toolCallId: info.toolCallId, toolName: info.toolName, args: info.args, status: "streaming" });
    } else {
      const output = experienceCopilotToolOutputSchema.safeParse(info.output);
      this.activities.set(info.toolCallId, {
        ...previous, toolCallId: info.toolCallId, toolName: info.toolName,
        status: info.isError || !output.success ? "error" : "done",
        ...(output.success ? output.data : {}),
      });
    }
  }

  async persist(): Promise<void> {
    if (!this.buffers) return;
    const envelope = buildAgentReviewEnvelope(this.previous, [...this.activities.values()], this.buffers);
    if (envelope) await this.service.put(this.threadId, envelope);
  }
}
