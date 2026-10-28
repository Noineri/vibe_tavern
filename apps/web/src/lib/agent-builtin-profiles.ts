/**
 * Sidechat built-in profile presentation (DIRECTOR_MODE_PLAN DR-7) — the
 * ONE web-side derivation for everything a sidechat built-in profile adds
 * over the host's own defaults: its localized display name, its empty-state
 * presentation (its own four starters + title/subtitle keys), and the
 * first built-in's hand-off row to the director (mockup §3).
 *
 * Scope is deliberately NARROW: only the TWO sidechat built-ins
 * (`builtin` — the OOC seed, `builtin-director` — the director) get localized
 * names; every other kind's built-ins (e.g. Experience Authoring) keep
 * their seed names verbatim, and user profiles always render their own
 * stored name. Owner ruling 2026-10-27, split by DR-7b: the per-profile
 * PRESENTATION here (title/subtitle/icon) applies to built-in profiles
 * only, while a user profile duplicated from a built-in resolves the
 * SOURCE's STARTERS through `effectiveProfileStarterKeys` — starters are
 * the one thing a duplicate inherits.
 *
 * Consumers render, never re-derive: the empty state resolves its starter
 * chips and title/sub through `builtinProfilePresentation`, every name
 * surface through `builtinProfileDisplayName` — a second hand-written
 * ternary in a consumer is a §3 defect from copy #2.
 */
import { SIDECHAT_AGENT_KIND } from "../api/agent-kind-served-modes.js";
import type { TFunc } from "../i18n/context.js";
import type { AgentI18nKey, AgentKind } from "./agent-host-registry.js";

/**
 * The first built-in profile's id — the sentinel the API uses for "the
 * kind's seed" (a stored `null` assignment resolves to it, and pinning it
 * on a chat row pins the seed itself). Lives HERE so this module and the
 * assignment hook share one spelling; `use-agent-profile-assignment.ts`
 * re-exports it for its existing importers.
 */
export const BUILTIN_PROFILE_ID = "builtin";

/** The sidechat director built-in's profile id (the DR-1 server seed). */
export const BUILTIN_DIRECTOR_PROFILE_ID = "builtin-director";

/** A built-in profile's own empty-state presentation (DR-7, mockup §3). */
export interface AgentBuiltinProfilePresentation {
	/** The profile's four starter chips (the AP-18 tuple shape — exactly
	 *  four, resolved through `t`, click = composer prefill, never sent). */
	starterKeys: readonly [AgentI18nKey, AgentI18nKey, AgentI18nKey, AgentI18nKey];
	/** The empty state's title key — the built-in's localized display name. */
	titleKey: AgentI18nKey;
	/** The empty state's subtitle key (mockup §3, the director's line). */
	subKey: AgentI18nKey;
}

/** The OOC hand-off row under the first built-in's starters (§3). */
export interface AgentBuiltinProfileHandoff {
	/** The accent row's label key (the "plan with the director" line). */
	rowKey: AgentI18nKey;
	/** The text the row puts into the composer — the director's first
	 *  starter (the "plan from scratch" line); not sent. */
	prefillKey: AgentI18nKey;
}

/** The director built-in's own empty state (mockup §3, left column). */
const DIRECTOR_PRESENTATION: AgentBuiltinProfilePresentation = {
	starterKeys: [
		"agent_starter_director_plan",
		"agent_starter_director_character_card",
		"agent_starter_director_scene_tracker",
		"agent_starter_director_recap",
	],
	titleKey: "agent_profile_name_builtin_director",
	subKey: "agent_director_empty_sub",
};

/**
 * Built-in presentations, keyed by kind then profile id. The FIRST built-in
 * (`BUILTIN_PROFILE_ID`) is deliberately absent everywhere: its empty state
 * IS the host's own (`starterPromptKeys` + the host's i18n), which also
 * stays the fallback for every profile without an entry here — user
 * profiles included (owner ruling 2026-10-27).
 */
