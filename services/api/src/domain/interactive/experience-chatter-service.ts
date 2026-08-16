/**
 * Experience chatter service (ASYNC_FLAVOR_CHATTER_PLAN, Wave 2 / AC-2).
 *
 * Resolves the `experienceChatter` marker an author returns from the optional
 * `flavor(context, viewer)` method into the host-normalized chatter view the
 * projection carries (pending → resolved/failed). This is COSMETIC OUT-OF-BAND
 * speech: it never blocks the action-resolving turn, never feeds back into the
 * reducer, never consumes the deterministic cursor, and never reaches state,
 * events, or the replay journal. The model-effect path (IR-43) is untouched.
 *
 * Semantics (the plan's non-negotiables):
 *  - `resolveChatterFlavor` is SYNCHRONOUS: a marker hit returns a `pending`
 *    view immediately and fires the model call fire-and-forget; completion
 *    overwrites the cache entry with `resolved` (text) or `failed` (fallback).
 *    The next projection poll of the same revision then serves the terminal
 *    view — which is what keeps the frontend chatter-resync gate (AC-3)
 *    meaningful.
 *  - ONE attempt per (session, viewer, revision, request-hash): the cache key
 *    includes all four, so repeated projections of a revision never re-invoke
 *    the model. A new revision starts a fresh attempt when the marker is
 *    present again (the author's conditional return IS the pace control).
 *  - Best-effort: any failure (unknown seat, malformed/malformed-pinned seat,
 *    missing provider/API key, provider error, empty reply) degrades to a
 *    `failed` view carrying the author's `fallback` — never an error surface.
 *  - Cache is in-process only (no DB, no migration): entries older than the
 *    newest revision seen for their (session, viewer) pair are evicted, and the
 *    map is size-bounded FIFO. A server restart simply forgets pending chatter
 *    (cosmetic, best-effort by contract).
 *
 * Seat/model resolution reuses `resolveSeatAssignment` from the model-effect
 * service (IR-70E): pinned participants use exactly their pinned
 * provider/model; legacy participants fall back to the active profile/default
 * model. The prompt is a minimal host-built exchange (chatter needs no context
 * bundle — it is a one-line cosmetic reaction, not a turn).
 */
import type {
	AssemblePromptResponse,
	ExperienceParticipant,
	StoredProviderProfileRecord,
} from "@vibe-tavern/domain";
import {
	INTERACTIVE_SCHEMA_MAX_CHATTER_TEXT,
	experienceChatterRequestSchema,
	type ExperienceChatterRequestDto,
	type ExperienceChatterViewDto,
} from "@vibe-tavern/api-contracts";

import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { providerRequiresApiKey, resolveEffectiveSummaryProfile } from "../chat/summary-generation-seam.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { resolveSeatAssignment } from "./experience-model-effect-service.js";

/** The single top-level flavor key that marks a flavor return as chatter. */
const CHATTER_MARKER_KEY = "experienceChatter";

/** Cache size bound (FIFO). 512 entries × a small view ≈ negligible memory. */
const CACHE_MAX_ENTRIES = 512;

export interface ExperienceChatterServiceDeps {
	providerProfiles: ProviderProfileService;
	/** Test seam (the same pattern as the model-effect service's execute dep). */
	execute?: typeof nonstreamingProviderExecute;
}

/** A cache row: the terminal-or-pending view plus its eviction coordinates. */
interface ChatterCacheRow {
	readonly sessionId: string;
	readonly viewerKey: string;
	readonly revision: number;
	view: ExperienceChatterViewDto;
}

/**
 * Parse the chatter marker out of a flavor return. Returns the validated
 * request when the output is a plain object whose SOLE key is the marker and
 * its value passes {@link experienceChatterRequestSchema}; null otherwise
 * (static flavor, arrays, primitives, or a malformed marker — all pass through
 * untouched as static flavor per the best-effort contract).
 */
export function parseChatterMarker(flavorOutput: unknown): ExperienceChatterRequestDto | null {
	if (typeof flavorOutput !== "object" || flavorOutput === null || Array.isArray(flavorOutput)) return null;
	const keys = Object.keys(flavorOutput as Record<string, unknown>);
	if (keys.length !== 1 || keys[0] !== CHATTER_MARKER_KEY) return null;
	const parsed = experienceChatterRequestSchema.safeParse((flavorOutput as Record<string, unknown>)[CHATTER_MARKER_KEY]);
	return parsed.success ? parsed.data : null;
}

/** Stable short hash (FNV-1a) of the normalized request for the cache key. */
function hashRequest(request: ExperienceChatterRequestDto): string {
	const text = JSON.stringify([request.seatId, request.instructions, request.fallback ?? null]);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16);
}

export class ExperienceChatterService {
	private readonly providerProfiles: ProviderProfileService;
	private readonly execute: typeof nonstreamingProviderExecute;
	private readonly cache = new Map<string, ChatterCacheRow>();

	constructor(deps: ExperienceChatterServiceDeps) {
		this.providerProfiles = deps.providerProfiles;
		this.execute = deps.execute ?? nonstreamingProviderExecute;
	}

