/**
 * Playground config persistence (fix item 9a).
 *
 * The sandbox's test config (roster with pinned provider/model per model seat,
 * grants, seed, settings JSON, human seat) used to live ONLY in local
 * component state — and the panel is conditionally mounted, so toggling
 * Rules/Visual/Sandbox unmounted it and killed the config; an app restart did
 * the same. The IR-84B read-only invariant ("no store/draft writes") did not
 * anticipate iterative testing.
 *
 * This module persists ONLY the test config to localStorage, keyed by the
 * owning script's id. Rules/visual drafts and every persistent store stay
 * untouched — the invariant change is deliberate and narrow: localStorage is
 * not a store, and nothing persisted here ever reaches the server.
 *
 * Versioned envelope: a version mismatch (or malformed JSON) discards the
 * saved config silently — a stale shape must never half-restore.
 */
import type { ExperienceCapability, ExperienceController } from "@vibe-tavern/domain";

/** One persisted roster seat (a structural subset of the panel's PlaygroundSeat). */
export interface PersistedPlaygroundSeat {
	id: string;
	label: string;
	controller: ExperienceController;
	providerProfileId?: string;
	modelId?: string;
}

/** The persisted config envelope. */
export interface PersistedPlaygroundConfig {
	readonly version: 1;
	readonly seats: readonly PersistedPlaygroundSeat[];
	readonly grants: readonly ExperienceCapability[];
	readonly seed: string;
	readonly settingsJson: string;
	readonly humanSeatId: string;
	/** XU-2: "Random start" toggle. Backward compatible on read: a pre-XU-2
	 *  envelope has no flag, so {@link loadPlaygroundConfig} normalizes the
	 *  absence to `false`. */
	readonly randomStart: boolean;
}

const STORAGE_VERSION = 1;
const KEY_PREFIX = "experience.playground.";

function storageKey(scriptId: string): string {
	return `${KEY_PREFIX}${scriptId}`;
}

/** Shape guard: true only when the parsed value structurally matches v1.
 *  Structural (not schema-strict) on purpose — localStorage is trusted-local
 *  scratch data; the worst a malformed row can do is render odd seat labels,
 *  and the Start validation still gates everything before it reaches a server. */
function isPersistedConfig(value: unknown): value is PersistedPlaygroundConfig {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.version !== STORAGE_VERSION) return false;
	if (!Array.isArray(v.seats)) return false;
	for (const seat of v.seats) {
		if (seat === null || typeof seat !== "object") return false;
		const s = seat as Record<string, unknown>;
		if (typeof s.id !== "string" || typeof s.label !== "string" || typeof s.controller !== "string") return false;
		if (s.providerProfileId !== undefined && typeof s.providerProfileId !== "string") return false;
		if (s.modelId !== undefined && typeof s.modelId !== "string") return false;
	}
	if (!Array.isArray(v.grants)) return false;
	for (const grant of v.grants) {
		if (typeof grant !== "string") return false;
	}
	return (
		typeof v.seed === "string" &&
		typeof v.settingsJson === "string" &&
		typeof v.humanSeatId === "string" &&
		// XU-2: randomStart is optional on read for backward compatibility — a
		// pre-XU-2 envelope has no flag; load normalizes the absence to false.
		(v.randomStart === undefined || typeof v.randomStart === "boolean")
	);
}

/** Save the current test config under the script's key. Failures are silent:
 *  localStorage may be unavailable (private mode) — persistence is best-effort
 *  and must never break the play loop. */
export function savePlaygroundConfig(scriptId: string, config: Omit<PersistedPlaygroundConfig, "version">): void {
	if (scriptId.trim() === "") return;
	try {
		const envelope: PersistedPlaygroundConfig = { version: STORAGE_VERSION, ...config };
		window.localStorage.setItem(storageKey(scriptId), JSON.stringify(envelope));
	} catch {
		// Best-effort only (quota / private mode); the panel keeps working unpersisted.
	}
}

/** Load the saved config for the script, or null when absent/unreadable/stale. */
export function loadPlaygroundConfig(scriptId: string): PersistedPlaygroundConfig | null {
	if (scriptId.trim() === "") return null;
	try {
		const raw = window.localStorage.getItem(storageKey(scriptId));
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isPersistedConfig(parsed)) return null;
		// Backward compatible: a pre-XU-2 envelope has no randomStart — normalize
		// to false so a restored config never silently flips to a random start.
		return { ...parsed, randomStart: parsed.randomStart === true };
	} catch {
		return null;
	}
}

/** Drop the saved config for the script (used when the restore proves
 *  unusable, e.g. every persisted model seat references a deleted provider). */
export function clearPlaygroundConfig(scriptId: string): void {
	if (scriptId.trim() === "") return;
	try {
		window.localStorage.removeItem(storageKey(scriptId));
	} catch {
		// Best-effort only.
	}
}
