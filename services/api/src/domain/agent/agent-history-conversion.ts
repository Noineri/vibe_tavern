import type { ToolCallPart } from "ai";
import { promptVisibleAttachments } from "@vibe-tavern/domain";
import { asToolProviderOptions } from "../../infrastructure/ai/tool-call-provider-options.js";
import { renderWaitToolOutputWireText, stringifyObjectWireText, type AgentPersistedToolCall, type AgentPersistedToolResult } from "./agent-split-turn.js";
import type { AgentHistoryMessage } from "./agent-prompt.js";
import type { AgentStreamStoredMessage } from "./agent-stream.js";

// ─── History conversion (store ↔ prompt ↔ SDK) ───────────────────────────────

/** Convert stored agent messages into the history shape the assembly expects.
 *  Round-trips the {@link toModelMessages} serialization: assistant rows carry
 *  parsed `toolCalls`; tool rows carry a reconstructed `ToolResultPart`.
 *  Exported (CM-5) so the compaction service reuses the SAME conversion for its
 *  tool-pair-safe boundary walk and post-compaction token estimate. */
export function storeMessagesToHistory<M extends AgentStreamStoredMessage>(
	messages: readonly M[],
): AgentHistoryMessage[] {
	return messages.map((m): AgentHistoryMessage => {
		if (m.role === "digest") {
			// A compaction digest (CM-3) round-trips as a plain digest message — the
			// assembler lifts it out of the history flow.
			return { role: "digest", content: m.content };
		}
		if (m.role === "tool") {
			// Reconstruct the ToolResultPart from the stored payload. The store row
			// carries the serialized `{ toolName, output }` wrapper in `content` +
			// `toolCallId`; the SDK ToolResultPart.output is a discriminated union,
			// so the output is wrapped as a text value (the model reads it as text,
			// same as the co-author history round-trip).
			let toolName = "";
			let outputText = m.content;
			try {
				const parsed = JSON.parse(m.content) as AgentPersistedToolResult;
				toolName = parsed.toolName ?? "";
				outputText = stringifyObjectWireText(parsed.output);
				// TAG-5 + SC-23e: a WAIT tool's result carries the CONVERSATION or
				// the user's permission decision, not telemetry — the model reads
				// the answer / skip / never-answered note / prompt / denial through
				// self-describing keys, never the marker JSON (the whole wire string
				// parses to a JSON object — Struct contract for translation proxies).
				const waitWireText = renderWaitToolOutputWireText(toolName, parsed.output);
				if (waitWireText !== undefined) outputText = waitWireText;
			} catch {
				// Invalid JSON — use the raw content as the output text.
			}
			return {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: m.toolCallId ?? "",
						toolName,
						output: { type: "text", value: outputText },
					},
				],
			};
		}
		const msg: Extract<AgentHistoryMessage, { role: "user" | "assistant" }> = {
			role: m.role === "assistant" ? "assistant" : "user",
			content: m.content,
		};
		if (msg.role === "user") {
			const attachments = promptVisibleAttachments(m.attachments ?? []);
			if (attachments.length) msg.attachments = attachments;
			if (m.promptAttachments?.length) msg.promptAttachments = m.promptAttachments;
		}
		if (m.toolCallsJson) {
			try {
				const parsed = JSON.parse(m.toolCallsJson) as unknown;
				if (Array.isArray(parsed)) {
					// Narrow the stored replay metadata through the shared helper (the
					// same one the Co-Author converter uses): a valid object passes
					// through, anything else (absent field, primitive, array) drops to
					// absent — never an empty object on the replayed part.
					msg.toolCalls = parsed.map((call): ToolCallPart => {
						const c = call as AgentPersistedToolCall;
						const providerOptions = asToolProviderOptions(c.providerOptions);
						return {
							type: "tool-call",
							toolCallId: c.toolCallId,
							toolName: c.toolName,
							input: c.input,
							...(providerOptions ? { providerOptions } : {}),
						};
					});
				}
			} catch {
				// Invalid JSON — skip tool calls for this message.
			}
		}
		return msg;
	});
}

