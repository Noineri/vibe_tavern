import type { AiAssistantRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import { countAiAssistantTokens, streamAiAssistant, type AiAssistantStreamRequest } from "../../domain/ai-assistant/ai-assistant-stream.js";
import { createAiAssistantDeps } from "../../domain/ai-assistant/ai-assistant-deps.js";

export class AiAssistantAdapter implements AiAssistantRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly sessionRuntime: SessionRuntime,
	) {}

	streamAiAssistant = async function* (this: AiAssistantAdapter, body: AiAssistantStreamRequest) {
		yield* streamAiAssistant(body, createAiAssistantDeps(this.stores, this.sessionRuntime));
	};

	countAiAssistantTokens = (body: AiAssistantStreamRequest) =>
		countAiAssistantTokens(body, createAiAssistantDeps(this.stores, this.sessionRuntime));
}
