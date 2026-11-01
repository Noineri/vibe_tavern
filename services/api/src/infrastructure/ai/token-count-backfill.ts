/**
 * TC-6 — startup backfill of stored token counts (TOKEN_COUNT_ONCE_PLAN
 * Wave 4).
 *
 * After the update, every existing message, variant and history piece gets
 * its stored token count in ≤ 15 ms background slices, so an old long chat
 * opens with no counting pause — browser and server alike (TC-4/TC-5 ship
 * and read the counts; this pass makes sure they already exist on first
 * boot of the updated server).
 *
 * What gets counted per chat, chats visited in DESCENDING updated_at order
 * (the freshest chats benefit first):
 *   (a) ALWAYS the cl100k count of every message content and every variant
 *       content — exactly what TC-4 ships on the wire;
 *   (b) when the tokenizer of the chat's most recently used model (latest
 *       assistant variant's model_id → resolveTokenizerId) has a measured
 *       separator side, BOTH piece forms (bare + glued) of every message
 *       and variant piece in that tokenizer — the exact forms
 *       countHistoryPieces / estimateCoauthorHistoryTokens assemble from.
 *       Which piece is newest/oldest depends on the assembly and compaction
 *       suffixes shift it, so both forms are cached for every piece. Piece
 *       TEXTS come from the single TC-3 formatters — formatHistoryPiece for
 *       RP chats, formatCoauthorHistoryPieces (over the shared
 *       buildCoauthorHistoryMessages mapping) for co-author chats — never a
 *       second derivation. A null side (unmeasured tokenizer) or a chat
 *       with no assistant variants gets no piece rows: those assemblies
 *       keep the joined count.
 *
 * Mechanics:
 * - Time-sliced: after every work unit (one encode, one chunk lookup, one
 *   message's task building) the injected clock is consulted; once 15 ms of
 *   work have accumulated, the pass yields through setTimeout(0) so
 *   requests interleave — the plan exists because a preview once froze the
 *   whole server for seconds; this pass must never be a smaller version of
 *   that. The per-slice durations are recorded in the returned stats (the
 *   tests enforce the budget through the injected clock — never sleeps).
 * - Crash-resumable: rows are idempotent (insert-or-ignore, persisted by
 *   the TC-2 layer's synchronous write-through). Existence is checked with
 *   a batched getMany BEFORE a chunk is encoded, so a resumed pass never
 *   re-encodes rows a previous pass already stored. The
 *   `app_data_migrations` marker (`token-count-backfill-v1`) is written
 *   only after the FULL pass; a boot with the marker skips the scan
 *   entirely.
 * - Per-chat failures are logged and skipped, never fatal: one broken chat
 *   (e.g. corrupt JSON columns) must not block the marker forever — its
 *   counts stay lazy (first-preview class below).
 *
 * Named limits (plan Wave 4, by design — do not "fix"):
 * - A piece whose prompt-time text differs from the stored content (a
 *   macro, a regex script, a model switched since the pass) is counted at
 *   that chat's first preview — one encode per such message, once.
 * - Texts above the TC-2 persistence cutoff (100 000 chars) are memory-only
 *   by design and are skipped here; empty texts count 0 by contract and
 *   never get a row.
 */

import { tokenCountKey, type AppDb, type Chat, type ChatBranch, type Message, type MessageVariant } from "@vibe-tavern/db";
import { formatHistoryPiece } from "@vibe-tavern/prompt-pipeline";
import {
	buildCoauthorHistoryMessages,
	formatCoauthorHistoryPieces,
	isCoauthorHistoryRole,
} from "../../domain/chat/coauthor-prompt.js";
import {
	countTokens,
	countTokensDefault,
	resolveTokenizerId,
	separatorSide,
	tokenCountTextHash,
} from "./tokenizer-service.js";

const MARKER_TABLE = "app_data_migrations";
const MARKER_NAME = "token-count-backfill-v1";
/** The plan's non-negotiable: no background slice holds the single Bun thread longer. */
const SLICE_BUDGET_MS = 15;
/** Store-existence chunks; getMany binds 2 params per entry (its floor is 300). */
const CHUNK_TEXTS = 200;

/** Monotonic clock (ms) — injected so tests enforce the slice budget without sleeping. */
export interface TokenCountBackfillClock {
	now(): number;
}

export interface TokenCountBackfillOptions {
	/** Default: performance.now(). */
	readonly clock?: TokenCountBackfillClock;
	/** Macrotask yield between slices — default setTimeout(0), so requests interleave. */
	readonly yieldToEventLoop?: () => Promise<void>;
}

