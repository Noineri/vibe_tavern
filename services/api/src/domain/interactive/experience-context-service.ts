/**
 * IR-42 (Wave 4): the experience context-capture service.
 *
 * Captures an immutable frozen RP-context bundle for a session, driven by the
 * session's {@link ExperienceContextMode}. The five modes select how much RP
 * material is frozen:
 *
 * - `none` — empty bundle (a package without RP-context capability is a true
 *   no-op; nothing is captured, identity included).
 * - `current_branch` — the FULL branch message history + included summaries +
 *   identity (no windowing; IR-43's prompt budget is the only later trim).
 * - `recent` — a finite recent-message window + identity, NO summaries (the
 *   experience only wants the recent tail).
 * - `summaries_recent` — included summaries + a recent window + identity (the
 *   chat-pipeline default: summaries condense older history, the window grounds
 *   the present).
 * - `compact_summary` — GENERATES one ephemeral compact summary of the branch
 *   via the provider (reusing the summary-generation seam + the chat lifecycle's
 *   summary-prompt construction), freezes it alongside a recent window + the
 *   included summaries + identity, and records the provider/model used.
 *
 * Capturing a bundle is an EXPLICIT user action: it never triggers auto-summary,
 * never writes to `chat_summaries`, and never changes normal Memory settings.
 * The compact summary is persisted ONLY inside `experience_context_bundles` (a
 * separate surface), so the normal summary surface is byte-untouched.
 *
 * Material is loaded directly from the stores — mirroring
 * `PromptAssemblyService.buildPipelineContext`'s message/summary/identity
 * resolution — but WITHOUT running scripts, activating lore, or applying a
 * preset: the experience prompt has its own fixed layer order (IR-41) and empty
 * scriptInjections / lore / retrieval. Side-effect-free read.
 */
import { brandId, type AssemblePromptResponse, type ChatBranchId, type ChatId, type ExperienceContextMode } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ExperienceContextBundleRow, CaptureContextBundleData } from "@vibe-tavern/db";
import {
	buildExperienceContext,
	type ExperienceContextBundle,
	type ExperienceContextCharacter,
	type ExperienceContextInput,
	type ExperienceContextMessage,
	type ExperienceContextPersona,
	type ExperienceContextSummary,
} from "@vibe-tavern/prompt-pipeline";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { withSummaryPromptAsFinalUserMessage } from "../chat/chat-summary-service.js";
import {
	providerRequiresApiKey,
	resolveEffectiveSummaryProfile,
} from "../chat/summary-generation-seam.js";
import { notFound, unprocessable, validation, cancelled } from "../../shared/errors.js";

// ─── Capability-gate helper ──────────────────────────────────────────────────

function checkGrant(session: { capabilityGrantsJson: string }, required: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(session.capabilityGrantsJson);
  } catch (error) {
    parsed = [];
  }
  const grants = Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string")
    : [];
  if (!grants.includes(required)) {
    throw unprocessable(
      `The experience session does not grant the '${required}' capability.`,
      { code: "capability_denied", capability: required, granted: grants },
    );
  }
}

/**
 * Structural seam over the chat lifecycle: the single summary-prompt construction
 * method this service reuses for `compact_summary`. Kept minimal so the context
 * service does not depend on the full SessionRuntime surface.
 */
export interface ExperienceChatLifecycleSeam {
	assembleSummaryPrompt(input: {
		chatId: ChatId;
		model: string;
		recentMessageLimit: number;
		contextBudget?: number | null;
	}): Promise<{ prompt: AssemblePromptResponse; branchId: ChatBranchId }>;
}

/** Recent-message window default when the chat has no finite history limit. */
const DEFAULT_RECENT_WINDOW = 20;

/** Serialized shape of the frozen RP material inside `variantsJson`. */
interface FrozenVariants {
	messages: ExperienceContextMessage[];
	summaries: ExperienceContextSummary[];
}

/** Serialized shape of an ephemeral compact summary inside `compactSummaryJson`. */
interface FrozenCompactSummary {
	content: string;
	label: string;
}