	/**
	 * Normalize one flavor output for a (session, viewer, revision). Returns the
	 * input UNCHANGED when it is not a well-formed chatter marker (static flavor
	 * is fully backward compatible); otherwise returns the pending/terminal
	 * chatter view, firing the model attempt on first sight of the key.
	 */
	resolveChatterFlavor(
		sessionId: string,
		viewer: { kind: string; participantId?: string },
		revision: number,
		flavorOutput: unknown,
		participants: readonly ExperienceParticipant[],
	): unknown {
		const request = parseChatterMarker(flavorOutput);
		if (request === null) return flavorOutput;

		const viewerKey = viewer.participantId ?? viewer.kind;
		const key = `${sessionId}|${viewerKey}|${revision}|${hashRequest(request)}`;
		const hit = this.cache.get(key);
		if (hit !== undefined) return hit.view;

		// An unknown seat is knowable synchronously: resolve straight to the
		// failed view (zero model calls — the plan's immediate-degradation rule).
		if (!participants.some((p) => p.id === request.seatId)) {
			const failed: ExperienceChatterViewDto = {
				status: "failed",
				seatId: request.seatId,
				...(request.fallback !== undefined ? { fallback: request.fallback } : {}),
			};
			this.cache.set(key, { sessionId, viewerKey, revision, view: failed });
			return failed;
		}

		this.evictStale(sessionId, viewerKey, revision);

		const pendingView: ExperienceChatterViewDto = {
			status: "pending",
			seatId: request.seatId,
			...(request.fallback !== undefined ? { fallback: request.fallback } : {}),
		};
		this.cache.set(key, { sessionId, viewerKey, revision, view: pendingView });

		// Fire-and-forget: completion overwrites the row; failures degrade to a
		// failed view inside runChatter (never rejects past this point).
		void this.runChatter(key, { sessionId, viewerKey, revision }, request, participants);

		return pendingView;
	}

	private async runChatter(
		key: string,
		coords: { sessionId: string; viewerKey: string; revision: number },
		request: ExperienceChatterRequestDto,
		participants: readonly ExperienceParticipant[],
	): Promise<void> {
		const view = await this.callModel(request, participants);
		// The row may have been evicted by a revision bump while the call was in
		// flight; re-check it is still ours before overwriting.
		const row = this.cache.get(key);
		if (row === undefined || row.sessionId !== coords.sessionId || row.viewerKey !== coords.viewerKey) return;
		row.view = view;
	}

	/** Best-effort model call: every failure path returns a `failed` view. */
	private async callModel(
		request: ExperienceChatterRequestDto,
		participants: readonly ExperienceParticipant[],
	): Promise<ExperienceChatterViewDto> {
		const failedView = (): ExperienceChatterViewDto => ({
			status: "failed",
			seatId: request.seatId,
			...(request.fallback !== undefined ? { fallback: request.fallback } : {}),
		});

		try {
			const participant = participants.find((p) => p.id === request.seatId);
			if (participant === undefined) return failedView();

			const seat = resolveSeatAssignment(participant);
			let profile: StoredProviderProfileRecord;
			let model: string;
			if (seat.kind === "pinned") {
				const pinned = await this.providerProfiles.getProviderProfile(seat.providerProfileId);
				if (pinned === null) return failedView();
				profile = pinned;
				model = seat.modelId;
			} else if (seat.kind === "malformed") {
				return failedView();
			} else {
				const active = await this.providerProfiles.resolveActiveProviderProfile();
				if (active === null) return failedView();
				profile = active;
				model = active.defaultModel?.trim() ?? "";
			}
			if (!model) return failedView();
			if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) return failedView();

			const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, this.providerProfiles);
			const result = await this.execute({ profile: effectiveProfile, model, prompt: buildChatterPrompt(request) });
			const text = result.text.trim().slice(0, INTERACTIVE_SCHEMA_MAX_CHATTER_TEXT);
			if (text.length === 0) return failedView();
			return { status: "resolved", seatId: request.seatId, text };
		} catch {
			// Best-effort by contract: a provider throw degrades to the fallback
			// view. Logged nowhere else because chatter is cosmetic-only; the
			// failed status IS the signal.
			return failedView();
		}
	}

	/** Drop entries for this (session, viewer) older than `revision`, and trim
	 *  the map to the FIFO size bound. */
	private evictStale(sessionId: string, viewerKey: string, revision: number): void {
		for (const [key, row] of this.cache) {
			if (row.sessionId === sessionId && row.viewerKey === viewerKey && row.revision < revision) {
				this.cache.delete(key);
			}
		}
		while (this.cache.size > CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next();
			if (oldest.done === true) break;
			this.cache.delete(oldest.value);
		}
	}
}

/** Minimal host-built prompt: a system protocol line + the author's
 *  instructions. No context bundle — chatter is a one-line cosmetic reaction,
 *  not a turn; the executor consumes the finalPayload message list. */
function buildChatterPrompt(request: ExperienceChatterRequestDto): AssemblePromptResponse {
	return {
		layers: [],
		tokenAccounting: {},
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: {
			messages: [
				{
					role: "system",
					content:
						"You are a cosmetic background voice inside an interactive experience. Reply with ONE short in-character line. No quotes, no markdown, no explanations. Keep it under 50 words.",
				},
				{ role: "user", content: request.instructions },
			],
		},
	};
}
