/**
 * Experience round-commit service (RM-8 / REALTIME_EXPERIENCE_MODE_PLAN).
 *
 * The realtime round is CLIENT-authoritative: the visual loop runs frame-side
 * in the sandboxed iframe, and the client posts the finished round as a CLAIM
 * — { status, finalState, the ordered round log }. This service decides
 * whether the claim is accepted: it replays the log through the REAL kernel
 * and accepts nothing it cannot reproduce.
 *
 * Replay algorithm (mirrors the frame loop host's execution EXACTLY — see
 * apps/web/src/lib/experience-loop-host.ts):
 *
 * 1. Re-derive the round's initial state by re-running `create` under the
 *    SESSION's pinned seed + initial settings (the same grant-gated,
 *    cursor-counting construction the server used at session start).
 * 2. Verify the log's `round_started.seed` equals the session's pinned seed
 *    (provenance: the round must run on the seed the session pinned — no
 *    seed shopping).
 * 3. Drive a FRESH `createDeterministicRandom(seed)` cursor through the log
 *    events in order: `ticks {count}` runs `update(tickMs)` count times;
 *    `input` / `script_move` / an action-intent `model_result` are
 *    legality-checked (via `actions`, cursor-free) then applied through
 *    `reduce` (cursor-consuming); a non-intent or illegal `model_result` was
 *    DROPPED live and changes nothing; `model_request` is informational and
 *    is never re-generated.
 * 4. Compare the canonical JSON of the replayed final state against the
 *    claim's `finalState`. Any divergence — tampered claim, edited log,
 *    impossible event order, kernel failure where the live loop would have
 *    died or dropped — is a typed 422 `round_verification_failed` with
 *    NOTHING applied.
 * 5. On match: ONE terminal `round_commit` transition (kind, state hash, the
 *    round claim digest) + the existing finish-writeback chat card (the same
 *    report/attachment flow as an explicit end-session).
 *
 * Capability-surface note: the frame loop passes `participants` and the round
 * cursor to author code UNGATED (the frame is client-side — grants gate what
 * the HOST may put in the round config, not what the frame injects), so the
 * replay mirrors THAT surface for update/reduce/legality rather than the
 * server's grant-gated `buildCapabilityContext`. Only the re-derived `create`
 * uses the grant-gated construction, because create ran server-side at
 * session start and must reproduce that exact computation.
 */

import type { ExperienceRoundCommitRequestDto } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import {
	createDeterministicRandom,
	type ExperienceAction,
	type ExperienceCapability,
	type ExperienceEvent,
	type ExperienceParticipant,
	type ExperienceViewer,
	EXPERIENCE_LOOP_MAX_BATCHED_TICKS,
	EXPERIENCE_LOOP_MAX_ROUND_TICKS,
} from "@vibe-tavern/domain";

import {
	discoverExperienceDefinition,
	runActions,
	runCreate,
	runReduce,
	runUpdate,
	validateSubmittedAction,
	type ExperienceCapabilityContext,
} from "./experience-kernel.js";
import { ExperienceReportService } from "./experience-report-service.js";
import {
	buildCapabilityContext,
	type ExperienceApiError,
	type ExperienceResult,
	err,
} from "./experience-shared.js";
import {
	createCountingRandom,
	type ExperienceQueuedAttachmentView,
	resolveHumanViewer,
	seedToNumeric,
	viewerKindForController,
} from "./experience-service.js";

// ─── Service ─────────────────────────────────────────────────────────────────

export class ExperienceRoundService {
	private readonly stores: StoreContainer;
	private readonly reports: ExperienceReportService;

	constructor(stores: StoreContainer, reports: ExperienceReportService) {
		this.stores = stores;
		this.reports = reports;
	}

