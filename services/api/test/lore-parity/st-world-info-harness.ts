/**
 * Differential-parity harness, ST side — LG-1 (LOREBOOK_GROUP_SCORING_PARITY_REPORT).
 *
 * Verbatim-behavior port of the SillyTavern World Info GROUP pipeline, extracted
 * from the owner's local ST checkout at `N:/SillyTavern/public/scripts/world-info.js`
 * (and `utils.js` for escapeRegex). Source anchors are marked `// ST: <file>:<line>`
 * so the port can be re-diffed against the checkout when ST updates.
 *
 * What is ported (group stage only):
 *   - WorldInfoBuffer: initDepthBuffer / transformString / get / matchKeys / getScore
 *   - filterGroupsByTimedEffects / filterGroupsByScoring / filterByInclusionGroups
 *     (timed effects → scoring → already-activated lock → override → weighted random)
 *   - sortFn, DEFAULT_WEIGHT, world_info_logic, scan_state, MAX_SCAN_DEPTH
 *
 * What is deliberately NOT ported: the activation/recursion loop of checkWorldInfo
 * (DOM-bound, hundreds of lines). The harness receives an already-activated set —
 * activation parity is covered by VT characterization tests (LG-5) instead.
 *
 * Divergences from ST source are mechanical only:
 *   - `Math.random` → injected `rng`
 *   - module globals (world_info_*) → injected `globals`
 *   - jQuery/DOM/console.debug dropped
 *   - returns phase diagnostics (scores / per-group resolutions) alongside survivors
 *   - entries are keyed by string `id` instead of `uid` (shared with the VT side)
 */

// ST: world-info.js:33
export const ST_LOGIC = {
	AND_ANY: 0,
	NOT_ALL: 1,
	NOT_ANY: 2,
	AND_ALL: 3,
} as const;

// ST: world-info.js:43 (only the value that matters for get() is used)
const SCAN_STATE_NORMAL = 1; // scan_state.INITIAL — anything except MIN_ACTIVATIONS(3)

// ST: world-info.js:97
export const ST_DEFAULT_WEIGHT = 100;

// ST: world-info.js:98
const MAX_SCAN_DEPTH = 1000;

// ST: utils.js:1378
function escapeRegex(string: string): string {
	return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
}

