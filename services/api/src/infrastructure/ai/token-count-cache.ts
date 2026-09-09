/**
 * Token-count cache — provider-exact counting layer for LS-1b
 * (LOCAL_SUPPORT_PLAN: "exact token counting via backend tokenize endpoints").
 *
 * Core mechanic (owner-approved 2026-09-09): **exactness arrives via cache,
 * never blocks assembly.** The counting seam (`tokenizer-service.countTokens`)
 * is synchronous by contract and runs many times per prompt assembly (lore
 * engine, prompt-pipeline compaction) — an HTTP tokenize round-trip must not
 * sit on that path. So:
 *
 * - An LRU keyed by `sha256(text) + providerKey` is read SYNCHRONOUSLY by
 *   `countTokens`; a hit returns the backend-exact count, a miss falls through
 *   to the existing family-tokenizer → cl100k ladder and SCHEDULES an
 *   asynchronous warm fetch (bounded queue) via the protocol adapter's
 *   `tokenize` capability (LS-1a).
 * - The provider context (protocol / baseUrl / apiKey / modelId) is supplied
 *   by the send/preview orchestrator (which already resolves the profile)
 *   through an AsyncLocalStorage scope (`runWithProviderTokenContext`) — no
 *   signature changes across the resolver/pipeline, and concurrent assemblies
 *   for different chats cannot clobber each other's context.
 * - Per-turn text is mostly stable (old messages are immutable), so counts
 *   converge to exact after the first turn of a chat.
 *
 * Ladder stays three steps: provider-exact (cache hit) → family tokenizer file
 * → cl100k. Endpoint absent/offline must never throw: fetch rejects land in a
 * per-provider offline cooldown and the ladder estimate is used.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { normalizeProviderType, type ProviderType, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { resolveProtocol } from "../../domain/providers/protocol-registry.js";

// ─── Provider context scope ──────────────────────────────────────────────

/** Provider knowledge needed to reach the backend tokenize endpoint. */
export interface ProviderTokenContext {
	protocol: ProviderType;
	baseUrl: string;
	apiKey: string | null;
	modelId: string;
	/** Stable cache-namespace key: protocol + endpoint + model. */
	providerKey: string;
}

const scope = new AsyncLocalStorage<ProviderTokenContext>();

/**
 * Run `fn` with a provider token context in scope. Every `countTokens` call
 * inside (through any await depth) consults the exact-count cache for this
 * provider and schedules warm fetches on misses. `null` context → pure local
 * ladder (cloud providers, unresolved models).
 */
export function runWithProviderTokenContext<T>(
	ctx: ProviderTokenContext | null,
	fn: () => Promise<T>,
): Promise<T> {
	if (!ctx) return fn();
	return scope.run(ctx, fn);
}

/** The in-scope provider token context, or null when none was set. */
export function activeProviderTokenContext(): ProviderTokenContext | null {
	return scope.getStore() ?? null;
}

/**
 * Build the context from an already-resolved provider profile + model.
 * Returns null when there is nothing to warm: no model, or the protocol
 * adapter exposes no `tokenize` capability (LM Studio, cloud providers).
 * Never throws.
 */
export function providerTokenContextFromProfile(
	profile: Pick<StoredProviderProfileRecord, "providerPreset" | "endpoint" | "apiKey">,
	model: string | null | undefined,
): ProviderTokenContext | null {
	if (!model || !profile?.endpoint) return null;
	const protocol: ProviderType = normalizeProviderType(profile.providerPreset);
	try {
		if (!resolveProtocol(protocol).tokenize) return null;
	} catch {
		return null;
	}
	const baseUrl = profile.endpoint.replace(/\/+$/, "");
	return {
		protocol,
		baseUrl,
		apiKey: profile.apiKey,
		modelId: model,
		providerKey: `${protocol}|${baseUrl}|${model}`,
	};
}

// ─── Cache ────────────────────────────────────────────────────────────────

