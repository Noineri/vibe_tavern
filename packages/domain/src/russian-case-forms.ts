/**
 * Compile the opt-in Russian lore-key adaptation into an ST-compatible regex.
 *
 * The optional named lookahead is a format marker. It is always allowed to
 * match zero characters, so it never changes matching; it preserves the plain
 * source key in a machine-recognizable form for ST export/import round trips.
 */
const MARKER_GROUP = "vtRuCaseFormsKey";

const RU = {
  a: "\u0430",
  e: "\u0435",
  g: "\u0433",
  h: "\u0445",
  i: "\u0438",
  k: "\u043a",
  m: "\u043c",
  o: "\u043e",
  softSign: "\u044c",
  ts: "\u0446",
  u: "\u0443",
  v: "\u0432",
  ya: "\u044f",
  yu: "\u044e",
  yo: "\u0451",
  y: "\u044b",
  yShort: "\u0439",
} as const;

const ENDINGS = {
  hardStem: ["", RU.a, RU.u, `${RU.o}${RU.m}`, RU.e, RU.y, `${RU.o}${RU.v}`, `${RU.a}${RU.m}`, `${RU.a}${RU.m}${RU.i}`, `${RU.a}${RU.h}`],
  softStem: [RU.yShort, RU.ya, RU.yu, `${RU.e}${RU.m}`, RU.e, RU.i, `${RU.e}${RU.y}`, `${RU.ya}${RU.m}`, `${RU.ya}${RU.m}${RU.i}`, `${RU.ya}${RU.h}`],
  feminineSoft: [RU.softSign, RU.i, `${RU.softSign}${RU.yu}`, `${RU.e}${RU.y}`, `${RU.ya}${RU.m}`, `${RU.ya}${RU.m}${RU.i}`, `${RU.ya}${RU.h}`],
  feminineA: [RU.a, RU.y, RU.i, RU.e, RU.u, `${RU.o}${RU.yShort}`, `${RU.o}${RU.yu}`, `${RU.a}${RU.m}`, `${RU.a}${RU.m}${RU.i}`, `${RU.a}${RU.h}`],
  feminineYa: [RU.ya, RU.softSign, RU.i, RU.e, RU.yu, `${RU.e}${RU.y}`, `${RU.e}${RU.yu}`, `${RU.ya}${RU.m}`, `${RU.ya}${RU.m}${RU.i}`, `${RU.ya}${RU.h}`],
  adjectiveHard: [`${RU.y}${RU.yShort}`, `${RU.o}${RU.g}${RU.o}`, `${RU.o}${RU.m}${RU.u}`, `${RU.y}${RU.m}`, `${RU.o}${RU.m}`, `${RU.a}${RU.ya}`, `${RU.o}${RU.yShort}`, `${RU.u}${RU.yu}`, `${RU.o}${RU.e}`, `${RU.y}${RU.e}`, `${RU.y}${RU.h}`, `${RU.y}${RU.m}${RU.i}`],
  adjectiveSoft: [`${RU.i}${RU.yShort}`, `${RU.e}${RU.g}${RU.o}`, `${RU.e}${RU.m}${RU.u}`, `${RU.i}${RU.m}`, `${RU.e}${RU.m}`, `${RU.ya}${RU.ya}`, `${RU.e}${RU.y}`, `${RU.yu}${RU.yu}`, `${RU.e}${RU.e}`, `${RU.i}${RU.e}`, `${RU.i}${RU.h}`, `${RU.i}${RU.m}${RU.i}`],
  adjectiveOy: [`${RU.o}${RU.yShort}`, `${RU.o}${RU.g}${RU.o}`, `${RU.o}${RU.m}${RU.u}`, `${RU.y}${RU.m}`, `${RU.o}${RU.m}`, `${RU.a}${RU.ya}`, `${RU.u}${RU.yu}`, `${RU.o}${RU.e}`, `${RU.y}${RU.e}`, `${RU.y}${RU.h}`, `${RU.y}${RU.m}${RU.i}`],
  softStemOy: [`${RU.o}${RU.yShort}`, `${RU.o}${RU.ya}`, `${RU.o}${RU.yu}`, `${RU.o}${RU.e}${RU.m}`, `${RU.o}${RU.e}`, `${RU.o}${RU.i}`, `${RU.o}${RU.e}${RU.v}`, `${RU.o}${RU.ya}${RU.m}`, `${RU.o}${RU.ya}${RU.m}${RU.i}`, `${RU.o}${RU.ya}${RU.h}`],
  fleetingOk: [`${RU.o}${RU.k}`, `${RU.k}${RU.a}`, `${RU.k}${RU.u}`, `${RU.k}${RU.o}${RU.m}`, `${RU.k}${RU.e}`, `${RU.k}${RU.i}`, `${RU.k}${RU.o}${RU.v}`, `${RU.k}${RU.a}${RU.m}`, `${RU.k}${RU.a}${RU.m}${RU.i}`, `${RU.k}${RU.a}${RU.h}`],
  fleetingEk: [`${RU.e}${RU.k}`, `${RU.k}${RU.a}`, `${RU.k}${RU.u}`, `${RU.k}${RU.o}${RU.m}`, `${RU.k}${RU.e}`, `${RU.k}${RU.i}`, `${RU.k}${RU.o}${RU.v}`, `${RU.k}${RU.a}${RU.m}`, `${RU.k}${RU.a}${RU.m}${RU.i}`, `${RU.k}${RU.a}${RU.h}`, `${RU.e}${RU.k}${RU.a}`, `${RU.e}${RU.k}${RU.u}`, `${RU.e}${RU.k}${RU.o}${RU.m}`, `${RU.e}${RU.k}${RU.e}`, `${RU.e}${RU.k}${RU.i}`, `${RU.e}${RU.k}${RU.o}${RU.v}`, `${RU.e}${RU.k}${RU.a}${RU.m}`, `${RU.e}${RU.k}${RU.a}${RU.m}${RU.i}`, `${RU.e}${RU.k}${RU.a}${RU.h}`],
  fleetingEts: [`${RU.e}${RU.ts}`, `${RU.ts}${RU.a}`, `${RU.ts}${RU.u}`, `${RU.ts}${RU.o}${RU.m}`, `${RU.ts}${RU.e}`, `${RU.ts}${RU.y}`, `${RU.ts}${RU.e}${RU.v}`, `${RU.ts}${RU.a}${RU.m}`, `${RU.ts}${RU.a}${RU.m}${RU.i}`, `${RU.ts}${RU.a}${RU.h}`],
  fleetingEv: [`${RU.e}${RU.v}`, `${RU.softSign}${RU.v}${RU.a}`, `${RU.softSign}${RU.v}${RU.u}`, `${RU.softSign}${RU.v}${RU.o}${RU.m}`, `${RU.softSign}${RU.v}${RU.e}`, `${RU.softSign}${RU.v}${RU.y}`, `${RU.softSign}${RU.v}${RU.o}${RU.v}`, `${RU.softSign}${RU.v}${RU.a}${RU.m}`, `${RU.softSign}${RU.v}${RU.a}${RU.m}${RU.i}`, `${RU.softSign}${RU.v}${RU.a}${RU.h}`, `${RU.e}${RU.v}${RU.a}`, `${RU.e}${RU.v}${RU.u}`, `${RU.e}${RU.v}${RU.o}${RU.m}`, `${RU.e}${RU.v}${RU.e}`, `${RU.e}${RU.v}${RU.y}`, `${RU.e}${RU.v}${RU.o}${RU.v}`, `${RU.e}${RU.v}${RU.a}${RU.m}`, `${RU.e}${RU.v}${RU.a}${RU.m}${RU.i}`, `${RU.e}${RU.v}${RU.a}${RU.h}`],
} as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function normalizeYo(value: string): string {
  return value.replaceAll(RU.yo, RU.e).replaceAll("\u0401", "\u0415");
}

