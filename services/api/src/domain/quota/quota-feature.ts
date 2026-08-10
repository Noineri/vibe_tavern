/**
 * @module quota-feature
 *
 * The quota HTTP surface: read the capability, read the state, write the three
 * toggles — and one global SSE channel for the two notification events.
 *
 * There is deliberately NO refresh route and no endpoint field anywhere in the
 * payloads. Polling is automatic and endpoints live only inside registry
 * adapters, so neither is something a client can ask for or change.
 *
 * The SSE channel is global rather than chat-scoped (the existing
 * `chat-events-feature` mirror): quota is an account-level fact, not a
 * conversation's. The `event:` field is the full bus event name, so the browser
 * listens on exactly the identifiers the backend emits.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { updateProviderQuotaConfigSchema } from "@vibe-tavern/api-contracts";
import type { ProviderQuotaCapabilityRecord, ProviderQuotaRecord } from "@vibe-tavern/api-contracts";
import {
	PROVIDER_QUOTA_EVENT_NAME,
	PROVIDER_QUOTA_KIND,
	type ProviderQuotaConfig,
	type ProviderQuotaEvent,
} from "@vibe-tavern/domain";
import { defaultQuotaConfigForKind, type QuotaStore } from "@vibe-tavern/db";
import type { FeatureDeps, FeatureModule } from "../../shared/feature-module.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { notFound, validation } from "../../shared/errors.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { isPollableCapability } from "./quota-capability-types.js";
import { resolveQuotaAdapter } from "./quota-registry.js";
import type { QuotaService } from "./quota-service.js";

export interface QuotaFeatureDeps {
	readonly quota: QuotaStore;
	readonly profiles: ProviderProfileService;
	readonly quotaService: QuotaService;
}

export function createQuotaFeature(deps: QuotaFeatureDeps): FeatureModule {
	return {
		id: "provider-quota",

		activate({ events, router }: FeatureDeps): void {
			router.route("/", createQuotaRoutes(deps));

			router.get("/api/quota/events", (c) => streamSSE(c, async (stream) => {
				const controller = new AbortController();
				stream.onAbort(() => controller.abort());

				const forward = (eventName: string) => (event: ProviderQuotaEvent) => {
					if (controller.signal.aborted) return;
					void stream
						.writeSSE({ event: eventName, data: JSON.stringify(event) })
						.catch((err: unknown) => {
							logSendDebug("quota.events.write.error", {
								message: err instanceof Error ? err.message : String(err),
							});
							controller.abort();
						});
				};

				events.on(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, forward(PROVIDER_QUOTA_EVENT_NAME.lowRemaining), { signal: controller.signal });
				events.on(PROVIDER_QUOTA_EVENT_NAME.windowReset, forward(PROVIDER_QUOTA_EVENT_NAME.windowReset), { signal: controller.signal });

				// Handshake AFTER subscribing: it flushes the headers so the client's
				// EventSource reaches OPEN, and doing it second means an event
				// emitted during the handshake is forwarded rather than lost.
				await stream.writeSSE({ event: "ready", data: "{}" });

				// Hold the response open; returning here would close the stream
				// before any event could be forwarded.
				await new Promise<void>((resolve) => {
					if (controller.signal.aborted) return resolve();
					controller.signal.addEventListener("abort", () => resolve(), { once: true });
				});
			}));
		},

		deactivate(): void {
			// Routes live on the shared router; SSE subscriptions unsubscribe via
			// their per-connection AbortController.
		},
	};
}

/** Split out so route tests can mount the endpoints without an SSE channel. */
export function createQuotaRoutes(deps: QuotaFeatureDeps) {
	return new Hono()
		.get("/api/providers/:providerId/quota-capability", async (c) => {
			const { capability } = await resolveProfileCapability(deps, c.req.param("providerId"));
			const record: ProviderQuotaCapabilityRecord = isPollableCapability(capability)
				? {
					providerProfileId: c.req.param("providerId"),
					kind: capability.kind,
					capabilityId: capability.id,
					capabilityVersion: capability.version,
					pollIntervalMs: capability.pollIntervalMs,
					reason: null,
				}
				: {
					providerProfileId: c.req.param("providerId"),
					kind: PROVIDER_QUOTA_KIND.none,
					capabilityId: null,
					capabilityVersion: null,
					pollIntervalMs: null,
					reason: capability.reason,
				};
			return c.json(record);
		})

		.get("/api/providers/:providerId/quota", async (c) => {
			return c.json(await readQuota(deps, c.req.param("providerId")));
		})

		.put(
			"/api/providers/:providerId/quota-config",
			zValidator("json", updateProviderQuotaConfigSchema),
			async (c) => {
				const providerProfileId = c.req.param("providerId");
				const config: ProviderQuotaConfig = c.req.valid("json");
				const { capability } = await resolveProfileCapability(deps, providerProfileId);

				// The toggles a kind does not have cannot be stored for it — a
				// windowed config on a balance provider would promise notifications
				// that can never fire.
				if (config.kind !== capability.kind) {
					throw validation(
						`Quota config kind '${config.kind}' does not match this provider's capability '${capability.kind}'.`,
						{ providerProfileId, configKind: config.kind, capabilityKind: capability.kind },
					);
				}

				await deps.quota.upsertSettings(providerProfileId, config);
				// Picks up or drops the timer, and rebaselines if the kind moved.
				await deps.quotaService.resyncProfile(providerProfileId);
				return c.json(await readQuota(deps, providerProfileId));
			},
		);
}

async function resolveProfileCapability(deps: QuotaFeatureDeps, providerProfileId: string) {
	const profile = await deps.profiles.getProviderProfile(providerProfileId);
	if (!profile) {
		throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
	}
	return { profile, capability: resolveQuotaAdapter(profile.providerPreset, profile.endpoint) };
}

/**
 * Current state for one profile. A profile with no persisted row reports its
 * capability kind's defaults rather than 404 — "not configured yet" is a normal
 * state, and the client needs the shape to render against.
 */
async function readQuota(deps: QuotaFeatureDeps, providerProfileId: string): Promise<ProviderQuotaRecord> {
	const { capability } = await resolveProfileCapability(deps, providerProfileId);
	const settings = await deps.quota.getSettings(providerProfileId);
	const stored = await deps.quota.getSnapshot(providerProfileId);

	// A stored row from before a preset edit describes the wrong kind; report the
	// new kind's defaults until the resync writes the real row.
	const config = settings && settings.config.kind === capability.kind
		? settings.config
		: defaultQuotaConfigForKind(capability.kind);

	return {
		providerProfileId,
		config,
		snapshot: stored?.snapshot ?? null,
		lastError: stored?.lastError ?? null,
		updatedAt: stored?.updatedAt ?? null,
	};
}
