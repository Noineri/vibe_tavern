/**
 * lib/agent-builtin-profiles (DR-7) — the ONE derivation for sidechat
 * built-in presentation: per-profile starters/empty-state keys, the
 * «Вне роли» hand-off config, and localized display names.
 *
 * T0 pure-logic pins (no DOM, no i18n init — the display-name helper's `t`
 * is injected, so these pin WHICH keys are read, never locale files):
 *   - the presentation exists ONLY for the sidechat director built-in;
 *   - every other id — the first built-in, other kinds' built-ins — falls
 *     back to the host's own (undefined), per the owner ruling 2026-10-27;
 *   - DR-7b: the STARTER-key derivation resolves the SOURCE built-in's
 *     starters for a user duplicate (starters-only inheritance), the
 *     built-in's own for a built-in, and the host's (undefined) everywhere
 *     else;
 *   - the hand-off row exists for EVERY sidechat effective profile except
 *     the director itself — user profiles included (owner ruling
 *     2026-11-01: discovery of the director outranks profile-choice
 *     non-nagging; the DR-7 first-built-in-only gate is dropped);
 *   - the display name maps the two sidechat built-ins to their keys and
 *     passes every other id/kind through to the wire name.
 */
import { describe, expect, it } from "bun:test";
import {
	BUILTIN_DIRECTOR_PROFILE_ID,
	BUILTIN_PROFILE_ID,
	builtinProfileDisplayName,
	builtinProfileHandoff,
	builtinProfilePresentation,
	effectiveProfileStarterKeys,
} from "./agent-builtin-profiles.js";

/** The injected t records the key it was called with (the locale files are
 *  pinned by the i18n suites; this pins the KEY contract only). */
function keyEchoT(key: string): string {
	return `<${key}>`;
}

describe("agent-builtin-profiles (DR-7)", () => {
	it("the director presentation carries its four starters and the director title/subtitle keys", () => {
		const presentation = builtinProfilePresentation("sidechat-ooc", BUILTIN_DIRECTOR_PROFILE_ID);
		expect(presentation).toBeDefined();
		expect(presentation?.starterKeys).toEqual([
			"agent_starter_director_plan",
			"agent_starter_director_character_card",
			"agent_starter_director_scene_tracker",
			"agent_starter_director_recap",
		]);
		expect(presentation?.titleKey).toBe("agent_profile_name_builtin_director");
		expect(presentation?.subKey).toBe("agent_director_empty_sub");
	});

	it("no presentation for the first built-in, user profiles, or other kinds — the host's own stays the fallback", () => {
		// The presentation stays BUILT-IN-only (title/subtitle/icon for a
		// user profile remain the host's — owner split ruling 2026-10-27).
		expect(builtinProfilePresentation("sidechat-ooc", BUILTIN_PROFILE_ID)).toBeUndefined();
		expect(builtinProfilePresentation("sidechat-ooc", "cprof_dup_of_director")).toBeUndefined();
		expect(builtinProfilePresentation("sidechat-ooc", BUILTIN_DIRECTOR_PROFILE_ID + "-wrong")).toBeUndefined();
		expect(builtinProfilePresentation("experience", BUILTIN_DIRECTOR_PROFILE_ID)).toBeUndefined();
		expect(builtinProfilePresentation("script", BUILTIN_PROFILE_ID)).toBeUndefined();
	});

	it("DR-7b: a user duplicate resolves the SOURCE built-in's starters — starters only", () => {
		const directorStarters = builtinProfilePresentation("sidechat-ooc", BUILTIN_DIRECTOR_PROFILE_ID)?.starterKeys;
		expect(directorStarters).toBeDefined();
		// A user profile duplicated from the director inherits ITS starters.
		expect(effectiveProfileStarterKeys("sidechat-ooc", "cprof_dup", "builtin-director")).toEqual(directorStarters);
		// A built-in effective profile keeps its OWN starters (same four).
		expect(effectiveProfileStarterKeys("sidechat-ooc", "builtin-director", undefined)).toEqual(directorStarters);
		// Without a source → the host's own (undefined), for null and absent alike.
		expect(effectiveProfileStarterKeys("sidechat-ooc", "cprof_dup", null)).toBeUndefined();
		expect(effectiveProfileStarterKeys("sidechat-ooc", "cprof_dup", undefined)).toBeUndefined();
		// A source with no presentation of its own (the FIRST built-in's empty
		// state IS the host's) inherits nothing.
		expect(effectiveProfileStarterKeys("sidechat-ooc", "cprof_dup", BUILTIN_PROFILE_ID)).toBeUndefined();
		// A foreign kind's built-in id never resolves (presentations are keyed
		// by kind — the server's same-kind create rule, defended client-side).
		expect(effectiveProfileStarterKeys("experience", "cprof_dup", "builtin-director")).toBeUndefined();
		// A built-in WITHOUT a presentation (the first built-in) keeps the
		// host's starters even though it is a built-in.
		expect(effectiveProfileStarterKeys("sidechat-ooc", BUILTIN_PROFILE_ID, undefined)).toBeUndefined();
	});

	it("the hand-off row exists for every sidechat effective profile except the director itself (owner ruling 2026-11-01)", () => {
		const handoff = builtinProfileHandoff("sidechat-ooc", BUILTIN_PROFILE_ID);
		expect(handoff).toEqual({
			rowKey: "sidechat_director_row",
			// The prefill is the director's first starter.
			prefillKey: "agent_starter_director_plan",
		});
		// A USER profile shows the row too — owner ruling 2026-11-01: discovery
		// of the director outranks profile-choice non-nagging (the DR-7
		// first-built-in-only gate is dropped).
		expect(builtinProfileHandoff("sidechat-ooc", "cprof_1")).toEqual({
			rowKey: "sidechat_director_row",
			prefillKey: "agent_starter_director_plan",
		});
		// Not under the director itself (a self-switch is pointless).
		expect(builtinProfileHandoff("sidechat-ooc", BUILTIN_DIRECTOR_PROFILE_ID)).toBeUndefined();
		// And never outside the sidechat kind, whatever the profile id.
		expect(builtinProfileHandoff("experience", BUILTIN_PROFILE_ID)).toBeUndefined();
		expect(builtinProfileHandoff("experience", "cprof_1")).toBeUndefined();
		expect(builtinProfileHandoff("script", BUILTIN_PROFILE_ID)).toBeUndefined();
	});

	it("the display name maps the two sidechat built-ins to their keys and passes everything else through", () => {
		expect(builtinProfileDisplayName(BUILTIN_PROFILE_ID, "sidechat-ooc", "Sidechat OOC", keyEchoT)).toBe(
			"<agent_profile_name_builtin>",
		);
		expect(builtinProfileDisplayName(BUILTIN_DIRECTOR_PROFILE_ID, "sidechat-ooc", "Director", keyEchoT)).toBe(
			"<agent_profile_name_builtin_director>",
		);
		// User profiles keep their own stored name, in every kind.
		expect(builtinProfileDisplayName("cprof_1", "sidechat-ooc", "My grim director", keyEchoT)).toBe("My grim director");
		// Other kinds' built-ins keep their seed names (mockup §2's «принято
		// P4» scope: ONLY the two sidechat built-ins localize).
		expect(builtinProfileDisplayName(BUILTIN_PROFILE_ID, "experience", "Experience Authoring", keyEchoT)).toBe(
			"Experience Authoring",
		);
		expect(builtinProfileDisplayName(BUILTIN_PROFILE_ID, "script", "Script Authoring", keyEchoT)).toBe("Script Authoring");
	});
});
