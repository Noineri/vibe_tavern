/**
 * Legacy reasoning boundary markers retained for parsers that may encounter
 * marker-wrapped text. AI SDK 6 natively accepts both `reasoning_content` and
 * `reasoning`, so provider responses must no longer be rewritten into markers.
 */
export const REASONING_START_MARKER = "\x02REASONING_START\x03";
export const REASONING_END_MARKER = "\x02REASONING_END\x03";
