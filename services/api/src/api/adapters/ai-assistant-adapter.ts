import type { AiAssistantRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import { countAiAssistantTokens, streamAiAssistant, type AiAssistantStreamRequest } from "../../domain/ai-assistant/ai-assistant-stream.js";
import { generateRegexAssist } from "../../domain/ai-assistant/regex-assist-service.js";
import { createAiAssistantDeps } from "../../domain/ai-assistant/ai-assistant-deps.js";
import type { RegexAssistRequest } from "@vibe-tavern/api-contracts";

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

	regexAssist = (body: RegexAssistRequest) =>
		generateRegexAssist(body, createAiAssistantDeps(this.stores, this.sessionRuntime));
}
