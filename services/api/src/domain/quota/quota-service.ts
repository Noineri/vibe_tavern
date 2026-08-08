/**
 * @module quota-service
 *
 * The quota poller: the only thing in the system that talks to a vendor's quota
 * endpoint. Fully automatic — there is deliberately no manual refresh route and
 * no user-editable endpoint anywhere in the feature. A profile is polled while
 * ANY of its toggles is on (notifications need fresh data even with display
 * off), and not at all otherwise.
 *
 * Per profile it owns exactly one timer. Each tick resolves the adapter, runs
 * every request the adapter asks for through the proxy-aware provider fetch,
 * normalizes, persists, and — for windowed providers — feeds the transition
 * state machine and emits whatever events the event ledger accepts as new.
 *
 * Raw vendor payloads never leave this module: they are parsed, normalized, and
 * dropped. Nothing is logged that could contain key material.
 */

import {
	PROVIDER_PROFILE_CHANGE_KIND,
	PROVIDER_QUOTA_ERROR_KIND,
	PROVIDER_QUOTA_EVENT_KIND,
	PROVIDER_QUOTA_EVENT_NAME,
	PROVIDER_QUOTA_KIND,
	isQuotaPollingEnabled,
	quotaPollIntervalMs,
	tag,
	type BalanceProviderQuotaSnapshot,
	type EventBus,
	type NoProviderQuotaSnapshot,
	type ProviderQuotaConfig,
	type ProviderQuotaErrorKind,
	type ProviderQuotaEvent,
	type StoredProviderProfileRecord,
	type WindowedProviderQuotaConfig,
	type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import { defaultQuotaConfigForKind, type QuotaStore } from "@vibe-tavern/db";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { resolveProviderFetchForProfile } from "../providers/provider-fetch-factory.js";
import type { ProviderFetch } from "../providers/provider-fetch-factory.js";
import {
	isPollableCapability,
	type QuotaCapabilityAdapter,
	type QuotaRequestResult,
	type QuotaRequestSpec,
	type QuotaResponseJson,
} from "./quota-capability-types.js";
import { resolveQuotaAdapter } from "./quota-registry.js";
import { evaluateWindowedQuotaTransitions } from "./quota-transitions.js";

const log = tag("quota");

/** Floor on any adapter's declared interval — nobody gets to hammer a vendor. */
export const QUOTA_MIN_POLL_INTERVAL_MS = 60_000;
export const QUOTA_DEFAULT_POLL_INTERVAL_MS = 300_000;
/** ±10% so a hundred profiles do not all fire on the same second after a restart. */
const JITTER_RATIO = 0.1;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

/** What changed about a profile, so the resync knows how much state to discard. */
export interface QuotaProfileChange {
	readonly presetChanged?: boolean;
	readonly endpointChanged?: boolean;
	readonly apiKeyChanged?: boolean;
	readonly deleted?: boolean;
}

export interface QuotaServiceDeps {
	readonly quota: QuotaStore;
	readonly profiles: ProviderProfileService;
	readonly events: EventBus;
	/** Proxy-aware transport resolution. Injectable so tests never touch the network. */
	readonly resolveFetch?: (profile: StoredProviderProfileRecord) => Promise<ProviderFetch | undefined>;
	readonly now?: () => Date;
	/** Jitter source. Injected in tests so schedules are exact. */
	readonly random?: () => number;
}

export class QuotaService {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly failures = new Map<string, number>();
	private lifecycle: (() => void) | null = null;
	private running = false;

	constructor(private readonly deps: QuotaServiceDeps) {}

	/** Load persisted settings and schedule an immediate first poll for each active profile. */
	async start(): Promise<void> {
		this.running = true;

		// Profile edits reach us as a domain event, never as a call from the
		// providers module — that module must not know quota exists.
		this.lifecycle?.();
		this.lifecycle = this.deps.events.on("provider.profile.changed", (event) => {
			void this.resyncProfile(event.profileId, {
				presetChanged: event.presetChanged,
				endpointChanged: event.endpointChanged,
				apiKeyChanged: event.apiKeyChanged,
				deleted: event.changeKind === PROVIDER_PROFILE_CHANGE_KIND.delete,
			});
		});

		const settings = await this.deps.quota.listSettings();
		for (const record of settings) {
			if (isQuotaPollingEnabled(record.config)) this.schedule(record.providerProfileId, 0);
		}
		log.info("polling %d provider profile(s)", this.timers.size);
	}

	/** Cancel every timer and unsubscribe. After this the service makes no further requests. */
	stop(): void {
		this.running = false;
		this.lifecycle?.();
		this.lifecycle = null;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.failures.clear();
	}

	/** Timers currently armed. Test seam — a stopped service must report zero. */
	get pendingTimerCount(): number {
		return this.timers.size;
	}

	/**
	 * React to a profile edit or deletion.
	 *
	 * The rules follow what the stored state can still honestly claim: a preset
	 * or endpoint change may point at a different vendor entirely (drop the
	 * snapshot, install the new kind's default config, keeping the display
	 * toggle the user set); an API-key change points at a different ACCOUNT, so
	 * the old account's numbers and its notification history are meaningless.
	 */
	async resyncProfile(profileId: string, change: QuotaProfileChange = {}): Promise<void> {
		this.cancel(profileId);
		if (change.deleted) return;

		const profile = await this.deps.profiles.getProviderProfile(profileId);
		if (!profile) return;

		const capability = resolveQuotaAdapter(profile.providerPreset, profile.endpoint);
		const stored = await this.deps.quota.getSettings(profileId);

		if (stored && stored.config.kind !== capability.kind) {
			await this.deps.quota.upsertSettings(profileId, rebaseConfig(stored.config, capability.kind));
		}

		const identityChanged = change.presetChanged || change.endpointChanged || change.apiKeyChanged;
		if (identityChanged) {
			await this.deps.quota.deleteSnapshot(profileId);
		}
		if (change.apiKeyChanged) {
			// A different account may legitimately re-cross the same threshold.
			await this.deps.quota.deleteEvents(profileId);
		}

		const config = (await this.deps.quota.getSettings(profileId))?.config;
		if (this.running && config && isQuotaPollingEnabled(config)) this.schedule(profileId, 0);
	}

	private cancel(profileId: string): void {
		const timer = this.timers.get(profileId);
		if (timer !== undefined) clearTimeout(timer);
		this.timers.delete(profileId);
		this.failures.delete(profileId);
	}

	private schedule(profileId: string, delayMs: number): void {
		if (!this.running) return;
		const existing = this.timers.get(profileId);
		if (existing !== undefined) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.timers.delete(profileId);
			void this.pollProfile(profileId);
		}, delayMs);
		this.timers.set(profileId, timer);
	}

	private jittered(intervalMs: number): number {
		const random = this.deps.random ?? Math.random;
		const spread = intervalMs * JITTER_RATIO;
		return Math.round(intervalMs - spread + random() * spread * 2);
	}

	private backoffFor(profileId: string): number {
		const failures = this.failures.get(profileId) ?? 1;
		return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
	}

	private nowIso(): string {
		return (this.deps.now?.() ?? new Date()).toISOString();
	}

	/**
	 * One poll. Never throws — every failure path records an error kind, backs
	 * off, and reschedules, because a poller that dies on a bad response stops
	 * being a poller.
	 */
	private async pollProfile(profileId: string): Promise<void> {
		if (!this.running) return;

		const profile = await this.deps.profiles.getProviderProfile(profileId);
		if (!profile) {
			this.cancel(profileId);
			return;
		}

		const settings = await this.deps.quota.getSettings(profileId);
		if (!settings || !isQuotaPollingEnabled(settings.config)) {
			this.cancel(profileId);
			return;
		}

		const capability = resolveQuotaAdapter(profile.providerPreset, profile.endpoint);
		if (!isPollableCapability(capability)) {
			// Synthesized metadata: no timestamp, no timer, no request.
			const snapshot: NoProviderQuotaSnapshot = {
				kind: PROVIDER_QUOTA_KIND.none,
				providerProfileId: profileId,
				reason: capability.reason,
			};
			await this.deps.quota.upsertSnapshot(profileId, { snapshot, transitionState: null, lastError: null });
			this.cancel(profileId);
			return;
		}

		if (!profile.apiKey) {
			await this.recordFailure(profileId, PROVIDER_QUOTA_ERROR_KIND.auth);
			return;
		}

		try {
			const results = await this.executeRequests(capability, profile, profile.apiKey);
			const reading = capability.normalize(results);
			await this.applyReading(profileId, capability, settings.config, reading.windows, reading.balances);
			this.failures.delete(profileId);
			this.schedule(profileId, this.jittered(pollIntervalOf(settings.config)));
		} catch (error) {
			const kind = classifyError(error);
			log.warn("poll failed for profile %s (%s)", profileId, kind);
			await this.recordFailure(profileId, kind);
		}
	}

	private async executeRequests(
		adapter: QuotaCapabilityAdapter,
		profile: StoredProviderProfileRecord,
		apiKey: string,
	): Promise<QuotaRequestResult[]> {
		const specs = adapter.buildRequests(profile.endpoint, apiKey);
		const resolveFetch = this.deps.resolveFetch ?? resolveProviderFetchForProfile;
		const providerFetch = (await resolveFetch(profile)) ?? fetch;

		const results: QuotaRequestResult[] = [];
		for (const spec of specs) {
			results.push({ spec, json: await executeSpec(providerFetch, spec, adapter.requestTimeoutMs) });
		}
		return results;
	}

	/** Persist a fresh reading and emit whatever notifications it implies. */
	private async applyReading(
		profileId: string,
		adapter: QuotaCapabilityAdapter,
		config: ProviderQuotaConfig,
		windows: QuotaReading["windows"],
		balances: QuotaReading["balances"],
	): Promise<void> {
		const observedAt = this.nowIso();
		const stored = await this.deps.quota.getSnapshot(profileId);

		if (adapter.kind === PROVIDER_QUOTA_KIND.balance) {
			if (!balances || balances.length === 0) {
				throw new Error(`Adapter ${adapter.id} is a balance adapter but reported no balances`);
			}
			const snapshot: BalanceProviderQuotaSnapshot = {
				kind: PROVIDER_QUOTA_KIND.balance,
				providerProfileId: profileId,
				capabilityId: adapter.id,
				capabilityVersion: adapter.version,
				observedAt,
				balances,
			};
			await this.deps.quota.upsertSnapshot(profileId, { snapshot, transitionState: null, lastError: null });
			return;
		}

		const snapshot: WindowedProviderQuotaSnapshot = {
			kind: PROVIDER_QUOTA_KIND.windowed,
			providerProfileId: profileId,
			capabilityId: adapter.id,
			capabilityVersion: adapter.version,
			observedAt,
			windows: windows ?? [],
			...(balances && balances.length > 0 ? { balances } : {}),
		};

		const previous = stored?.snapshot?.kind === PROVIDER_QUOTA_KIND.windowed
			&& stored.snapshot.providerProfileId === profileId
			&& stored.snapshot.capabilityId === adapter.id
			? stored.snapshot
			: null;

		// A response that arrived out of order must not rewrite newer memory.
		if (previous && previous.observedAt > observedAt) return;

		const windowedConfig = asWindowedConfig(config);
		const { events, state } = evaluateWindowedQuotaTransitions(
			previous,
			snapshot,
			windowedConfig,
			stored?.transitionState ?? null,
			observedAt,
		);

		await this.deps.quota.upsertSnapshot(profileId, {
			snapshot,
			transitionState: state,
			lastError: null,
		});

		for (const event of events) {
			// The ledger is the restart dedupe: an id it has already seen must not
			// reach the bus a second time, however we got here.
			if (await this.deps.quota.recordEvent(event)) this.emit(event);
		}
	}

	private emit(event: ProviderQuotaEvent): void {
		if (event.kind === PROVIDER_QUOTA_EVENT_KIND.lowRemaining) {
			this.deps.events.emit(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, event);
			return;
		}
		this.deps.events.emit(PROVIDER_QUOTA_EVENT_NAME.windowReset, event);
	}

	/** Record the error next to the existing snapshot and back off. */
	private async recordFailure(profileId: string, kind: ProviderQuotaErrorKind): Promise<void> {
		const failures = (this.failures.get(profileId) ?? 0) + 1;
		this.failures.set(profileId, failures);

		const stored = await this.deps.quota.getSnapshot(profileId);
		await this.deps.quota.upsertSnapshot(profileId, {
			snapshot: stored?.snapshot ?? null,
			transitionState: stored?.transitionState ?? null,
			lastError: kind,
		});

		// A rejected key will still be rejected in thirty seconds. Go straight to
		// the cap and wait for the user to fix it (an edit triggers a resync).
		const delay = kind === PROVIDER_QUOTA_ERROR_KIND.auth ? BACKOFF_CAP_MS : this.backoffFor(profileId);
		this.schedule(profileId, delay);
	}
}