function escapedRussianText(value: string): string {
  return escapeRegex(normalizeYo(value).toLowerCase()).replaceAll(RU.e, `[${RU.e}${RU.yo}]`);
}

function alternatives(endings: readonly string[]): string {
  return endings.map(escapedRussianText).join("|");
}

function inflectedWord(word: string): string {
  const normalized = normalizeYo(word).toLowerCase();
  const render = (stem: string, endings: readonly string[]) => `${escapedRussianText(stem)}(?:${alternatives(endings)})`;

  if (normalized.endsWith(`${RU.y}${RU.yShort}`)) {
    return render(normalized.slice(0, -2), ENDINGS.adjectiveHard);
  }
  if (normalized.endsWith(`${RU.o}${RU.yShort}`)) {
    return render(normalized.slice(0, -2), [...ENDINGS.adjectiveOy, ...ENDINGS.softStemOy]);
  }
  if (normalized.endsWith(`${RU.i}${RU.yShort}`)) {
    return render(normalized.slice(0, -2), ENDINGS.adjectiveSoft);
  }
  if (normalized.endsWith(`${RU.o}${RU.k}`)) {
    return render(normalized.slice(0, -2), ENDINGS.fleetingOk);
  }
  if (normalized.endsWith(`${RU.e}${RU.k}`)) {
    return render(normalized.slice(0, -2), ENDINGS.fleetingEk);
  }
  if (normalized.endsWith(`${RU.e}${RU.ts}`)) {
    return render(normalized.slice(0, -2), ENDINGS.fleetingEts);
  }
  if (normalized.endsWith(`${RU.e}${RU.v}`)) {
    return render(normalized.slice(0, -2), ENDINGS.fleetingEv);
  }
  if (normalized.endsWith(RU.softSign)) {
    return render(normalized.slice(0, -1), ENDINGS.feminineSoft);
  }
  if (normalized.endsWith(RU.a)) {
    return render(normalized.slice(0, -1), ENDINGS.feminineA);
  }
  if (normalized.endsWith(RU.ya)) {
    return render(normalized.slice(0, -1), ENDINGS.feminineYa);
  }
  if (normalized.endsWith(RU.yShort)) {
    return render(normalized.slice(0, -1), ENDINGS.softStem);
  }
  return render(normalized, ENDINGS.hardStem);
}

