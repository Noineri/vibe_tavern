import { getMacroCatalog } from "./macro-catalog.js";
import { extractMacroNames } from "./macro-registry.js";

/**
 * Dropped-ST-macro import warning (st-macro-parity step 8).
 *
 * VT deliberately does not support a fixed set of SillyTavern macros because
 * an explicit VT mechanism does the job (report Verdict, 2026-10-04). When a
 * card or preset is imported, its text is scanned for those names and the
 * import flow warns «macro X is not supported in VT — use Y» — the same
 * import-warning pattern the `{{outlet}}` check established (commit c3ca74ec).
 *
 * "Supported" is derived from the ONE macro registry via {@link getMacroCatalog}
 * (every registered name and alias) — never a second hand-written list — so a
 * dropped name that later becomes registered stops warning by itself.
 *
 * Mechanism-level drops from the Verdict carry no macro name and warn nobody:
 * cross-turn variable memory (scripts / scene tracker / character tracker) and
 * weighted random lorebook events (lorebook trigger % / inclusion groups) — the
 * variable macros themselves are supported assembly-scoped.
 *
 * Deferred names (ST filter flags/pipes, image-gen charPrefix /
 * charNegativePrefix, and unregistered-but-not-dropped names like `input`)
 * stay literal and are never warned here.
 */

const USE_PRESET_LAYERS = "preset layers and the generation format";
const USE_SCRIPTS = "scripts";

/** ST macro name, keyed lowercase (the engine normalizes names) → the VT
 *  mechanism that replaces it. */
export const DROPPED_ST_MACROS: Readonly<Record<string, string>> = {
	// Story-string / context-template / instruct* macros → the preset owns
	// layers structurally and the generation format owns the text-completion
	// glue (source: ST instruct-macros.js / context templates; the ST-macro
	// research §1). `instructSystem` / `instructSystemPrompt` are ST aliases of
	// defaultSystemPrompt; VT answers that job with the preset system layer.
	wibefore: USE_PRESET_LAYERS,
	wiafter: USE_PRESET_LAYERS,
	anchorbefore: USE_PRESET_LAYERS,
	anchorafter: USE_PRESET_LAYERS,
	chatstart: USE_PRESET_LAYERS,
	exampleseparator: USE_PRESET_LAYERS,
	chatseparator: USE_PRESET_LAYERS,
	instructstorystringprefix: USE_PRESET_LAYERS,
	instructstorystringsuffix: USE_PRESET_LAYERS,
	instructuserprefix: USE_PRESET_LAYERS,
	instructinput: USE_PRESET_LAYERS,
	instructusersuffix: USE_PRESET_LAYERS,
	instructassistantprefix: USE_PRESET_LAYERS,
	instructoutput: USE_PRESET_LAYERS,
	instructassistantsuffix: USE_PRESET_LAYERS,
	instructseparator: USE_PRESET_LAYERS,
	instructsystemprefix: USE_PRESET_LAYERS,
	instructsystemsuffix: USE_PRESET_LAYERS,
	instructsystem: USE_PRESET_LAYERS,
	instructsystemprompt: USE_PRESET_LAYERS,
	instructfirstassistantprefix: USE_PRESET_LAYERS,
	instructfirstoutputprefix: USE_PRESET_LAYERS,
	instructlastassistantprefix: USE_PRESET_LAYERS,
	instructlastoutputprefix: USE_PRESET_LAYERS,
	instructstop: USE_PRESET_LAYERS,
	instructuserfiller: USE_PRESET_LAYERS,
	instructsysteminstructionprefix: USE_PRESET_LAYERS,
	instructfirstuserprefix: USE_PRESET_LAYERS,
	instructfirstinput: USE_PRESET_LAYERS,
	instructlastuserprefix: USE_PRESET_LAYERS,
	instructlastinput: USE_PRESET_LAYERS,

	// STscript-era chat indices and runtime flags → there is no STscript in VT;
	// scripts get chat context through their own API.
	lastmessageid: USE_SCRIPTS,
	firstincludedmessageid: USE_SCRIPTS,
	firstdisplayedmessageid: USE_SCRIPTS,
	lastswipeid: USE_SCRIPTS,
	currentswipeid: USE_SCRIPTS,
	allchatrange: USE_SCRIPTS,
	lastgenerationtype: USE_SCRIPTS,
	hasextension: USE_SCRIPTS,
	ismobile: USE_SCRIPTS,

	// Expressions-extension macros → VT has no expressions feature; scripts
	// are the per-chat-state mechanism for anything similar.
	defaultexpression: USE_SCRIPTS,
	lastexpression: USE_SCRIPTS,
	availableexpressions: USE_SCRIPTS,
};

let supportedMacroNamesCache: ReadonlySet<string> | null = null;

/** Every registered macro name and alias (lowercase), derived from the one
 *  registry catalog and cached — the registry is static after module load. */
function getSupportedMacroNames(): ReadonlySet<string> {
	if (supportedMacroNamesCache == null) {
		const names = new Set<string>();
		for (const entry of getMacroCatalog()) {
			names.add(entry.name.toLowerCase());
			for (const alias of entry.aliases) names.add(alias.toLowerCase());
		}
		supportedMacroNamesCache = names;
	}
	return supportedMacroNamesCache;
}

/**
 * Scan imported prompt texts and return one warning per distinct dropped ST
 * macro, in first-seen order. Names are extracted with the canonical
 * tokenizer ({@link extractMacroNames}), so extraction always matches what
 * the engine would actually resolve; a dropped name that IS registered is
 * skipped (supported macros are never warned).
 */
export function findDroppedStMacroWarnings(texts: readonly string[]): string[] {
	const supported = getSupportedMacroNames();
	const seen = new Set<string>();
	const warnings: string[] = [];
	for (const text of texts) {
		if (!text) continue;
		for (const name of extractMacroNames(text)) {
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			const replacement = DROPPED_ST_MACROS[key];
			if (replacement === undefined) continue;
			if (supported.has(key)) continue;
			warnings.push(`Macro {{${name}}} is not supported in VT — use ${replacement} instead.`);
		}
	}
	return warnings;
}