interface QuotaReading {
	windows?: WindowedProviderQuotaSnapshot["windows"];
	balances?: BalanceProviderQuotaSnapshot["balances"];
}

/**
 * How long until this profile's next poll.
 *
 * The user's configured period drives the schedule; the adapter's declared
 * `pollIntervalMs` is the suggestion a profile starts at (it is what the config
 * default is set to) and is reported by the capability route, not a second
 * scheduling authority. The hard one-minute floor still applies — the config
 * bounds already enforce it, and this re-states it against a hand-written row.
 */
function pollIntervalOf(config: ProviderQuotaConfig): number {
	return Math.max(QUOTA_MIN_POLL_INTERVAL_MS, quotaPollIntervalMs(config));
}

/**
 * Config for a kind that changed under us. The display toggle and the poll
 * period are the user's stated intent ("show me this provider's numbers, this
 * often") and survive the change; the notification settings belong to the old
 * kind and do not.
 */
function rebaseConfig(previous: ProviderQuotaConfig, kind: ProviderQuotaConfig["kind"]): ProviderQuotaConfig {
	const fresh = defaultQuotaConfigForKind(kind);
	if (fresh.kind === PROVIDER_QUOTA_KIND.none) return fresh;
	if (previous.kind === PROVIDER_QUOTA_KIND.none) return fresh;
	return { ...fresh, displayEnabled: previous.displayEnabled, pollIntervalMinutes: previous.pollIntervalMinutes };
}

