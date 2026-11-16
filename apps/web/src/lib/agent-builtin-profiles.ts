/**
 * Sidechat built-in profile presentation (DIRECTOR_MODE_PLAN DR-7) — the
 * ONE web-side derivation for everything a sidechat built-in profile adds
 * over the host's own defaults: its localized display name, its empty-state
 * presentation (its own starter list + title/subtitle keys), and the
 * hand-off row to the director (mockup §3).
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
 * The effective profile id for a chat-target assignment (SC-0k) — the
 * web-side mirror of `CopilotProfileResolver.resolveForChat` (same hop
 * order): the chat's own choice when it resolves (the built-in sentinel
 * always resolves; a stored custom id resolves when its row is in the
 * loaded list) → the kind default when it resolves (a built-in default
 * reads as null) → the built-in seed. Dangling ids fall through, never
 * mark a missing row.
 *
 * Lives HERE (DR-12) so components (the assignment hook — which re-exports
 * it for its existing importers) AND stores (the call-director action)
 * share the one derivation; the store layering forbids a store importing
 * from components.
 */
export function resolveChatEffectiveProfileId(
	chatProfileId: string | null,
	kindDefaultProfileId: string | null,
	loadedProfileIds: ReadonlySet<string>,
): string {
	if (chatProfileId !== null && (chatProfileId === BUILTIN_PROFILE_ID || loadedProfileIds.has(chatProfileId))) {
		return chatProfileId;
	}
	if (
		kindDefaultProfileId !== null &&
		kindDefaultProfileId !== BUILTIN_PROFILE_ID &&
		loadedProfileIds.has(kindDefaultProfileId)
	) {
		return kindDefaultProfileId;
	}
	return BUILTIN_PROFILE_ID;
}

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
	/** The profile's starter chips (resolved through `t`, click = composer
	 *  prefill, never sent). DK-5b widened the AP-18 fixed four-tuple to a
	 *  LIST generically — a profile may carry any number of starters; every
	 *  consumer here and in the shell already reads a list, and the hand-off
	 *  row keeps pinning the FIRST key as its prefill. */
	starterKeys: readonly AgentI18nKey[];
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

/** The director built-in's own empty state (mockup §3, left column; DK-5b
 *  appended the twist-deck starter after the original four). */
const DIRECTOR_PRESENTATION: AgentBuiltinProfilePresentation = {
	starterKeys: [
		"agent_starter_director_plan",
		"agent_starter_director_character_card",
		"agent_starter_director_scene_tracker",
		"agent_starter_director_recap",
		"agent_starter_director_deck",
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
 * The hand-off row offered under the sidechat empty state's starters (DR-7,
 * mockup §3 right): the chat hands over to the director. Offered for EVERY
 * effective profile of the sidechat kind EXCEPT the director itself (a
 * self-switch is pointless) — user profiles included (owner ruling
 * 2026-11-01: user profiles show the row; discovery of the director
 * outranks profile-choice non-nagging — the DR-7 first-built-in-only gate
 * is dropped). Non-sidechat kinds never see it. The plan-hides-it rule (no
 * row once the branch plan has events) is the CALLER's — it owns the plan
 * read.
 */
export function builtinProfileHandoff(
	kind: AgentKind,
	effectiveProfileId: string,
): AgentBuiltinProfileHandoff | undefined {
	if (kind !== SIDECHAT_AGENT_KIND) return undefined;
	if (effectiveProfileId === BUILTIN_DIRECTOR_PROFILE_ID) return undefined;
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
