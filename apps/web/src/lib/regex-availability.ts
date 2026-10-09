/**
 * Central availability model for Regex Rules and Profiles (RXU-31).
 *
 * ONE pure derivation replaces the status logic that lived independently in
 * the PromptManagerModal list rows, RegexPresetEditor and RegexProfileEditor.
 * The output is a discriminated union of kind + data; the consumer (RXU-33
 * RegexAvailabilityBadge) maps kinds to text. No React, no i18n here.
 *
 * Link counts distinguish UNKNOWN (`undefined` — the per-id fetch has not
 * resolved) from CONFIRMED ZERO (`0`): unknown never yields `unbound`, it
 * yields the internal `loading` status instead. PromptManagerModal holds the
 * counts as `Record<string, number | undefined>`, so `undefined` is the
 * existing "not loaded yet" signal.
 *
 * A member Rule's own `isGlobal`/link state is inert while it belongs to a
 * Profile (R-13): only the Profile's disabled/global/link gates decide its
 * availability, so `ruleLinkCount` is ignored whenever `rule.profileId` is
 * set (preserved in the DB, reactivated on detach).
 */

import type { RegexPresetRecord, RegexProfileRecord } from "../api/types.js";

/** Minimal Profile identity carried on member-Rule statuses. */
export interface RegexProfileIdentity {
  id: RegexProfileRecord["id"];
  name: string;
}

/**
 * Profile availability, in precedence order:
 * `disabled` → `loading`/`unbound` (enabled, non-global, link count
 * unknown/confirmed zero) → `noEnabledRules` (reachable, zero enabled
 * members) → `active` with the enabled-member count.
 */
export type RegexProfileAvailability =
  | { kind: "disabled" }
  | { kind: "loading" }
  | { kind: "unbound" }
  | { kind: "noEnabledRules" }
  | { kind: "active"; enabledRuleCount: number };

/**
 * Rule availability. Standalone rules use their own gates (`profile` is
 * null); member rules mirror their Profile's gates and carry its identity.
 * A dangling membership (profile record missing) keeps the pre-RXU-31
 * behavior: only the rule's own disabled state applies, identity is null.
 */
export type RegexRuleAvailability =
  | { kind: "disabled"; profile: RegexProfileIdentity | null }
  | { kind: "loading"; profile: RegexProfileIdentity | null }
  | { kind: "unbound"; profile: RegexProfileIdentity | null }
  | { kind: "active"; profile: RegexProfileIdentity | null };

/** Inputs for {@link regexRuleAvailability}. */
export interface RegexRuleAvailabilityInput {
  /** The rule record — membership derives from its `profileId`. */
  rule: RegexPresetRecord;
  /** The rule's OWN link count (standalone only; ignored for members).
   *  `undefined` = not loaded yet. */
  ruleLinkCount: number | undefined;
  /** The member's Profile record, or null for standalone rules / dangling
   *  memberships. */
  profile: RegexProfileRecord | null;
  /** The Profile's link count (members only). `undefined` = not loaded yet. */
  profileLinkCount: number | undefined;
}

/**
 * Derive one Profile status. `rules` is the full rule collection — members
 * are matched by `profileId` inside, so callers pass the single source list
 * they already hold. `profileLinkCount` is `undefined` until its per-id fetch
 * resolves; global profiles never fetch counts and skip the link check.
 */
export function regexProfileAvailability(
  profile: RegexProfileRecord,
  rules: readonly RegexPresetRecord[],
  profileLinkCount: number | undefined,
): RegexProfileAvailability {
  if (profile.disabled) return { kind: "disabled" };
  if (!profile.isGlobal) {
    if (profileLinkCount === 0) return { kind: "unbound" };
    if (profileLinkCount === undefined) return { kind: "loading" };
  }
  const enabledRuleCount = rules.filter((rule) => rule.profileId === profile.id && !rule.disabled).length;
  return enabledRuleCount === 0 ? { kind: "noEnabledRules" } : { kind: "active", enabledRuleCount };
}

/**
 * Derive one Rule status (standalone or member — see
 * {@link RegexRuleAvailabilityInput} for which inputs each case reads).
 */
export function regexRuleAvailability(input: RegexRuleAvailabilityInput): RegexRuleAvailability {
  const { rule, ruleLinkCount, profile, profileLinkCount } = input;
  if (rule.profileId === null) {
    if (rule.disabled) return { kind: "disabled", profile: null };
    if (!rule.isGlobal) {
      if (ruleLinkCount === 0) return { kind: "unbound", profile: null };
      if (ruleLinkCount === undefined) return { kind: "loading", profile: null };
    }
    return { kind: "active", profile: null };
  }
  const identity: RegexProfileIdentity | null = profile ? { id: profile.id, name: profile.name } : null;
  if (rule.disabled || profile?.disabled) return { kind: "disabled", profile: identity };
  if (profile && !profile.isGlobal) {
    if (profileLinkCount === 0) return { kind: "unbound", profile: identity };
    if (profileLinkCount === undefined) return { kind: "loading", profile: identity };
  }
  return { kind: "active", profile: identity };
}