function asWindowedConfig(config: ProviderQuotaConfig): WindowedProviderQuotaConfig {
	if (config.kind === PROVIDER_QUOTA_KIND.windowed) return config;
	// The stored row disagrees with the adapter (a preset edit mid-flight).
	// Poll with the kind's defaults; the resync writes the real row right after.
	if (config.kind === PROVIDER_QUOTA_KIND.none) return defaultWindowedConfig();
	return {
		...defaultWindowedConfig(),
		displayEnabled: config.displayEnabled,
		pollIntervalMinutes: config.pollIntervalMinutes,
	};
}

function defaultWindowedConfig(): WindowedProviderQuotaConfig {
	const fallback = defaultQuotaConfigForKind(PROVIDER_QUOTA_KIND.windowed);
	if (fallback.kind !== PROVIDER_QUOTA_KIND.windowed) {
		throw new Error("defaultQuotaConfigForKind returned the wrong kind for 'windowed'");
	}
	return fallback;
}

/** Non-2xx and transport failures carry an error kind so the route can explain them. */
class QuotaRequestError extends Error {
	constructor(message: string, readonly kind: ProviderQuotaErrorKind) {
		super(message);
		this.name = "QuotaRequestError";
	}
}

function classifyError(error: unknown): ProviderQuotaErrorKind {
	if (error instanceof QuotaRequestError) return error.kind;
	// Everything else reaching here is an adapter refusing a body it cannot make
	// sense of (Zod issue, normalization throw, allowlist rejection).
	return PROVIDER_QUOTA_ERROR_KIND.schema;
}

async function executeSpec(
	providerFetch: ProviderFetch,
	spec: QuotaRequestSpec,
	timeoutMs: number,
): Promise<QuotaResponseJson> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await providerFetch(spec.url, {
			method: spec.method,
			headers: { ...spec.headers },
			...(spec.body === undefined ? {} : { body: spec.body }),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			throw new QuotaRequestError(`Quota request rejected with ${response.status}`, PROVIDER_QUOTA_ERROR_KIND.auth);
		}
		if (!response.ok) {
			throw new QuotaRequestError(`Quota request failed with ${response.status}`, PROVIDER_QUOTA_ERROR_KIND.http);
		}
		try {
			const json: QuotaResponseJson = await response.json();
			return json;
		} catch {
			throw new QuotaRequestError("Quota response was not JSON", PROVIDER_QUOTA_ERROR_KIND.schema);
		}
	} catch (error) {
		if (error instanceof QuotaRequestError) throw error;
		throw new QuotaRequestError(
			error instanceof Error ? error.message : "Quota request failed",
			PROVIDER_QUOTA_ERROR_KIND.network,
		);
	} finally {
		clearTimeout(timer);
	}
}