const PRESENTATIONS_BY_KIND: Readonly<
	Partial<Record<AgentKind, Readonly<Record<string, AgentBuiltinProfilePresentation>>>>
> = {
	[SIDECHAT_AGENT_KIND]: { [BUILTIN_DIRECTOR_PROFILE_ID]: DIRECTOR_PRESENTATION },
};

/**
 * The ACTIVE built-in profile's empty-state presentation, or undefined (the
 * caller renders the host's own starters/title/subtitle then). Unknown kinds
 * and ids never throw — a host without entries renders exactly as before.
 * Built-in profiles ONLY: a user profile never resolves a presentation
 * through here (its title/subtitle/icon stay the host's — owner split
 * ruling 2026-10-27; its inherited starters come from
 * `effectiveProfileStarterKeys` below).
 */
export function builtinProfilePresentation(
	kind: AgentKind,
	profileId: string,
): AgentBuiltinProfilePresentation | undefined {
	return PRESENTATIONS_BY_KIND[kind]?.[profileId];
}

/**
 * DR-7b: the EFFECTIVE profile's STARTER keys — the ONE source-inheritance
 * derivation (a second hand-written source→starters map anywhere is a §3
 * defect). A built-in effective profile keeps its own presentation
 * starters (`builtinProfilePresentation(kind, profileId)?.starterKeys`);
 * a USER profile duplicated from a built-in
 * (`sourceBuiltinId`) resolves THAT built-in's starters instead — STARTERS
 * ONLY: the title/subtitle/icon stay the host's (the presentation stays
 * built-in-only, per the 2026-10-27 split ruling). Every other case — a
 * user profile without a source, a source with no presentation of its own
 * (the FIRST built-in's empty state IS the host's), a foreign kind's id
 * (presentations are keyed by kind) — returns undefined, the host's
 * `starterPromptKeys`.
 */
export function effectiveProfileStarterKeys(
	kind: AgentKind,
	effectiveProfileId: string,
	sourceBuiltinId: string | null | undefined,
): readonly AgentI18nKey[] | undefined {
	const own = builtinProfilePresentation(kind, effectiveProfileId);
	if (own !== undefined) return own.starterKeys;
	if (sourceBuiltinId != null) {
		return builtinProfilePresentation(kind, sourceBuiltinId)?.starterKeys;
	}
	return undefined;
}

/**
 * The hand-off row offered under the FIRST built-in's starters (DR-7, mockup
 * §3 right): the OOC built-in hands the chat over to the director. Offered ONLY
 * while the kind's first built-in is the EFFECTIVE profile — a user profile
 * never shows it (the user already chose their own profile) — and only for
 * the sidechat kind. The plan-hides-it rule (no row once the branch plan has
 * events) is the CALLER's — it owns the plan read.
 */
export function builtinProfileHandoff(
	kind: AgentKind,
	effectiveProfileId: string,
): AgentBuiltinProfileHandoff | undefined {
	if (kind !== SIDECHAT_AGENT_KIND) return undefined;
	if (effectiveProfileId !== BUILTIN_PROFILE_ID) return undefined;
	return { rowKey: "sidechat_director_row", prefillKey: DIRECTOR_PRESENTATION.starterKeys[0] };
}

/**
 * The display name for a built-in profile: the two sidechat built-ins
 * render localized (their i18n name keys); EVERY other profile id — user
 * profiles, other kinds' built-ins — renders `fallbackName` (the wire
 * name) verbatim. ONE spelling: every surface that shows a profile name
 * (profile modal rows + detail, the DR-6 chip, the settings dropdown) goes
 * through here; a second hand-written ternary is a §3 defect.
 */
export function builtinProfileDisplayName(
	profileId: string,
	kind: AgentKind,
	fallbackName: string,
	t: TFunc,
): string {
	if (kind === SIDECHAT_AGENT_KIND) {
		if (profileId === BUILTIN_PROFILE_ID) return t("agent_profile_name_builtin");
		if (profileId === BUILTIN_DIRECTOR_PROFILE_ID) return t("agent_profile_name_builtin_director");
	}
	return fallbackName;
}
