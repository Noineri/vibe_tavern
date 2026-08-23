// ────────────────────────────────────────────────────────────────────────────
// Provider quota — normalized model for per-profile quota / balance tracking
// ────────────────────────────────────────────────────────────────────────────
// Vendors expose wildly different shapes (token windows with reset boundaries,
// plain money balances, or nothing at all for a regular API key). Everything the
// rest of the app touches is normalized into the three-kind discriminated union
// below, so no consumer ever branches on a vendor name.
//
//   windowed — one or more usage windows with a percentage and (usually) a reset
//              boundary. May additionally carry balances (NanoGPT, OpenRouter).
//   balance  — money/credits only. Display-only: percentage thresholds are
//              mathematically meaningless without a denominator, so the config
//              variant for this kind has no notification toggles at all.
//   none     — synthesized capability metadata. No timestamps are invented, no
//              network call is ever made, no timer is ever scheduled.
//
// Lives in `packages/domain` (not services/api) so the EventMap augmentation at
// the bottom is visible to EVERY workspace's typecheck — a `declare module` in a
// consuming package only augments that package's compilation unit.
// ────────────────────────────────────────────────────────────────────────────

import type { ProviderPresetId } from "./coauthor-transport-capabilities.js";

// ─── Kinds ──────────────────────────────────────────────────────────────────

export const PROVIDER_QUOTA_KIND = {
  windowed: "windowed",
  balance: "balance",
  none: "none",
} as const;

export type ProviderQuotaKind = typeof PROVIDER_QUOTA_KIND[keyof typeof PROVIDER_QUOTA_KIND];

/** Why a profile has no quota capability. */
export const PROVIDER_QUOTA_NONE_REASON = {
  /** The vendor exists but exposes no quota/balance endpoint to a plain API key. */
  notExposed: "not_exposed",
  /** Local or custom endpoint — the concept does not apply. */
  notApplicable: "not_applicable",
} as const;

export type ProviderQuotaNoneReason = typeof PROVIDER_QUOTA_NONE_REASON[keyof typeof PROVIDER_QUOTA_NONE_REASON];

// ─── Windows ────────────────────────────────────────────────────────────────

/**
 * Window identity. Vendors name their windows differently; adapters map onto
 * this closed set so the state machine, the event ids and any later UI can key
 * off a stable discriminator. At most ONE window per kind may appear in a
 * snapshot (adapters pick the most meaningful when a vendor reports several).
 */
export const PROVIDER_QUOTA_WINDOW_KIND = {
  /** Short rolling window (Z.AI's 5-hour session, Kimi's sub-day window). */
  session: "session",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
  /** Spend cap without a reset boundary (OpenRouter key limit) — `resetsAt` is null. */
  spendLimit: "spend_limit",
  /** Vendor-specific extra window that maps onto none of the above. */
  extra: "extra",
} as const;

export type ProviderQuotaWindowKind = typeof PROVIDER_QUOTA_WINDOW_KIND[keyof typeof PROVIDER_QUOTA_WINDOW_KIND];

export interface ProviderQuotaWindow {
  readonly kind: ProviderQuotaWindowKind;
  /** Vendor-supplied human label (plan name, window description). Never localized here. */
  readonly label: string;
  /** 0..100. Remaining is `100 - usedPercent` — never stored separately. */
  readonly usedPercent: number;
  /** Canonical UTC ISO-8601 with ms precision, or null for windows that never reset. */
  readonly resetsAt: string | null;
}

// ─── Balances ───────────────────────────────────────────────────────────────

export const PROVIDER_BALANCE_UNIT = {
  usd: "usd",
  cny: "cny",
  /** Vendor-internal credits with no currency semantics (OpenRouter). */
  credits: "credits",
} as const;

export type ProviderBalanceUnit = typeof PROVIDER_BALANCE_UNIT[keyof typeof PROVIDER_BALANCE_UNIT];

/**
 * Balance row identity. Exactly one row per snapshot is `primary` (the number a
 * user thinks of as "my balance"); the rest are breakdown detail.
 */
export const PROVIDER_BALANCE_KIND = {
  /** Spendable right now (Moonshot `available_balance`, NanoGPT usd balance). */
  available: "available",
  /** Vendor credits remaining (OpenRouter total_credits - total_usage). */
  credits: "credits",
  /** Sum of granted + topped-up (DeepSeek `total_balance`). */
  total: "total",
  /** Promotional / granted portion. */
  granted: "granted",
  /** User-purchased portion. */
  toppedUp: "topped_up",
  /** Moonshot voucher portion. */
  voucher: "voucher",
  /** Moonshot cash portion. */
  cash: "cash",
} as const;