/**
 * Structural on purpose (the same discipline as the avatar backfill's IO):
 * the real StoreContainer members satisfy it; tests can pass fakes. No
 * db-package runtime import — this module orchestrates, the stores own SQL.
 */
export interface TokenCountBackfillDeps {
	readonly chats: {
		/** Chats in DESCENDING updated_at order (the store owns that ordering). */
		listAll(): Promise<Array<Pick<Chat, "id" | "mode" | "activeBranchId">>>;
		getBranches(chatId: string): Promise<Array<Pick<ChatBranch, "id">>>;
	};
	readonly messages: {
		getMessages(branchId: string): Promise<Message[]>;
		getVariantsByBranch(branchId: string): Promise<Map<string, MessageVariant[]>>;
	};
	readonly tokenCounts: {
		getMany(
			entries: ReadonlyArray<{ textHash: string; tokenizer: string }>,
		): Promise<Map<string, { tokenCount: number }>>;
	};
	/** Raw handle for the marker table (same pattern as the db boot passes). */
	readonly db: AppDb;
}

export interface TokenCountBackfillStats {
	/** The completion marker was already present — nothing was scanned. */
	readonly skippedByMarker: boolean;
	readonly chatsScanned: number;
	/** Chats in processing order (descending updated_at) — the freshest-first pin. */
	readonly processedChatIds: readonly string[];
	/** Chats whose processing threw (logged; their counts stay lazy). */
	readonly failedChatIds: readonly string[];
	/** Distinct (text, tokenizer) pairs examined (post-dedup). */
	readonly textsConsidered: number;
	/** Pairs already stored — skipped without encoding (resume). */
	readonly rowsSkipped: number;
	/** Pairs encoded this pass (each persisted by the TC-2 write-through). */
	readonly rowsEncoded: number;
	readonly slices: number;
	/** Sync-work duration per completed slice — the ≤ 15 ms budget evidence. */
	readonly sliceDurationsMs: readonly number[];
	readonly markedComplete: boolean;
}

/** One (text, tokenizer) pair to ensure a stored row for. */
interface CountTask {
	readonly text: string;
	readonly hash: string;
	readonly tokenizerId: string;
	/** countTokens model for the family tokenizer; undefined → countTokensDefault (cl100k). */
	readonly model: string | undefined;
}

/** The chat's piece-counting plan; null when no piece rows are wanted. */
interface FamilyPlan {
	readonly model: string | undefined;
	readonly tokenizerId: string;
	readonly side: "after" | "before";
}

/** Raw handle access for the marker table — the same pattern as the db
 *  package's boot passes (trace-variant-backfill.ts); drizzle-orm is not a
 *  direct dependency of this package. All statements are synchronous
 *  (bun:sqlite) and touch a one-row table. */
function markerClient(db: AppDb): import("bun:sqlite").Database {
	return db.$client;
}

async function isTokenCountBackfillApplied(db: AppDb): Promise<boolean> {
	const client = markerClient(db);
	client.run(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
	// bun:sqlite returns null (not undefined) when no row matches.
	const row = client.query(`SELECT name FROM ${MARKER_TABLE} WHERE name = ?`).get(MARKER_NAME);
	return row !== undefined && row !== null;
}

async function markTokenCountBackfillApplied(db: AppDb): Promise<void> {
	markerClient(db)
		.query(`INSERT OR REPLACE INTO ${MARKER_TABLE} (name, applied_at) VALUES (?, ?)`)
		.run(MARKER_NAME, new Date().toISOString());
}

/**
 * The chat's most recently used model: the LATEST variant on an assistant
 * message across every branch (max createdAt, then message position, then
 * variantIndex — deterministic tie-breaks). Null when the chat has no
 * assistant variant at all → no piece rows (plan TC-6 self-check).
 */
function resolveLatestAssistantVariant(
	branchData: ReadonlyArray<{ messages: Message[]; variantsByMessage: Map<string, MessageVariant[]> }>,
): MessageVariant | null {
	let latest: { variant: MessageVariant; position: number } | null = null;
	for (const { messages, variantsByMessage } of branchData) {
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const variant of variantsByMessage.get(message.id) ?? []) {
				if (
					latest === null ||
					variant.createdAt > latest.variant.createdAt ||
					(variant.createdAt === latest.variant.createdAt &&
						(message.position > latest.position ||
							(message.position === latest.position && variant.variantIndex > latest.variant.variantIndex)))
				) {
					latest = { variant, position: message.position };
				}
			}
		}
	}
	return latest?.variant ?? null;
}

