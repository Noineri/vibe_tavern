import type { AgentHistoryMessage } from "../agent/agent-prompt.js";

/** Render snapshots inside their owning row so trimming cannot separate them. */
export function renderSidechatPromptAttachments(message: AgentHistoryMessage): AgentHistoryMessage {
	if (message.role !== "user" || !message.promptAttachments?.length) return message;
	const { promptAttachments, ...rest } = message;
	return { ...rest, content: [message.content, ...promptAttachments.map((item) => item.promptText)].join("\n\n") };
}