export type ProviderBalanceKind = typeof PROVIDER_BALANCE_KIND[keyof typeof PROVIDER_BALANCE_KIND];

export interface ProviderBalanceAmount {
  readonly kind: ProviderBalanceKind;
  readonly unit: ProviderBalanceUnit;
  /**
   * Canonical decimal STRING — money never round-trips through a float.
   * Shape: optional `-`, digits, optional `.` + digits; no exponent, no leading
   * zeros beyond a single `0`, no `-0`.
   */
  readonly amount: string;
  /** Exactly one row per snapshot carries `true`. */
  readonly primary: boolean;
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

export interface WindowedProviderQuotaSnapshot {
  readonly kind: typeof PROVIDER_QUOTA_KIND.windowed;
  readonly providerProfileId: string;
  /** Adapter id that produced this snapshot (see the quota capability registry). */
  readonly capabilityId: string;
  /** Bumped by an adapter when its normalization changes — forces a re-baseline. */
  readonly capabilityVersion: number;
  /** Canonical UTC instant the vendor response was observed. Stale polls are dropped. */
  readonly observedAt: string;
  readonly windows: readonly ProviderQuotaWindow[];
  /** Present when the vendor reports money alongside windows (NanoGPT, OpenRouter). */
  readonly balances?: readonly ProviderBalanceAmount[];
}

export interface BalanceProviderQuotaSnapshot {
  readonly kind: typeof PROVIDER_QUOTA_KIND.balance;
  readonly providerProfileId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly observedAt: string;
  readonly balances: readonly ProviderBalanceAmount[];
}

/** Synthesized — never the result of a request, so it carries no timestamp. */
export interface NoProviderQuotaSnapshot {
  readonly kind: typeof PROVIDER_QUOTA_KIND.none;
  readonly providerProfileId: string;
  readonly reason: ProviderQuotaNoneReason;
}

export type ProviderQuotaSnapshot =
  | WindowedProviderQuotaSnapshot
  | BalanceProviderQuotaSnapshot
  | NoProviderQuotaSnapshot;

// ─── Config (exactly the user's three toggles) ──────────────────────────────

export const DEFAULT_LOW_QUOTA_REMAINING_PERCENT = 10;

/**
 * Bounds on the user-chosen poll period. The lower bound is the same one-minute
 * floor the poller enforces (nobody gets to hammer a vendor); the upper bound
 * keeps the displayed numbers recognizably "now" rather than "some time today".
 */
export const QUOTA_POLL_INTERVAL_MINUTES_MIN = 1;
export const QUOTA_POLL_INTERVAL_MINUTES_MAX = 5;
export const DEFAULT_QUOTA_POLL_INTERVAL_MINUTES = 5;

export interface WindowedProviderQuotaConfig {
  readonly kind: typeof PROVIDER_QUOTA_KIND.windowed;
  readonly displayEnabled: boolean;
  readonly lowQuotaEnabled: boolean;
  /** Integer 1..100. Fires when remaining drops to or below this. */
  readonly lowQuotaRemainingPercent: number;
  readonly resetNotifyEnabled: boolean;
  /** Integer 1..5. How often this profile is polled while any toggle is on. */
  readonly pollIntervalMinutes: number;
}

/** Display only — money has no denominator, so thresholds do not exist here. */
export interface BalanceProviderQuotaConfig {
  readonly kind: typeof PROVIDER_QUOTA_KIND.balance;
  readonly displayEnabled: boolean;
  /** Integer 1..5 — polling is polling, whatever the numbers being polled mean. */
  readonly pollIntervalMinutes: number;
}

export interface NoProviderQuotaConfig {
  readonly kind: typeof PROVIDER_QUOTA_KIND.none;
}

export type ProviderQuotaConfig =
  | WindowedProviderQuotaConfig
  | BalanceProviderQuotaConfig
  | NoProviderQuotaConfig;

export const DEFAULT_WINDOWED_PROVIDER_QUOTA_CONFIG: WindowedProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  displayEnabled: false,
  lowQuotaEnabled: false,
  lowQuotaRemainingPercent: DEFAULT_LOW_QUOTA_REMAINING_PERCENT,
  resetNotifyEnabled: false,
  pollIntervalMinutes: DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
};