function encodeMarkerKey(key: string): string {
  return [...key].map((character) => `\\u{${character.codePointAt(0)!.toString(16)}}`).join("");
}

function decodeMarkerKey(encoded: string): string | null {
  const chunks = [...encoded.matchAll(/\\u\{([0-9a-f]+)\}/gi)];
  if (chunks.length === 0 || chunks.map((chunk) => chunk[0]).join("") !== encoded) return null;
  try {
    return chunks.map((chunk) => String.fromCodePoint(Number.parseInt(chunk[1], 16))).join("");
  } catch {
    return null;
  }
}

/**
 * Produces an ST regex key with Unicode letter boundaries and `iu` flags.
 * Latin-only keys retain the same boundary/case-insensitive behavior, while
 * every Cyrillic word receives its applicable declension-ending alternatives.
 */
export function compileRussianCaseFormsKey(key: string): string {
  const compiledWords = key.split(/(\p{L}+)/u).map((part) =>
    /\p{Script=Cyrillic}/u.test(part) ? inflectedWord(part) : escapeRegex(part),
  ).join("");
  const marker = encodeMarkerKey(key);
  return `/(?<!\\p{L})(?=(?<${MARKER_GROUP}>${marker})?)(?:${compiledWords})(?!\\p{L})/iu`;
}

/**
 * Returns the original plain key only for the exact regex shape emitted by
 * {@link compileRussianCaseFormsKey}; arbitrary ST regex keys remain raw.
 */
export function unwrapRussianCaseFormsKey(key: string): string | null {
  const parts = key.match(/^\/(.+)\/([a-z]*)$/s);
  if (!parts || parts[2] !== "iu") return null;
  const prefix = `(?<!\\p{L})(?=(?<${MARKER_GROUP}>`;
  const markerEnd = `)?)(?:`;
  const suffix = `)(?!\\p{L})`;
  if (!parts[1].startsWith(prefix) || !parts[1].endsWith(suffix)) return null;
  const markerEndIndex = parts[1].indexOf(markerEnd, prefix.length);
  if (markerEndIndex === -1) return null;
  const original = decodeMarkerKey(parts[1].slice(prefix.length, markerEndIndex));
  return original !== null && compileRussianCaseFormsKey(original) === key ? original : null;
}