export interface CaptureContextInput {
	sessionId: string;
	/** Overrides the session's persisted `contextMode` for this capture. */
	mode?: ExperienceContextMode;
	/** Explicit provider for `compact_summary`. Defaults to the chat's active. */
	providerProfileId?: string;
	/** Explicit model for `compact_summary`. Defaults to the profile's default. */
	model?: string;
	/** Overrides the recent-message window for windowed modes. */
	recentMessageLimit?: number;
	/** Cancellation for `compact_summary` generation. */
	signal?: AbortSignal;
}

/** Privacy-safe context-bundle status DTO (IR-70D) — session-scoped metadata
 *  only; never carries payload fields. Mirrors the API contract's
 *  {@link ExperienceContextStatusDto} but lives in the domain layer so the
 *  service does not import from the API contract. */
export interface ExperienceContextStatus {
  sessionId: string;
  mode: ExperienceContextMode;
  branchFrontierRevision: number | null;
  messageFrontierPosition: number | null;
  providerProfileId: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceContextServiceDeps {
	stores: StoreContainer;
	providerProfiles: ProviderProfileService;
	chatLifecycle: ExperienceChatLifecycleSeam;
	/** Provider execution seam — injected so tests can stub the model call. */
	execute?: typeof nonstreamingProviderExecute;
}

export class ExperienceContextService {
	private readonly execute: typeof nonstreamingProviderExecute;

	constructor(private readonly deps: ExperienceContextServiceDeps) {
		this.execute = deps.execute ?? nonstreamingProviderExecute;
	}

	/**
	 * Capture (or replace) the session's frozen RP-context bundle. One row per
	 * session (the store upserts). Returns the persisted row. For
	 * `compact_summary`, generates the ephemeral summary first and fails without
	 * persisting if the generation is cancelled or the provider is unavailable.
	 */
	async captureContext(input: CaptureContextInput): Promise<ExperienceContextBundleRow> {
		const session = await this.deps.stores.experiences.getSessionById(input.sessionId);
		if (!session) {
			throw notFound("ExperienceSession", `Experience session '${input.sessionId}' was not found.`);
		}
		checkGrant(session, "rp_context");
		const mode = input.mode ?? (session.contextMode as ExperienceContextMode);
		const chatId = brandId<ChatId>(session.chatId);
		const branchId = brandId<ChatBranchId>(session.branchId);

		// `none` is a true no-op: an empty bundle, no reads, no generation.
		if (mode === "none") {
			return this.deps.stores.experiences.captureContextBundle(input.sessionId, {
				mode,
				branchFrontierRevision: null,
				messageFrontierPosition: null,
				variantsJson: JSON.stringify({ messages: [], summaries: [] } satisfies FrozenVariants),
				compactSummaryJson: null,
				characterSnapshotJson: null,
				personaSnapshotJson: null,
				sourceHashesJson: null,
				providerProfileId: null,
				modelId: null,
			});
		}

		const chat = await this.deps.stores.chats.getById(chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}

		// Resolve identity (mirrors buildPipelineContext: persona falls back to
		// the default-for-new-chats persona, else the first persona).
		const character = chat.characterId ? await this.loadCharacter(chat.characterId) : null;
		const persona = await this.loadPersona(chat.personaId);

		const includeSummaries = mode === "current_branch" || mode === "summaries_recent" || mode === "compact_summary";
		const isFullBranch = mode === "current_branch";
		const window = this.resolveWindow(chat.messageHistoryLimit, input.recentMessageLimit);

		const branchMessages = await this.deps.stores.messages.getMessages(branchId);
		const windowed = isFullBranch ? branchMessages : branchMessages.slice(-window);
		const messages = windowed.map((m) => normalizeMessage(m));
		const summaries = includeSummaries ? await this.loadIncludedSummaries(chatId, branchId) : [];

		// `compact_summary`: generate the ephemeral summary BEFORE persisting, so a
		// cancellation or provider failure leaves the previous bundle intact.
		let compactSummary: { content: string; providerProfileId: string; modelId: string } | null = null;
		if (mode === "compact_summary") {
			compactSummary = await this.generateCompactSummary({
				chatId,
				providerProfileId: input.providerProfileId,
				model: input.model,
				recentMessageLimit: window,
				signal: input.signal,
			});
		}

		const frozenSummaries: ExperienceContextSummary[] =
			mode === "compact_summary" && compactSummary
				? [
						...summaries,
						{ id: "__compact__", content: compactSummary.content, label: "Compact summary" },
					]
				: summaries;

		const frozen: FrozenVariants = { messages, summaries: frozenSummaries };
		const data: CaptureContextBundleData = {
			mode,
			// Branches have no revision counter; the message frontier is the
			// meaningful staleness signal (position of the last message, 0-based).
			branchFrontierRevision: null,
			messageFrontierPosition: branchMessages.length > 0 ? branchMessages[branchMessages.length - 1].position : null,
			variantsJson: JSON.stringify(frozen),
			compactSummaryJson:
				mode === "compact_summary" && compactSummary
					? JSON.stringify({
							content: compactSummary.content,
							label: "Compact summary",
						} satisfies FrozenCompactSummary)
					: null,
			characterSnapshotJson: character ? JSON.stringify(character) : null,
			personaSnapshotJson: persona ? JSON.stringify(persona) : null,
			sourceHashesJson: JSON.stringify({
				messageCount: branchMessages.length,
				lastMessageId: branchMessages.length > 0 ? branchMessages[branchMessages.length - 1].id : null,
			}),
			providerProfileId: compactSummary?.providerProfileId ?? null,
			modelId: compactSummary?.modelId ?? null,
		};
		return this.deps.stores.experiences.captureContextBundle(input.sessionId, data);
	}