export const DEFAULT_BALANCE_PROVIDER_QUOTA_CONFIG: BalanceProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.balance,
  displayEnabled: false,
  pollIntervalMinutes: DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
};

export const DEFAULT_NONE_PROVIDER_QUOTA_CONFIG: NoProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.none,
};

/** Polling runs while ANY toggle is on — notifications need fresh data with display off. */
export function isQuotaPollingEnabled(config: ProviderQuotaConfig): boolean {
  if (config.kind === PROVIDER_QUOTA_KIND.none) return false;
  if (config.kind === PROVIDER_QUOTA_KIND.balance) return config.displayEnabled;
  return config.displayEnabled || config.lowQuotaEnabled || config.resetNotifyEnabled;
}

/**
 * The user's chosen poll period as milliseconds, clamped to the supported range.
 * A `none` config never polls, so it reports the maximum rather than throwing —
 * callers gate on {@link isQuotaPollingEnabled} first.
 */
export function quotaPollIntervalMs(config: ProviderQuotaConfig): number {
  const minutes = config.kind === PROVIDER_QUOTA_KIND.none
    ? QUOTA_POLL_INTERVAL_MINUTES_MAX
    : config.pollIntervalMinutes;
  const clamped = Math.min(
    QUOTA_POLL_INTERVAL_MINUTES_MAX,
    Math.max(QUOTA_POLL_INTERVAL_MINUTES_MIN, Math.round(minutes)),
  );
  return clamped * 60_000;
}

// ─── Poll failure ───────────────────────────────────────────────────────────

/**
 * Why the last poll failed. Persisted alongside the snapshot and surfaced by the
 * quota route so a later UI can distinguish "your key is wrong" from "the vendor
 * is flaky". Never carries a vendor message — that could contain key material.
 */
export const PROVIDER_QUOTA_ERROR_KIND = {
  /** 401/403 — the key is rejected. Backs off to the cap; only a config change retries sooner. */
  auth: "auth",
  /** Any other non-2xx response. */
  http: "http",
  /** Transport failure, timeout, or abort. */
  network: "network",
  /** 2xx body that did not match the adapter's schema. */
  schema: "schema",
} as const;

export type ProviderQuotaErrorKind = typeof PROVIDER_QUOTA_ERROR_KIND[keyof typeof PROVIDER_QUOTA_ERROR_KIND];

// ─── Transition tuning constants ────────────────────────────────────────────

/**
 * A drop of this many usage points, observed at or after the previous reset
 * boundary, counts as a reset even when the vendor did not advance `resetsAt`.
 */
export const QUOTA_RESET_DROP_POINTS = 20;

/**
 * A latched low-remaining warning on a window that never resets re-arms only
 * once remaining climbs back to `threshold + this` — plain equality would
 * re-fire on every jitter around the threshold.
 */
export const QUOTA_REARM_HYSTERESIS_POINTS = 5;

// ─── Transition memory ──────────────────────────────────────────────────────

/** Per-window memory the transition state machine carries between polls. */
export interface QuotaWindowTransitionState {
  readonly lastUsedPercent: number;
  readonly lastResetsAt: string | null;
  /** True once a low-remaining warning fired; suppresses re-fire until the window re-arms. */
  readonly lowQuotaLatched: boolean;
  /**
   * How many times a never-resetting window has re-armed via hysteresis. Windows
   * with a reset boundary get a fresh event id from the advanced `resetsAt`;
   * a spend cap has no such boundary, so this counter is what makes the next
   * warning's id distinct instead of colliding with the already-notified one.
   */
  readonly rearmCount: number;
}

/**
 * Persisted alongside the snapshot (`provider_quota_snapshots.transition_state_json`).
 * Null for balance/none profiles — they have no windows and emit no events.
 */
export interface QuotaTransitionState {
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  /** The threshold these latches were computed against; changing it re-baselines them. */
  readonly thresholdPercent: number;
  /**
   * Whether low-remaining notifications were on when these latches were set.
   * Part of the rebaseline fingerprint: turning the toggle ON while a window is
   * already below the threshold must warn once, not wait for the next reset.
   */
  readonly lowQuotaEnabled: boolean;
  /** `observedAt` of the snapshot this state was derived from — stale polls are dropped. */
  readonly observedAt: string;
  readonly windows: Readonly<Partial<Record<ProviderQuotaWindowKind, QuotaWindowTransitionState>>>;
}

// ─── Event taxonomy ─────────────────────────────────────────────────────────