// ST: world-info.js:2821
function parseRegexFromString(input: string): RegExp | null {
	const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
	if (!match) {
		return null;
	}
	const [, pattern, flags] = match;
	if (pattern.match(/(^|[^\\])\//)) {
		return null;
	}
	const unescaped = pattern.replace("\\/", "/");
	try {
		return new RegExp(unescaped, flags);
	} catch {
		return null;
	}
}

/** ST `world_info_*` module globals, injected per run. */
export interface StHarnessGlobals {
	useGroupScoring: boolean;
	caseSensitive: boolean;
	matchWholeWords: boolean;
	depth: number;
}

/** Timed-effect membership, keyed by entry id (ST checks entry hashes — the
 *  harness cases are per-run so id equality is equivalent). */
export interface StTimedEffects {
	sticky: Set<string>;
	cooldown: Set<string>;
	delay: Set<string>;
}

/** ST WIScanEntry shape — only the fields the group pipeline reads. */
export interface StScanEntry {
	id: string;
	key: string[];
	keysecondary: string[];
	selectiveLogic: number;
	constant: boolean;
	group: string;
	groupOverride: boolean;
	groupWeight: number | null;
	useGroupScoring: boolean | null;
	order: number;
	scanDepth: number | null;
	caseSensitive: boolean | null;
	matchWholeWords: boolean | null;
	/** Extra harness-only flag: replay of a matched macro-free key set is done
	 *  by the buffer itself; no extra fields needed. */
}

export interface StGroupResolution {
	group: string;
	stickyResolved: boolean;
	scores: Record<string, number> | null;
	removedByScoring: string[];
	removedAsNonSticky: string[];
	overrideWinner: string | null;
	rollWinner: string | null;
}

export interface StPipelineResult {
	/** Entry ids surviving the whole group pipeline, in pipeline order. */
	survivors: string[];
	resolutions: StGroupResolution[];
}

// ST: world-info.js:196-… (WorldInfoBuffer, group-scoring relevant parts)
class StBuffer {
	#depthBuffer: string[] = [];

	constructor(messages: string[]) {
		// ST: world-info.js:250-263 #initDepthBuffer
		for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
			if (messages[depth] !== undefined) {
				this.#depthBuffer[depth] = messages[depth].trim();
			}
			if (depth === messages.length - 1) {
				break;
			}
		}
	}

	// ST: world-info.js:268-273 #transformString
	#transformString(str: string, entry: StScanEntry, globals: StHarnessGlobals): string {
		const caseSensitive = entry.caseSensitive ?? globals.caseSensitive;
		return caseSensitive ? str : str.toLowerCase();
	}

	// ST: world-info.js:279-318 get()
	get(entry: StScanEntry, globals: StHarnessGlobals): string {
		let depth = entry.scanDepth ?? globals.depth;
		if (depth <= 0) {
			return "";
		}
		if (depth > MAX_SCAN_DEPTH) {
			depth = MAX_SCAN_DEPTH;
		}
		const MATCHER = "\x01";
		const JOINER = "\n" + MATCHER;
		// The harness cases don't use match-persona/description flags, global
		// scan data, injects, or the recurse buffer — the message slice is the
		// whole scanned text for the case.
		return MATCHER + this.#depthBuffer.slice(0, depth).join(JOINER);
	}

	// ST: world-info.js:330-371 matchKeys()
	matchKeys(haystack: string, needle: string, entry: StScanEntry, globals: StHarnessGlobals): boolean {
		const keyRegex = parseRegexFromString(needle);
		if (keyRegex) {
			return keyRegex.test(haystack);
		}
		const hay = this.#transformString(haystack, entry, globals);
		const str = this.#transformString(needle, entry, globals);
		const matchWholeWords = entry.matchWholeWords ?? globals.matchWholeWords;

		if (matchWholeWords) {
			const keyWords = str.split(/\s+/);
			if (keyWords.length > 1) {
				return hay.includes(str);
			}
			const regex = new RegExp(`(?:^|\\W)(${escapeRegex(str)})(?:$|\\W)`);
			if (regex.test(hay)) {
				return true;
			}
		} else {
			return hay.includes(str);
		}
		return false;
	}

	// ST: world-info.js:428-470 getScore()
	getScore(entry: StScanEntry, globals: StHarnessGlobals): number {
		let numberOfPrimaryKeys = 0;
		let numberOfSecondaryKeys = 0;
		let primaryScore = 0;
		let secondaryScore = 0;

		if (Array.isArray(entry.key)) {
			numberOfPrimaryKeys = entry.key.length;
			for (const key of entry.key) {
				if (this.matchKeys(this.get(entry, globals), key, entry, globals)) {
					primaryScore++;
				}
			}
		}
		if (Array.isArray(entry.keysecondary)) {
			numberOfSecondaryKeys = entry.keysecondary.length;
			for (const key of entry.keysecondary) {
				if (this.matchKeys(this.get(entry, globals), key, entry, globals)) {
					secondaryScore++;
				}
			}
		}

		if (!numberOfPrimaryKeys) {
			return 0;
		}

		if (numberOfSecondaryKeys > 0) {
			switch (entry.selectiveLogic) {
				case ST_LOGIC.AND_ANY:
					return primaryScore + secondaryScore;
				case ST_LOGIC.AND_ALL:
					return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
			}
		}
		return primaryScore;
	}
}

/**
 * ST: world-info.js:5261-5363 filterByInclusionGroups — the full group chain,
 * with an empty `allActivatedEntries` (no recursion replay) and rng injected.
 */
