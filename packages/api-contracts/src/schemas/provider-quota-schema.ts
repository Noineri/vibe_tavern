import { z } from "zod";
import {
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_NONE_REASON,
  PROVIDER_QUOTA_WINDOW_KIND,
  QUOTA_POLL_INTERVAL_MINUTES_MAX,
  QUOTA_POLL_INTERVAL_MINUTES_MIN,
} from "@vibe-tavern/domain";

/**
 * Canonical UTC instant: ISO-8601, always `Z`, always millisecond precision.
 * Exactly what `Date.prototype.toISOString()` emits — adapters normalize every
 * vendor timestamp (epoch ms, offset ISO, fractionless ISO) through a Date, so
 * anything that reaches the wire in another shape is a normalization bug.
 */
export const canonicalUtcInstantSchema = z.string().datetime({ offset: false, precision: 3 });

const CANONICAL_DECIMAL = /^-?(0|[1-9]\d*)(\.\d{1,8})?$/;
const NEGATIVE_ZERO = /^-0(\.0+)?$/;

/**
 * Money as a canonical decimal STRING — it never round-trips through a float.
 *
 * Rejects leading-zero padding (`007.5`), `-0` in any spelling, exponent
 * notation, and anything past 8 fractional digits. That last bound is the
 * float-artifact tripwire: a value like `0.30000000000000004` can only come
 * from an adapter doing arithmetic on a parsed number instead of passing the
 * vendor's own string through.
 */
export const canonicalDecimalSchema = z.string().refine(
  (value) => CANONICAL_DECIMAL.test(value) && !NEGATIVE_ZERO.test(value),
  { message: "Expected a canonical decimal string (no exponent, no padding, no -0, ≤8 fractional digits)" },
);

export const providerQuotaWindowKindSchema = z.nativeEnum(PROVIDER_QUOTA_WINDOW_KIND);
export const providerBalanceKindSchema = z.nativeEnum(PROVIDER_BALANCE_KIND);
export const providerBalanceUnitSchema = z.nativeEnum(PROVIDER_BALANCE_UNIT);
export const providerQuotaNoneReasonSchema = z.nativeEnum(PROVIDER_QUOTA_NONE_REASON);

export const providerQuotaWindowSchema = z.object({
  kind: providerQuotaWindowKindSchema,
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  /** Null only for windows that genuinely never reset (a spend cap). */
  resetsAt: canonicalUtcInstantSchema.nullable(),
}).strict();

export const providerBalanceAmountSchema = z.object({
  kind: providerBalanceKindSchema,
  unit: providerBalanceUnitSchema,
  amount: canonicalDecimalSchema,
  primary: z.boolean(),
}).strict();

const windowedSnapshotSchema = z.object({
  kind: z.literal(PROVIDER_QUOTA_KIND.windowed),
  providerProfileId: z.string().min(1),
  capabilityId: z.string().min(1),
  capabilityVersion: z.number().int().min(1),
  observedAt: canonicalUtcInstantSchema,
  /** MAY be empty: an OpenRouter key with no spend cap has nothing to window. */
  windows: z.array(providerQuotaWindowSchema),
  balances: z.array(providerBalanceAmountSchema).min(1).optional(),
}).strict();

const balanceSnapshotSchema = z.object({
  kind: z.literal(PROVIDER_QUOTA_KIND.balance),
  providerProfileId: z.string().min(1),
  capabilityId: z.string().min(1),
  capabilityVersion: z.number().int().min(1),
  observedAt: canonicalUtcInstantSchema,
  balances: z.array(providerBalanceAmountSchema).min(1),
}).strict();

const noneSnapshotSchema = z.object({
  kind: z.literal(PROVIDER_QUOTA_KIND.none),
  providerProfileId: z.string().min(1),
  reason: providerQuotaNoneReasonSchema,
}).strict();

function checkWindows(windows: ReadonlyArray<{ kind: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  windows.forEach((window, index) => {
    if (seen.has(window.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windows", index, "kind"],
        message: `Duplicate window kind "${window.kind}" — a snapshot carries at most one window per kind`,
      });
    }
    seen.add(window.kind);
  });
}

function checkBalances(balances: ReadonlyArray<{ kind: string; primary: boolean }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  balances.forEach((balance, index) => {
    if (seen.has(balance.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["balances", index, "kind"],
        message: `Duplicate balance kind "${balance.kind}" — a snapshot carries at most one row per kind`,
      });
    }
    seen.add(balance.kind);
  });

  const primaries = balances.filter((balance) => balance.primary).length;
  if (primaries !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["balances"],
      message: `Expected exactly one primary balance, found ${primaries}`,
    });
  }
}

/**
 * The full snapshot union. Cross-field rules live on the union rather than the
 * members because `z.discriminatedUnion` only accepts plain objects — a
 * `.superRefine()`ed member is a ZodEffects and cannot be discriminated.
 */
export const providerQuotaSnapshotSchema = z
  .discriminatedUnion("kind", [windowedSnapshotSchema, balanceSnapshotSchema, noneSnapshotSchema])
  .superRefine((snapshot, ctx) => {
    if (snapshot.kind === PROVIDER_QUOTA_KIND.windowed) {
      checkWindows(snapshot.windows, ctx);
      if (snapshot.balances) checkBalances(snapshot.balances, ctx);
      return;
    }
    if (snapshot.kind === PROVIDER_QUOTA_KIND.balance) {
      checkBalances(snapshot.balances, ctx);
    }
  });

// ─── Config (the user's toggles + the poll period — nothing more here) ─────

const pollIntervalMinutesSchema = z
  .number()
  .int()
  .min(QUOTA_POLL_INTERVAL_MINUTES_MIN)
  .max(QUOTA_POLL_INTERVAL_MINUTES_MAX);

export const windowedProviderQuotaConfigSchema = z.object({
  kind: z.literal(PROVIDER_QUOTA_KIND.windowed),
  displayEnabled: z.boolean(),
  lowQuotaEnabled: z.boolean(),
  lowQuotaRemainingPercent: z.number().int().min(1).max(100),
  resetNotifyEnabled: z.boolean(),
  pollIntervalMinutes: pollIntervalMinutesSchema,
}).strict();

export const balanceProviderQuotaConfigSchema = z.object({
  kind: z.literal(PROVIDER_QUOTA_KIND.balance),
  displayEnabled: z.boolean(),
  pollIntervalMinutes: pollIntervalMinutesSchema,
}).strict();

export const noneProviderQuotaConfigSchema = z.object({
  kind: z.literal(PROVIDER_QUOTA_KIND.none),
}).strict();

export const providerQuotaConfigSchema = z.discriminatedUnion("kind", [
  windowedProviderQuotaConfigSchema,
  balanceProviderQuotaConfigSchema,
  noneProviderQuotaConfigSchema,
]);

/** Body of `PUT /api/providers/:providerId/quota-config`. */
export const updateProviderQuotaConfigSchema = providerQuotaConfigSchema;