	/** Read the session's current frozen bundle (or null if never captured). */
	async getContextBundle(sessionId: string): Promise<ExperienceContextBundleRow | null> {
		return this.deps.stores.experiences.getContextBundle(sessionId);
	}

	/**
	 * Privacy-safe context status (IR-70D). Returns only session-scoped metadata
	 * + provider/model ids — never payload fields (variantsJson, compactSummaryJson,
	 * character/persona snapshots, or provider secrets). Requires `rp_context`.
	 */
	async getContextStatus(sessionId: string): Promise<ExperienceContextStatus | null> {
		const session = await this.deps.stores.experiences.getSessionById(sessionId);
		if (!session) {
			throw notFound("ExperienceSession", `Experience session '${sessionId}' was not found.`);
		}
		checkGrant(session, "rp_context");
		const row = await this.deps.stores.experiences.getContextBundle(sessionId);
		if (!row) return null;
		return {
			sessionId: row.sessionId,
			mode: row.mode as ExperienceContextMode,
			branchFrontierRevision: row.branchFrontierRevision,
			messageFrontierPosition: row.messageFrontierPosition,
			providerProfileId: row.providerProfileId,
			modelId: row.modelId,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	// ─── Bundle reconstruction (IR-43 prompt-build seam) ──────────────────────

	/**
	 * Reconstruct a pure {@link ExperienceContextInput} from a persisted bundle
	 * row, for {@link buildExperienceContext} / {@link buildExperienceModelPrompt}
	 * at effect-build time. No budget is applied here — IR-43 supplies the
	 * model's budget to the prompt builder (the authoritative final trim).
	 */
	rowToContextInput(row: ExperienceContextBundleRow): ExperienceContextInput {
		const frozen = parseFrozenVariants(row.variantsJson);
		const character = row.characterSnapshotJson ? parseSnapshot<ExperienceContextCharacter>(row.characterSnapshotJson) : null;
		const persona = row.personaSnapshotJson ? parseSnapshot<ExperienceContextPersona>(row.personaSnapshotJson) : null;
		return {
			messages: frozen.messages,
			summaries: frozen.summaries,
			character,
			persona,
		};
	}

	/**
	 * Convenience: load + reconstruct the bundle for a session in one call. Used
	 * by IR-43's model-effect build path.
	 */
	async loadBundle(sessionId: string): Promise<ExperienceContextBundle | null> {
		const row = await this.getContextBundle(sessionId);
		if (!row) return null;
		return buildExperienceContext(this.rowToContextInput(row));
	}

	// ─── Internals ────────────────────────────────────────────────────────────

	private async generateCompactSummary(input: {
		chatId: ChatId;
		providerProfileId?: string;
		model?: string;
		recentMessageLimit: number;
		signal?: AbortSignal;
	}): Promise<{ content: string; providerProfileId: string; modelId: string }> {
		const profile = input.providerProfileId
			? await this.deps.providerProfiles.getProviderProfile(input.providerProfileId)
			: await this.deps.providerProfiles.resolveActiveProviderProfile();
		// No resolvable provider → semantic rejection (the mode requires one).
		if (!profile) {
			throw unprocessable(
				"No provider available for compact-summary generation.",
				{ code: "no_provider" },
			);
		}
		if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
			throw validation("Selected provider has no saved API key.");
		}
		const model = input.model?.trim() || profile.defaultModel?.trim();
		if (!model) {
			throw unprocessable(
				"No model available for compact-summary generation.",
				{ code: "no_model", providerProfileId: profile.id },
			);
		}
		const effective = await resolveEffectiveSummaryProfile(profile, model, this.deps.providerProfiles);

		if (input.signal?.aborted) throw cancelled("Compact summary was cancelled.");

		const assembled = await this.deps.chatLifecycle.assembleSummaryPrompt({
			chatId: input.chatId,
			model,
			recentMessageLimit: input.recentMessageLimit,
			contextBudget: effective.contextBudget ?? null,
		});
		const prompt = withSummaryPromptAsFinalUserMessage(assembled.prompt);

		let text: string;
		try {
			const result = await this.execute({
				profile: effective,
				model,
				prompt,
				signal: input.signal,
				overrideMaxTokens: 16384,
			});
			text = result.text;
		} catch (err) {
			// Cross-realm abort detection: if the signal aborted, this is a cancel,
			// not a provider fault (see the JSC cross-realm gotcha — do not use
			// instanceof AbortError across realms).
			if (input.signal?.aborted) throw cancelled("Compact summary was cancelled.");
			throw err;
		}
		const content = text.trim();
		if (!content) {
			throw validation("Provider returned an empty compact summary.");
		}
		return { content, providerProfileId: profile.id, modelId: model };
	}

	private async loadIncludedSummaries(chatId: ChatId, branchId: ChatBranchId): Promise<ExperienceContextSummary[]> {
		const all = await this.deps.stores.chatSummaries.listByChatBranch(chatId, branchId);
		return all
			.filter((s) => s.includeInContext && s.content.trim())
			.map((s) => ({ id: s.id, content: s.content.trim(), label: s.label ?? undefined }));
	}

	private async loadCharacter(characterId: string): Promise<ExperienceContextCharacter | null> {
		const c = await this.deps.stores.characters.getById(characterId);
		if (!c) return null;
		// Map the store row's fields to the bundle snapshot shape (the store uses
		// personalitySummary / defaultScenario; the bundle uses personality / scenario).
		return {
			id: c.id,
			name: c.name,
			description: c.description,
			scenario: c.defaultScenario,
			personality: c.personalitySummary,
		};
	}

	private async loadPersona(explicitPersonaId: string | null): Promise<ExperienceContextPersona | null> {
		const allPersonas = await this.deps.stores.personas.listAll();
		const effectivePersonaId =
			explicitPersonaId ?? allPersonas.find((p) => p.defaultForNewChats)?.id ?? allPersonas[0]?.id ?? "";
		if (!effectivePersonaId) return null;
		const p = await this.deps.stores.personas.getById(effectivePersonaId);
		if (!p) return null;
		return { id: p.id, name: p.name, description: p.description };
	}

	private resolveWindow(chatHistoryLimit: number | null | undefined, override?: number): number {
		if (override != null && Number.isFinite(override) && override > 0) return Math.floor(override);
		if (Number.isFinite(chatHistoryLimit) && (chatHistoryLimit ?? 0) > 0) return chatHistoryLimit!;
		return DEFAULT_RECENT_WINDOW;
	}
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function normalizeMessage(row: {
	id: string;
	role: string;
	content: string;
}): ExperienceContextMessage {
	const role = isMessageRole(row.role) ? row.role : "user";
	return { id: row.id, role, content: row.content };
}

function isMessageRole(role: string): role is ExperienceContextMessage["role"] {
	return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function parseFrozenVariants(json: string | null): FrozenVariants {
	if (!json) return { messages: [], summaries: [] };
	try {
		const parsed = JSON.parse(json) as Partial<FrozenVariants>;
		const messages = Array.isArray(parsed.messages) ? (parsed.messages as ExperienceContextMessage[]) : [];
		const summaries = Array.isArray(parsed.summaries) ? (parsed.summaries as ExperienceContextSummary[]) : [];
		return { messages, summaries };
	} catch {
		return { messages: [], summaries: [] };
	}
}

function parseSnapshot<T>(json: string): T | null {
	try {
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}