	/**
	 * Replay-verify a finished realtime round claim and, on success, apply the
	 * ONE terminal transition + the finish-writeback chat card. There is
	 * deliberately no revision/CAS pair in the claim body: the replay IS the
	 * contract. A concurrent writer between load and apply surfaces as a typed
	 * 409 `stale_revision` (nothing partially applied — the transition is one
	 * atomic store call).
	 */
	async commitRound(
		sessionId: string,
		claim: ExperienceRoundCommitRequestDto,
	): Promise<ExperienceResult<ExperienceQueuedAttachmentView | null>> {
		// ── 1. Load + terminal-guard ─────────────────────────────────────────
		const session = await this.stores.experiences.getSessionById(sessionId);
		if (session === null) {
			return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
		}
		if (session.status !== "active") {
			return err({
				status: 422,
				code: "session_not_active",
				message: `Session '${sessionId}' is '${session.status}'; only an active session can commit a realtime round`,
				currentStatus: session.status,
			});
		}

		// ── 2. Log structure (cheap rejections before any VM work) ───────────
		const log = claim.log;
		const fail = (message: string): ExperienceApiError =>
			({ status: 422, code: "round_verification_failed", message });
		const first = log[0];
		const last = log[log.length - 1];
		if (first === undefined || first.kind !== "round_started") {
			return err(fail("Round log must begin with a round_started event"));
		}
		if (last === undefined || last.kind !== "round_finished") {
			return err(fail("Round log must end with a round_finished event"));
		}
		if (last.status !== claim.status) {
			return err(fail(`Claim status '${claim.status}' does not match the log's round_finished '${last.status}'`));
		}
		for (let i = 1; i < log.length - 1; i += 1) {
			if (log[i]!.kind === "round_finished") {
				return err(fail("round_finished may only be the final event of the log"));
			}
		}

		// ── 3. Seed provenance + pinned-rules discovery ──────────────────────
		const numericSeed = seedToNumeric(session.randomSeed);
		if (first.seed !== numericSeed) {
			return err(fail(`Round seed ${String(first.seed)} does not match the session's pinned seed — the round must run on the seed the session pinned at creation`));
		}
		const discovery = discoverExperienceDefinition(session.rulesSource, session.rulesLabel);
		if (!discovery.ok) {
			return err(fail(`Pinned rules source failed discovery: ${discovery.message}`));
		}
		const definition = discovery.definition;
		const tickMs = definition.manifest.tickMs;
		if (definition.hasUpdate && tickMs === undefined) {
			return err(fail("Realtime package declares update but the manifest carries no tickMs"));
		}

		// ── 4. Re-derive the round's initial state (mirror of the start path) ─
		const participants = parseJson<ExperienceParticipant[]>(session.participantsJson, []);
		const grants = parseJson<ExperienceCapability[]>(session.capabilityGrantsJson, []);
		const settings = parseJson<unknown>(session.initialSettingsJson, {});
		const createRng = createCountingRandom(numericSeed, 0);
		const created = runCreate(
			session.rulesSource,
			session.rulesLabel,
			settings,
			buildCapabilityContext(grants, participants, createRng.random),
		);
		if (!created.ok) {
			return err(fail(`create did not reproduce under the pinned seed/settings: ${created.message}`));
		}
		let state: unknown = created.value;

		// ── 5. Round cursor + capability surfaces (mirror the FRAME host) ────
		// Ungated by design — see the header note. participants is always
		// present (even an empty roster) because the frame passes the round
		// config's roster verbatim; author code sees a stable context shape.
		const cursor = createDeterministicRandom(first.seed);
		const tickCaps: ExperienceCapabilityContext = { random: cursor, participants };
		const legalityCaps: ExperienceCapabilityContext = { participants };
		const rules = { code: session.rulesSource, name: session.rulesLabel, tickCaps, legalityCaps };
		const humanViewer = resolveHumanViewer(participants);
		const findSeat = (participantId: string): ExperienceViewer | null => {
			const participant = participants.find((p) => p.id === participantId);
			if (participant === undefined) return null;
			return { kind: viewerKindForController(participant.controller), participantId };
		};

		// ── 6. The replay loop ───────────────────────────────────────────────
		let totalTicks = 0;
		// Set when a transition completes the round mid-log: nothing but the
		// terminal round_finished may follow (the live loop finishes there).
		let expectFinish = false;
		for (let i = 1; i < log.length - 1; i += 1) {
			const event = log[i]!;
			if (expectFinish) {
				return err(fail("Events after a completing transition must not precede round_finished"));
			}
			switch (event.kind) {
				case "round_started":
					return err(fail("round_started may only be the first event of the log"));
				case "round_finished":
					return err(fail("round_finished may only be the final event of the log"));

				case "ticks": {
					if (!definition.hasUpdate || tickMs === undefined) {
						return err(fail("ticks event in a package whose loop never advances time — an honest log cannot contain it"));
					}
					if (event.count > EXPERIENCE_LOOP_MAX_BATCHED_TICKS) {
						return err(fail(`Tick batch ${String(event.count)} exceeds the flush threshold ${String(EXPERIENCE_LOOP_MAX_BATCHED_TICKS)} — an honest loop flushes at the threshold`));
					}
					totalTicks += event.count;
					if (totalTicks > EXPERIENCE_LOOP_MAX_ROUND_TICKS) {
						return err(fail(`Total ticks ${String(totalTicks)} exceed the shared watchdog bound ${String(EXPERIENCE_LOOP_MAX_ROUND_TICKS)}`));
					}
					for (let t = 0; t < event.count; t += 1) {
						const tickNo = totalTicks - event.count + t + 1;
						const transition = runUpdate(session.rulesSource, session.rulesLabel, state, tickMs, tickCaps);
						if (!transition.ok) {
							return err(fail(`update failed during replay at tick ${String(tickNo)} (the live loop would have died): ${transition.message}`));
						}
						state = transition.value.state;
						if (transition.value.status === "completed") {
							if (t !== event.count - 1) {
								return err(fail("update completed mid-batch — an honest log would have flushed a shorter batch and finished"));
							}
							expectFinish = true;
						}
					}
					break;
				}

				case "input": {
					const outcome = this.applyMove(rules, event.action, humanViewer, state, { fail });
					if (!outcome.ok) return outcome;
					state = outcome.state;
					if (outcome.completed) expectFinish = true;
					break;
				}

				case "script_move": {
					const viewer = findSeat(event.participantId);
					if (viewer === null) {
						return err(fail(`script_move from undeclared seat '${event.participantId}'`));
					}
					const outcome = this.applyMove(rules, event.action, viewer, state, { fail });
					if (!outcome.ok) return outcome;
					state = outcome.state;
					if (outcome.completed) expectFinish = true;
					break;
				}

				case "model_request": {
					const seat = findSeat(event.seatId);
					if (seat === null || seat.kind !== "model") {
						return err(fail(`model_request for undeclared model seat '${event.seatId}'`));
					}
					// Informational only — the request is never re-generated.
					break;
				}

				case "model_result": {
					const seat = findSeat(event.seatId);
					if (seat === null || seat.kind !== "model") {
						return err(fail(`model_result for undeclared model seat '${event.seatId}'`));
					}
					const intent = asIntent(event.result);
					if (intent === null) break; // recorded, never applied — mirror of applyModelResult
					// The implied reduce synthesizes inert idempotency fields
					// (the frame's own loop-N-M values never touch state).
					const action = {
						type: intent.type,
						participantId: event.seatId,
						...(intent.payload !== undefined ? { payload: intent.payload } : {}),
						requestId: `replay-model-${String(i)}`,
						expectedRevision: 0,
					};
					const outcome = this.applyMove(rules, action, seat, state, { fail }, true);
					if (!outcome.ok) return outcome;
					state = outcome.state;
					if (outcome.completed) expectFinish = true;
					break;
				}
			}
		}

		// ── 7. State-hash compare (canonical JSON — no hash-collision slack) ─
		// A completing transition can only be followed by round_finished with
		// status "completed" — an "interrupted" finish there never happens live
		// (finishNow is a player action at a tick boundary, not a completion).
		if (expectFinish && last.status !== "completed") {
			return err(fail("A completing transition was followed by round_finished 'interrupted' — an honest loop finishes 'completed' there"));
		}
		const replayedJson = canonicalJson(state);
		const claimedJson = canonicalJson(claim.finalState);
		if (replayedJson !== claimedJson) {
			return err(fail("Claimed finalState does not match the replayed round state"));
		}

		// ── 8. ONE terminal transition + the finish-writeback card ──────────
		const stateHash = sha256Hex(replayedJson);
		const roundEvent: ExperienceEvent = {
			visibility: "public",
			type: "round_finished",
			detail: {
				status: claim.status,
				...(claim.score !== undefined ? { score: claim.score } : {}),
				...(claim.summary !== undefined ? { summary: claim.summary } : {}),
			},
		};
		const applied = await this.stores.experiences.applyTransition({
			sessionId,
			expectedRevision: session.revision,
			requestId: null,
			kind: "round_commit",
			actorSnapshotJson: null,
			inputJson: JSON.stringify({
				status: claim.status,
				seed: first.seed,
				ticks: totalTicks,
				events: log.length,
				logDigest: sha256Hex(canonicalJson(log)),
				...(claim.score !== undefined ? { score: claim.score } : {}),
				...(claim.summary !== undefined ? { summary: claim.summary } : {}),
			}),
			emittedEventsJson: JSON.stringify([roundEvent]),
			emittedEffectsJson: "[]",
			stateHash,
			message: null,
			newCurrentStateJson: replayedJson,
			newStatus: claim.status,
			// The round cursor is a SEPARATE stream from the session cursor —
			// the client round never drew from the session's counting random.
			newRandomCursor: session.randomCursor,
		});
		if (!applied.ok) {
			return err({
				status: 409,
				code: "stale_revision",
				message: "Session revision changed before the round commit could be applied",
				currentRevision: session.revision,
			});
		}
		return this.reports.finish(sessionId, applied.session.revision, {
			finishDetail: `Realtime round ${claim.status}.`,
		});
	}