function familyPlanFor(latestAssistantVariant: MessageVariant | null): FamilyPlan | null {
	if (latestAssistantVariant === null) return null;
	const model = latestAssistantVariant.modelId ?? undefined;
	const tokenizerId = resolveTokenizerId(model);
	const side = separatorSide(tokenizerId);
	if (side === null) return null;
	return { model, tokenizerId, side };
}

const defaultClock: TokenCountBackfillClock = { now: () => performance.now() };

function defaultYieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One full backfill pass. Rejects only on a total failure (marker read/
 * write, chat listing); per-chat failures are collected in the stats.
 */
export async function runTokenCountBackfill(
	deps: TokenCountBackfillDeps,
	options: TokenCountBackfillOptions = {},
): Promise<TokenCountBackfillStats> {
	const clock = options.clock ?? defaultClock;
	const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;

	if (await isTokenCountBackfillApplied(deps.db)) {
		return {
			skippedByMarker: true,
			chatsScanned: 0,
			processedChatIds: [],
			failedChatIds: [],
			textsConsidered: 0,
			rowsSkipped: 0,
			rowsEncoded: 0,
			slices: 0,
			sliceDurationsMs: [],
			markedComplete: false,
		};
	}

	let chatsScanned = 0;
	const processedChatIds: string[] = [];
	const failedChatIds: string[] = [];
	let textsConsidered = 0;
	let rowsSkipped = 0;
	let rowsEncoded = 0;
	let slices = 0;
	const sliceDurationsMs: number[] = [];

	let sliceStart = clock.now();
	/** Set when the yield/timer infrastructure itself fails — the pass then
	 *  aborts WITHOUT the marker (a killed process is exactly a yield that
	 *  never returns; the next boot resumes), unlike a single chat's data
	 *  failure, which is logged and skipped. */
	let passAborted = false;
	const yieldIfDue = async (): Promise<void> => {
		const elapsed = clock.now() - sliceStart;
		if (elapsed < SLICE_BUDGET_MS) return;
		sliceDurationsMs.push(elapsed);
		slices += 1;
		try {
			await yieldToEventLoop();
		} catch (error) {
			passAborted = true;
			throw error;
		}
		sliceStart = clock.now();
	};

	let pending: CountTask[] = [];
	const seenKeys = new Set<string>();

	const flush = async (): Promise<void> => {
		if (pending.length === 0) return;
		const chunk = pending;
		pending = [];
		textsConsidered += chunk.length;
		// Resume check FIRST: a batched existence read decides which pairs a
		// previous (crashed) pass already stored — those are never re-encoded.
		const existing = await deps.tokenCounts.getMany(
			chunk.map((task) => ({ textHash: task.hash, tokenizer: task.tokenizerId })),
		);
		for (const task of chunk) {
			if (existing.has(tokenCountKey(task.hash, task.tokenizerId))) {
				rowsSkipped += 1;
				continue;
			}
			// Encode through the TC-2 layered path (the one encode derivation):
			// the count lands in the memory LRU AND persists via the layer's
			// synchronous insert-or-ignore write-through.
			if (task.model === undefined) countTokensDefault(task.text);
			else countTokens(task.text, task.model);
			rowsEncoded += 1;
			await yieldIfDue();
		}
	};

	const processChat = async (chat: Pick<Chat, "id" | "mode" | "activeBranchId">): Promise<void> => {
		seenKeys.clear();
		const branches = await deps.chats.getBranches(chat.id);
		const branchData: Array<{
			branchId: string;
			messages: Message[];
			variantsByMessage: Map<string, MessageVariant[]>;
		}> = [];
		for (const branch of branches) {
			const messages = await deps.messages.getMessages(branch.id);
			const variantsByMessage = await deps.messages.getVariantsByBranch(branch.id);
			branchData.push({ branchId: branch.id, messages, variantsByMessage });
			await yieldIfDue();
		}

		const family = familyPlanFor(resolveLatestAssistantVariant(branchData));
		const cl100kId = resolveTokenizerId();

		const addTask = (tokenizerId: string, model: string | undefined, text: string): void => {
			if (text.length === 0) return; // counts 0 by contract; never stored
			const hash = tokenCountTextHash(text);
			if (hash === null) return; // over the persistence cutoff: memory-only by design
			const key = `${tokenizerId}\u0000${text}`;
			if (seenKeys.has(key)) return;
			seenKeys.add(key);
			pending.push({ text, hash, tokenizerId, model });
		};
		/** Both piece forms (bare + side-glued) — which piece is newest/oldest
		 *  depends on the assembly, and compaction suffixes shift it. */
		const addFamilyPiece = (piece: string): void => {
			if (family === null) return;
			addTask(family.tokenizerId, family.model, piece);
			addTask(family.tokenizerId, family.model, family.side === "after" ? `${piece}\n\n` : `\n\n${piece}`);
		};

		try {
			if (chat.mode === "coauthor") {
				// Co-author is a flat editor chat — the counter reads the ACTIVE
				// branch (same semantics as the assemble loader). Pieces come from
				// the shared mapping; a VARIANT's piece is the same mapping with
				// that variant's content injected (tool names still resolve from
				// the owning assistant's calls — hence the whole-set remap).
				const active =
					branchData.find((branch) => branch.branchId === chat.activeBranchId) ?? branchData[0];
				if (active === undefined) return;
				const historyRows = active.messages.filter((m) => isCoauthorHistoryRole(m.role));
				for (const piece of formatCoauthorHistoryPieces(buildCoauthorHistoryMessages(historyRows))) {
					addFamilyPiece(piece);
				}
				for (const message of active.messages) {
					addTask(cl100kId, undefined, message.content);
					for (const variant of active.variantsByMessage.get(message.id) ?? []) {
						addTask(cl100kId, undefined, variant.content);
						if (family !== null) {
							const index = historyRows.findIndex((row) => row.id === message.id);
							if (index >= 0) {
								const injected = historyRows.map((row, i) =>
									i === index ? { ...row, content: variant.content } : row,
								);
								const pieces = formatCoauthorHistoryPieces(buildCoauthorHistoryMessages(injected));
								const piece = pieces[index];
								if (piece !== undefined) addFamilyPiece(piece);
							}
							await yieldIfDue(); // bounds the O(messages) remap work per variant
						}
					}
					if (pending.length >= CHUNK_TEXTS) await flush();
					await yieldIfDue();
				}
				return;
			}

			// RP (and any other non-coauthor mode — the strategy registry maps
			// every mode onto one of the two, with 'rp' the DB default). Pieces
			// cover EVERY branch: any branch can be activated, and each branch's
			// window is what the RP counter formats.
			for (const branch of branchData) {
				for (const message of branch.messages) {
					addTask(cl100kId, undefined, message.content);
					if (family !== null) addFamilyPiece(formatHistoryPiece(message.role, message.content));
					for (const variant of branch.variantsByMessage.get(message.id) ?? []) {
						addTask(cl100kId, undefined, variant.content);
						if (family !== null) addFamilyPiece(formatHistoryPiece(message.role, variant.content));
					}
					if (pending.length >= CHUNK_TEXTS) await flush();
					await yieldIfDue();
				}
			}
		} finally {
			// A mid-chat failure still persists what it collected (rows are
			// idempotent) — a retry resumes from there, not from zero.
			if (pending.length > 0) await flush();
		}
	};

	const chats = await deps.chats.listAll();
	for (const chat of chats) {
		chatsScanned += 1;
		processedChatIds.push(chat.id);
		try {
			await processChat(chat);
		} catch (error) {
			if (passAborted) throw error; // infrastructure failure: abort, no marker
			failedChatIds.push(chat.id);
			console.warn(`[token-count-backfill] chat ${chat.id} failed, its counts stay lazy:`, error);
		}
		await yieldIfDue();
	}

	await markTokenCountBackfillApplied(deps.db);
	return {
		skippedByMarker: false,
		chatsScanned,
		processedChatIds,
		failedChatIds,
		textsConsidered,
		rowsSkipped,
		rowsEncoded,
		slices,
		sliceDurationsMs,
		markedComplete: true,
	};
}

/**
 * Fire-and-forget wrapper for server startup (server-runtime.ts, after
 * «Application ready»): like the avatar backfill next to it, this never
 * delays or fails startup — the pass runs in the background and a crash of
 * the whole pass is caught and logged here.
 */
export function scheduleTokenCountBackfill(
	deps: TokenCountBackfillDeps,
	options?: TokenCountBackfillOptions,
): void {
	void runTokenCountBackfill(deps, options)
		.then((stats) => {
			if (stats.skippedByMarker) {
				console.log("[token-count-backfill] completion marker present — scan skipped.");
				return;
			}
			const maxSlice = stats.sliceDurationsMs.length > 0 ? Math.max(...stats.sliceDurationsMs) : 0;
			console.log(
				`[token-count-backfill] ${stats.chatsScanned} chat(s): ${stats.rowsEncoded} count(s) stored, ` +
					`${stats.rowsSkipped} already present, ${stats.slices} slice(s), max slice ${Math.round(maxSlice)} ms` +
					(stats.failedChatIds.length > 0
						? `, ${stats.failedChatIds.length} chat(s) failed (see warnings above)`
						: "") +
					".",
			);
		})
		.catch((error) => {
			console.error("[token-count-backfill] pass crashed:", error);
		});
}
