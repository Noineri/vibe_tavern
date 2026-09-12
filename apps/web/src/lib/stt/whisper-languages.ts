/**
 * Whisper language catalog (P12).
 *
 * Static copy of WHISPER_LANGUAGES from @huggingface/transformers
 * (models/whisper/common_whisper.js) — [code, English name] pairs.
 * Copied, not imported: the catalog is pure UI data for the language
 * dropdown and this module stays dependency-free. The free-text language
 * field died here because transformers.js accepts ONLY a two-letter code
 * or an English name (anything else throws in whisper_language_to_code),
 * and an empty language does NOT auto-detect — the greedy decode falls
 * back to another language (Russian speech came out English).
 */

export interface WhisperLanguage {
  code: string;
  name: string;
}

const WHISPER_LANGUAGE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["en", "english"],
  ["zh", "chinese"],
  ["de", "german"],
  ["es", "spanish"],
  ["ru", "russian"],
  ["ko", "korean"],
  ["fr", "french"],
  ["ja", "japanese"],
  ["pt", "portuguese"],
  ["tr", "turkish"],
  ["pl", "polish"],
  ["ca", "catalan"],
  ["nl", "dutch"],
  ["ar", "arabic"],
  ["sv", "swedish"],
  ["it", "italian"],
  ["id", "indonesian"],
  ["hi", "hindi"],
  ["fi", "finnish"],
  ["vi", "vietnamese"],
  ["he", "hebrew"],
  ["uk", "ukrainian"],
  ["el", "greek"],
  ["ms", "malay"],
  ["cs", "czech"],
  ["ro", "romanian"],
  ["da", "danish"],
  ["hu", "hungarian"],
  ["ta", "tamil"],
  ["no", "norwegian"],
  ["th", "thai"],
  ["ur", "urdu"],
  ["hr", "croatian"],
  ["bg", "bulgarian"],
  ["lt", "lithuanian"],
  ["la", "latin"],
  ["mi", "maori"],
  ["ml", "malayalam"],
  ["cy", "welsh"],
  ["sk", "slovak"],
  ["te", "telugu"],
  ["fa", "persian"],
  ["lv", "latvian"],
  ["bn", "bengali"],
  ["sr", "serbian"],
  ["az", "azerbaijani"],
  ["sl", "slovenian"],
  ["kn", "kannada"],
  ["et", "estonian"],
  ["mk", "macedonian"],
  ["br", "breton"],
  ["eu", "basque"],
  ["is", "icelandic"],
  ["hy", "armenian"],
  ["ne", "nepali"],
  ["mn", "mongolian"],
  ["bs", "bosnian"],
  ["kk", "kazakh"],
  ["sq", "albanian"],
  ["sw", "swahili"],
  ["gl", "galician"],
  ["mr", "marathi"],
  ["pa", "punjabi"],
  ["si", "sinhala"],
  ["km", "khmer"],
  ["sn", "shona"],
  ["yo", "yoruba"],
  ["so", "somali"],
  ["af", "afrikaans"],
  ["oc", "occitan"],
  ["ka", "georgian"],
  ["be", "belarusian"],
  ["tg", "tajik"],
  ["sd", "sindhi"],
  ["gu", "gujarati"],
  ["am", "amharic"],
  ["yi", "yiddish"],
  ["lo", "lao"],
  ["uz", "uzbek"],
  ["fo", "faroese"],
  ["ht", "haitian creole"],
  ["ps", "pashto"],
  ["tk", "turkmen"],
  ["nn", "nynorsk"],
  ["mt", "maltese"],
  ["sa", "sanskrit"],
  ["lb", "luxembourgish"],
  ["my", "myanmar"],
  ["bo", "tibetan"],
  ["tl", "tagalog"],
  ["mg", "malagasy"],
  ["as", "assamese"],
  ["tt", "tatar"],
  ["haw", "hawaiian"],
  ["ln", "lingala"],
  ["ha", "hausa"],
  ["ba", "bashkir"],
  ["jw", "javanese"],
  ["su", "sundanese"],
];

/** All languages, alphabetically by English name — the dropdown source. */
export const WHISPER_LANGUAGES: ReadonlyArray<WhisperLanguage> = WHISPER_LANGUAGE_PAIRS.map(([code, name]) => ({
  code,
  name,
})).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const WHISPER_LANGUAGE_CODES = new Set(WHISPER_LANGUAGE_PAIRS.map(([code]) => code));

/** Map an interface locale (e.g. "ru", "ru-RU") to a whisper language code.
 *  Locales whose language has no whisper entry resolve to undefined (no
 *  hint), never to a guess — an invalid hint throws in the worker. */
export function whisperLanguageForLocale(locale: string): string | undefined {
  const base = locale.split("-")[0]?.toLowerCase() ?? "";
  return WHISPER_LANGUAGE_CODES.has(base) ? base : undefined;
}

/** Dropdown label: capitalized English name with the code — "Russian (ru)". */
export function whisperLanguageLabel(language: WhisperLanguage): string {
  const name = language.name.length === 0 ? language.name : language.name[0]?.toUpperCase() + language.name.slice(1);
  return `${name} (${language.code})`;
}