	// ─── Move application (input / script_move / implied model move) ─────────

	/**
	 * Legality-check + apply one logged move, mirroring the live loop exactly:
	 * `actions()` under the cursor-free capability surface, then
	 * `validateSubmittedAction` (an honest loop DROPS a failing input before
	 * logging it — a logged failure means the log is a lie), then `reduce`
	 * under the round cursor. When `dropOnIllegal` is set (the model-move
	 * path) an illegal move is a legitimate live outcome and is skipped.
	 */
	private applyMove(
		rules: { code: string; name: string; tickCaps: ExperienceCapabilityContext; legalityCaps: ExperienceCapabilityContext },
		action: ExperienceAction,
		viewer: ExperienceViewer,
		state: unknown,
		hooks: { fail: (message: string) => ExperienceApiError },
		dropOnIllegal = false,
	):
		| { ok: true; state: unknown; completed: boolean }
		| { ok: false; error: ExperienceApiError } {
		const legality = runActions(rules.code, rules.name, state, viewer, rules.legalityCaps);
		if (!legality.ok) {
			return { ok: false, error: hooks.fail(`actions failed during replay (the live loop would have died): ${legality.message}`) };
		}
		const check = validateSubmittedAction(action, legality.value);
		if (!check.ok) {
			if (dropOnIllegal) return { ok: true, state, completed: false };
			return { ok: false, error: hooks.fail(`logged move '${action.type}' is not legal at its position — an honest loop drops such a move before logging`) };
		}
		const reduced = runReduce(rules.code, rules.name, state, action, rules.tickCaps);
		if (!reduced.ok) {
			return { ok: false, error: hooks.fail(`reduce failed during replay: ${reduced.message}`) };
		}
		return { ok: true, state: reduced.value.state, completed: reduced.value.status === "completed" };
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A model reply is an action intent when it is `{ type: string, … }` — the
 *  frame loop host's `asIntent` VERBATIM (re-derives apply-vs-record). */
function asIntent(result: unknown): { type: string; payload?: unknown } | null {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
	const type = (result as { type?: unknown }).type;
	if (typeof type !== "string") return null;
	const payload = (result as { payload?: unknown }).payload;
	return { type, ...(payload !== undefined ? { payload } : {}) };
}

/**
 * Deterministic canonical JSON: object keys sorted recursively, arrays in
 * order, JSON.stringify number semantics. Two structurally equal states
 * serialize identically regardless of key insertion order, so the compare is
 * exact — no hash-collision slack.
 */
function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
	return `{${parts.join(",")}}`;
}

function sha256Hex(text: string): string {
	return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex");
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export type { ExperienceResult } from "./experience-shared.js";
