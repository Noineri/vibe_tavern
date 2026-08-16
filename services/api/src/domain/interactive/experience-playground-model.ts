/**
 * Ephemeral playground model-continuation seam implementation (IR-90E).
 *
 * Implements {@link PlaygroundModelDeps} for the in-memory playground driver.
 * This module CAN import provider / prompt-pipeline / summary-seam code (unlike
 * `experience-playground.ts`, which stays kernel/sandbox/shared/domain/contracts
 * only). It resolves the pinned provider profile read-only (no store writes),
 * builds a minimal prompt from the effect request + the seat's projected private
 * view, calls the REAL {@link nonstreamingProviderExecute}, validates the output,
 * and returns the text. ZERO ExperienceStore/chat/DB writes — the provider
 * profile resolution is a pure read.
 *
 * This mirrors the durable model-effect service's provider resolution + prompt
 * building + execution path, but EPHEMERALLY: no effect store claim/complete/
 * fail, no context bundle from the DB, no global/character overrides. The prompt
 * is the minimal faithful surface: host protocol + package instruction + the
 * seat's projected view + legal actions.
 */
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import {
	buildExperienceContext,
	buildExperienceModelPrompt,
	type ExperienceContextInput,
} from "@vibe-tavern/prompt-pipeline";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { providerRequiresApiKey, resolveEffectiveSummaryProfile } from "../chat/summary-generation-seam.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import type {
	PlaygroundModelDeps,
	PlaygroundModelResolveInput,
	PlaygroundModelResolveResult,
} from "./experience-playground.js";
import type { ExperienceActionDescriptor } from "@vibe-tavern/domain";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExperiencePlaygroundModelDeps {
	providerProfiles: ProviderProfileService;
	/** Provider execution seam — injected so tests can stub the model call. */
	execute?: typeof nonstreamingProviderExecute;
}

// ─── Prompt helpers (mirrors the model-effect-service, minimal) ─────────────

/** The model effect request payload (mirrors the durable shape). */
interface ModelEffectRequest {
	viewer: string;
	mode: "action" | "text";
	actionType?: string;
	instruction?: string;
}

function parseRequest(raw: unknown): ModelEffectRequest | null {
	if (raw === null || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const mode = obj.mode;
	if (mode !== "action" && mode !== "text") return null;
	const viewer = obj.viewer;
	if (typeof viewer !== "string") return null;
	const request: ModelEffectRequest = { viewer, mode };
	if (typeof obj.actionType === "string") request.actionType = obj.actionType;
	if (typeof obj.instruction === "string") request.instruction = obj.instruction;
	return request;
}

function hostProtocolForMode(mode: ModelEffectRequest["mode"]): string {
	if (mode === "action") {
		return [
			"You are a participant in an interactive experience.",
			"Choose exactly ONE legal action for your participant on your turn.",
			'Reply with ONLY a JSON object: {"actionId": "<one of the legal action types>", "args": <optional arguments>}.',
			"Do not add any prose outside the JSON object.",
		].join(" ");
	}
	return [
		"You are a participant in an interactive experience.",
		"Reply with your in-character text response for your turn.",
		"Stay in character; do not narrate the system or other participants.",
	].join(" ");
}

function renderPrivateView(projectedView: unknown, legalActions: PlaygroundModelResolveInput["legalActions"], request: ModelEffectRequest): string {
	const lines: string[] = ["[Your projected view]"];
	lines.push(safeStringify(projectedView));
	if (request.mode === "action" && legalActions.length > 0) {
		lines.push("");
		lines.push("[Your legal actions — pick one]");
		for (const a of legalActions) {
			lines.push(`- ${a.type}${a.label ? ` (${a.label})` : ""}`);
		}
	}
	return lines.join("\n");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Validate the model output against the request mode, mirroring the durable
 *  model-effect-service's validateOutput exactly. Action mode parses a JSON
 *  object (or bare legal type) and requires actionId to match a legal action;
 *  text mode requires a non-empty string. Returns null on any failure. */
function validateOutput(
	text: string,
	request: ModelEffectRequest,
	legalActions: readonly ExperienceActionDescriptor[],
): PlaygroundModelResolveResult | null {
	const trimmed = text.trim();
	if (request.mode === "text") {
		return trimmed.length > 0 ? { ok: true, mode: "text", text: trimmed } : null;
	}
	// Action mode: accept either a bare legal action type or a JSON object.
	const legalTypes = new Set(legalActions.map((a) => a.type));
	if (legalTypes.has(trimmed)) {
		return { ok: true, mode: "action", actionId: trimmed };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const obj = parsed as { actionId?: unknown; args?: unknown };
	if (typeof obj.actionId !== "string" || !legalTypes.has(obj.actionId)) return null;
	return {
		ok: true,
		mode: "action",
		actionId: obj.actionId,
		...(obj.args !== undefined ? { args: obj.args } : {}),
	};
}

function describeError(e: unknown): string {
	if (e !== null && typeof e === "object") {
		const message = (e as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return typeof e === "string" ? e : "unknown_error";
}

// ─── Seam factory ───────────────────────────────────────────────────────────

/**
 * Create a {@link PlaygroundModelDeps} that resolves the pinned provider/model
 * read-only, builds a minimal prompt, and calls the REAL non-streaming executor.
 * ZERO store writes — the only mutation is the executor's outbound HTTP call.
 */
export function createPlaygroundModelDeps(deps: ExperiencePlaygroundModelDeps): PlaygroundModelDeps {
	const execute = deps.execute ?? nonstreamingProviderExecute;
	const providerProfiles = deps.providerProfiles;

	return {
		async resolveModelReply(input: PlaygroundModelResolveInput): Promise<PlaygroundModelResolveResult> {
			// 1. Parse the effect request.
			const request = parseRequest(input.request);
			if (request === null) {
				return { ok: false, code: "invalid_output", message: "Malformed model effect request" };
			}

			// 2. Resolve the pinned provider profile (read-only).
			const profile: StoredProviderProfileRecord | null = await providerProfiles.getProviderProfile(input.providerProfileId);
			if (profile === null) {
				return { ok: false, code: "no_provider", message: `Provider profile '${input.providerProfileId}' not found` };
			}

			// 3. API-key policy check (mirrors the durable service).
			if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
				return { ok: false, code: "no_api_key", message: `Provider '${profile.name}' requires an API key` };
			}

			// 4. Resolve the effective profile (per-model settings overlay).
			const effectiveProfile = await resolveEffectiveSummaryProfile(profile, input.modelId, providerProfiles);

			// 5. Build the prompt (host protocol + package instruction + private view).
			const emptyContext: ExperienceContextInput = { messages: [], summaries: [], character: null, persona: null };
			const bundle = buildExperienceContext(emptyContext);
			const prompt = buildExperienceModelPrompt({
				hostProtocol: hostProtocolForMode(request.mode),
				packagePrompt: request.instruction ?? null,
				context: bundle,
				privateView: renderPrivateView(input.projectedView, input.legalActions, request),
			});

			// 6. Execute via the REAL non-streaming executor.
			let text: string;
			try {
				const result = await execute({ profile: effectiveProfile, model: input.modelId, prompt });
				text = result.text;
			} catch (e) {
				return { ok: false, code: "provider_error", message: describeError(e) };
			}

			// 7. Validate the output against the request mode (mirrors the durable
			//    model-effect-service: text → non-empty string; action → JSON/bare
			//    legal type).
			const validated = validateOutput(text, request, input.legalActions);
			if (validated === null) {
				return { ok: false, code: "invalid_output", message: "Model output did not match the expected format" };
			}
			return validated;
		},
	};
}