export const QUOTA_LOW_REMAINING_CROSSING = {
  /** Two consecutive polls straddled the threshold. */
  observed: "observed",
  /** First poll of a fresh window was already past the threshold. */
  inferredAfterReset: "inferred_after_reset",
} as const;

export type QuotaLowRemainingCrossing =
  typeof QUOTA_LOW_REMAINING_CROSSING[keyof typeof QUOTA_LOW_REMAINING_CROSSING];

export const QUOTA_RESET_DETECTION = {
  /** The vendor moved `resetsAt` forward. */
  boundaryAdvanced: "boundary_advanced",
  /** The vendor moved `resetsAt` forward AND usage fell. */
  boundaryAdvancedWithUsageDrop: "boundary_advanced_with_usage_drop",
  /** `resetsAt` was stale but usage fell sharply after the boundary passed. */
  usageDropAfterBoundary: "usage_drop_after_boundary",
} as const;

export type QuotaResetDetection = typeof QUOTA_RESET_DETECTION[keyof typeof QUOTA_RESET_DETECTION];

export const PROVIDER_QUOTA_EVENT_KIND = {
  lowRemaining: "low_remaining",
  windowReset: "window_reset",
} as const;

export type ProviderQuotaEventKind =
  typeof PROVIDER_QUOTA_EVENT_KIND[keyof typeof PROVIDER_QUOTA_EVENT_KIND];

/**
 * Fired once when a window's remaining percentage crosses the configured
 * threshold downwards. Latched until that window resets — never per-poll.
 */
export interface ProviderQuotaLowRemainingEvent {
  readonly kind: typeof PROVIDER_QUOTA_EVENT_KIND.lowRemaining;
  /** Deterministic — the same situation replayed after a restart yields the same id. */
  readonly eventId: string;
  readonly providerProfileId: string;
  readonly capabilityId: string;
  readonly windowKind: ProviderQuotaWindowKind;
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly thresholdPercent: number;
  readonly resetsAt: string | null;
  readonly crossing: QuotaLowRemainingCrossing;
  readonly observedAt: string;
}

/** Fired once when a window's quota rolls over into a fresh period. */
export interface ProviderQuotaWindowResetEvent {
  readonly kind: typeof PROVIDER_QUOTA_EVENT_KIND.windowReset;
  readonly eventId: string;
  readonly providerProfileId: string;
  readonly capabilityId: string;
  readonly windowKind: ProviderQuotaWindowKind;
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt: string | null;
  readonly detection: QuotaResetDetection;
  readonly observedAt: string;
}

export type ProviderQuotaEvent = ProviderQuotaLowRemainingEvent | ProviderQuotaWindowResetEvent;

/**
 * Bus event names. These exact strings double as the SSE `event:` field on
 * `GET /api/quota/events`, so the browser listens on the same identifiers the
 * backend emits on.
 */
export const PROVIDER_QUOTA_EVENT_NAME = {
  lowRemaining: "provider.quota.low-remaining",
  windowReset: "provider.quota.window-reset",
} as const;

export type ProviderQuotaEventName =
  typeof PROVIDER_QUOTA_EVENT_NAME[keyof typeof PROVIDER_QUOTA_EVENT_NAME];

declare module "./event-bus.js" {
  interface EventMap {
    "provider.quota.low-remaining": ProviderQuotaLowRemainingEvent;
    "provider.quota.window-reset": ProviderQuotaWindowResetEvent;
  }
}

// ─── Remote preset inventory ────────────────────────────────────────────────

/**
 * Every non-local built-in preset. The quota capability registry is exhaustive
 * over exactly this list — a new cloud preset that nobody classified is a
 * compile/test failure, not a silent `none`.
 *
 * Pinned against `PROVIDER_PRESETS` by
 * `apps/web/src/provider-presets.remote-list.test.ts`.
 */
export const REMOTE_PROVIDER_PRESET_IDS = [
  "openai",
  "openrouter",
  "deepseek",
  "groq",
  "xai",
  "mistral",
  "fireworks",
  "perplexity",
  "moonshot",
  "kimi",
  "ai21",
  "mimo",
  "nanogpt",
  "chutes",
  "electronhub",
  "zai",
  "zai-coding",
  "siliconflow",
  "togetherai",
  "pollinations",
  "anthropic",
  "google",
  "google_interactions",
] as const satisfies readonly ProviderPresetId[];

export type RemoteProviderPresetId = typeof REMOTE_PROVIDER_PRESET_IDS[number];