export function runStGroupPipeline(
	entries: StScanEntry[],
	messages: string[],
	globals: StHarnessGlobals,
	timed: StTimedEffects,
	rng: () => number = Math.random,
): StPipelineResult {
	const buffer = new StBuffer(messages);
	// newEntries: the (single-level) activated set the harness feeds in.
	const newEntries = [...entries];
	const resolutions: StGroupResolution[] = [];

	const removeEntry = (entry: StScanEntry) => {
		const idx = newEntries.indexOf(entry);
		if (idx >= 0) {
			newEntries.splice(idx, 1);
		}
	};

	const removeAllBut = (group: StScanEntry[], chosen: StScanEntry | null) => {
		for (const entry of group) {
			if (entry === chosen) {
				continue;
			}
			removeEntry(entry);
		}
	};

	// ST: world-info.js:5277-5282 grouping (comma-split)
	const grouped: Record<string, StScanEntry[]> = {};
	for (const item of newEntries.filter((x) => x.group)) {
		for (const group of item.group.split(/,\s*/).filter(Boolean)) {
			if (!grouped[group]) {
				grouped[group] = [];
			}
			grouped[group].push(item);
		}
	}
	if (Object.keys(grouped).length === 0) {
		return { survivors: newEntries.map((e) => e.id), resolutions };
	}

	const isEffectActive = (type: "sticky" | "cooldown" | "delay", entry: StScanEntry) =>
		timed[type].has(entry.id);

	// ST: world-info.js:5194-5257 filterGroupsByTimedEffects
	const hasStickyMap = new Map<string, boolean>();
	for (const [key, group] of Object.entries(grouped)) {
		hasStickyMap.set(key, false);
		const stickyEntries = group.filter((x) => isEffectActive("sticky", x));
		if (stickyEntries.length) {
			const resolution: StGroupResolution = {
				group: key,
				stickyResolved: true,
				scores: null,
				removedByScoring: [],
				removedAsNonSticky: group.filter((x) => !stickyEntries.includes(x)).map((x) => x.id),
				overrideWinner: null,
				rollWinner: null,
			};
			for (const entry of group) {
				if (stickyEntries.includes(entry)) {
					continue;
				}
				removeEntry(entry);
			}
			hasStickyMap.set(key, true);
			grouped[key] = group.filter((x) => stickyEntries.includes(x));
			resolutions.push(resolution);
		}
		const cooldownEntries = group.filter((x) => isEffectActive("cooldown", x));
		for (const entry of cooldownEntries) {
			removeEntry(entry);
		}
		const delayEntries = group.filter((x) => isEffectActive("delay", x));
		for (const entry of delayEntries) {
			removeEntry(entry);
		}
	}

	// ST: world-info.js:5173-5201 filterGroupsByScoring
	for (const [key, group] of Object.entries(grouped)) {
		if (!globals.useGroupScoring && !group.some((x) => x.useGroupScoring)) {
			continue;
		}
		const hasAnySticky = hasStickyMap.get(key);
		if (hasAnySticky) {
			continue;
		}
		const scores = group.map((entry) => buffer.getScore(entry, globals));
		const maxScore = Math.max(...scores);
		const removedByScoring: string[] = [];
		for (let i = 0; i < group.length; i++) {
			const isScored = group[i].useGroupScoring ?? globals.useGroupScoring;
			if (!isScored) {
				continue;
			}
			if (scores[i] < maxScore) {
				removedByScoring.push(group[i].id);
				removeEntry(group[i]);
				grouped[key].splice(grouped[key].indexOf(group[i]), 1);
			}
		}
		const scoreMap: Record<string, number> = {};
		group.forEach((entry, i) => {
			scoreMap[entry.id] = scores[i];
		});
		resolutions.push({
			group: key,
			stickyResolved: false,
			scores: scoreMap,
			removedByScoring,
			removedAsNonSticky: [],
			overrideWinner: null,
			rollWinner: null,
		});
	}

	// ST: world-info.js:5284-5362 final resolution loop
	// ST: world-info.js:88 sortFn
	const sortFn = (a: StScanEntry, b: StScanEntry) => b.order - a.order;
	for (const [key, group] of Object.entries(grouped)) {
		if (hasStickyMap.get(key)) {
			continue;
		}
		// (The ST "already activated" lock needs recursion replay — out of harness scope.)
		if (!Array.isArray(group) || group.length <= 1) {
			continue;
		}
		const prios = group.filter((x) => x.groupOverride).sort(sortFn);
		if (prios.length) {
			resolutions.push({
				group: key,
				stickyResolved: false,
				scores: null,
				removedByScoring: [],
				removedAsNonSticky: [],
				overrideWinner: prios[0].id,
				rollWinner: null,
			});
			removeAllBut(group, prios[0]);
			continue;
		}
		const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? ST_DEFAULT_WEIGHT), 0);
		const rollValue = rng() * totalWeight;
		let currentWeight = 0;
		let winner: StScanEntry | null = null;
		for (const entry of group) {
			currentWeight += entry.groupWeight ?? ST_DEFAULT_WEIGHT;
			if (rollValue <= currentWeight) {
				winner = entry;
				break;
			}
		}
		if (!winner) {
			continue;
		}
		resolutions.push({
			group: key,
			stickyResolved: false,
			scores: null,
			removedByScoring: [],
			removedAsNonSticky: [],
			overrideWinner: null,
			rollWinner: winner.id,
		});
		removeAllBut(group, winner);
	}

	return { survivors: newEntries.map((e) => e.id), resolutions };
}