interface CacheEntry {
	count: number;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Tunables (tests may tighten TTL/capacity/queue; defaults for production). */
const config = {
	ttlMs: 30 * 60_000,
	capacity: 512,
	warmQueueMax: 64,
	offlineCooldownMs: 60_000,
};

function now(): number {
	return Date.now();
}

function cacheKey(providerKey: string, text: string): string {
	return `${providerKey}\u0000${createHash("sha256").update(text).digest("hex")}`;
}

/** Per-providerKey offline cooldown after a failed warm (endpoint absent/offline). */
const offlineUntil = new Map<string, number>();

function isOffline(providerKey: string): boolean {
	const until = offlineUntil.get(providerKey);
	if (until === undefined) return false;
	if (until <= now()) {
		offlineUntil.delete(providerKey);
		return false;
	}
	return true;
}

// ─── Bounded background warm queue ───────────────────────────────────────

interface WarmJob {
	key: string;
	text: string;
	ctx: ProviderTokenContext;
}

const pendingWarm = new Map<string, WarmJob>();
let draining = false;
let inFlight = 0;
/** Resolvers for waitForTokenWarmIdle — fired when pending + inFlight hit 0. */
const idleWaiters: Array<() => void> = [];

function notifyIdleIfSettled(): void {
	if (pendingWarm.size === 0 && inFlight === 0) {
		for (const resolve of idleWaiters.splice(0)) resolve();
	}
}

/**
 * Test/observability seam: resolves when every scheduled warm job has settled
 * (cache filled or endpoint failed). Never rejects.
 */
export function waitForTokenWarmIdle(): Promise<void> {
	if (pendingWarm.size === 0 && inFlight === 0) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

function scheduleWarm(key: string, text: string, ctx: ProviderTokenContext): void {
	if (pendingWarm.has(key) || cache.has(key)) return;
	// Bound the warm pass: the top-N uncached chunks seen this assembly. The
	// queue is FIFO — the oldest (first-counted) chunks are the most stable
	// ones (old messages / system prompt), so dropping the newest overflow is
	// the right eviction side.
	if (pendingWarm.size >= config.warmQueueMax) {
		const oldest = pendingWarm.keys().next().value;
		if (oldest !== undefined) pendingWarm.delete(oldest);
	}
	pendingWarm.set(key, { key, text, ctx });
	void drainWarmQueue();
}

async function drainWarmQueue(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		while (pendingWarm.size > 0) {
			const job = pendingWarm.values().next().value;
			if (!job) break;
			pendingWarm.delete(job.key);
			inFlight++;
			try {
				const count = await tokenizeViaAdapter(job.ctx, job.text);
				setCacheEntry(job.key, count);
			} catch {
				// Endpoint absent/offline/misbehaving — cool the provider down and
				// stay on the local ladder. Never propagate into assembly.
				offlineUntil.set(job.ctx.providerKey, now() + config.offlineCooldownMs);
			} finally {
				inFlight--;
			}
		}
	} finally {
		draining = false;
		notifyIdleIfSettled();
	}
}

async function tokenizeViaAdapter(ctx: ProviderTokenContext, text: string): Promise<number> {
	const adapter = resolveProtocol(ctx.protocol);
	if (!adapter.tokenize) throw new Error(`Protocol '${ctx.protocol}' has no tokenize capability.`);
	return adapter.tokenize({
		baseUrl: ctx.baseUrl,
		apiKey: ctx.apiKey,
		text,
		modelId: ctx.modelId,
	});
}

function setCacheEntry(key: string, count: number): void {
	if (cache.size >= config.capacity && !cache.has(key)) {
		// LRU eviction: the Map's first key is the least-recently-used entry
		// (hits re-insert, see readExactTokenCount).
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { count, expiresAt: now() + config.ttlMs });
}

/**
 * Synchronous exact-count read. Returns the cached backend count on a fresh
 * hit (refreshing TTL — chat activity keeps it warm), otherwise schedules a
 * bounded background warm fetch and returns null so the caller uses the local
 * tokenizer ladder. Never throws.
 */
export function readExactTokenCount(text: string, ctx: ProviderTokenContext): number | null {
	if (!text) return null;
	try {
		if (!resolveProtocol(ctx.protocol).tokenize) return null;
	} catch {
		return null;
	}
	if (isOffline(ctx.providerKey)) return null;
	const key = cacheKey(ctx.providerKey, text);
	const entry = cache.get(key);
	if (entry) {
		if (entry.expiresAt > now()) {
			// LRU touch: re-insert to move to the most-recent side + extend TTL
			// (TTL by chat activity — an actively-read count stays exact).
			cache.delete(key);
			cache.set(key, { count: entry.count, expiresAt: now() + config.ttlMs });
			return entry.count;
		}
		cache.delete(key);
	}
	scheduleWarm(key, text, ctx);
	return null;
}

// ─── Test/tuning seams ───────────────────────────────────────────────────

/** Override cache tunables (tests: TTL/capacity/queue/cooldown). */
export function configureTokenCountCache(opts: Partial<typeof config>): void {
	Object.assign(config, opts);
}

/** Drop all cached counts, cooldowns, and pending warm jobs (test isolation). */
export function resetTokenCountCache(): void {
	cache.clear();
	offlineUntil.clear();
	pendingWarm.clear();
	notifyIdleIfSettled();
}
