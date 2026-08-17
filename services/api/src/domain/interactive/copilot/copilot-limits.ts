/**
 * Fixed generation limits for the experience copilot (user decision,
 * 2026-08-17: "the copilot inherits CONNECTION only" — endpoint/key/proxy/
 * model/transport come from the provider profile; every numeric knob below is
 * the copilot's own, NOT the RP profile's).
 *
 * Why fixed numbers instead of the RP profile's:
 * the profile's `contextBudget`/`maxTokens`/samplers are tuned for chat RP
 * (a fresh profile defaults to 16k context — the copilot's system message
 * alone is ~20k tokens, which once budget-trimmed a thread down to "kept 2
 * of 13 messages"). Agent harnesses (pi, Cline, Claude Code) similarly send
 * connection details from config but use their own agent-scale generation
 * settings.
 *
 * Window sizing rationale: most frontier models have an effective window of
 * ~272k (GPT caps input+output at 272k despite the 1M API limit; above that
 * is premium-priced), Chinese models advertise up to 1M but degrade — compact
 * early regardless. 300k budget with a 32k response reserve keeps the
 * assembler trimming well before real limits bite.
 *
 * A future refinement may cap the budget per-model using the provider's
 * model catalog (context windows are public for preset providers); the fixed
 * 300k is the deliberately simple first step.
 */

/** Context budget for copilot prompt assembly (history + digest trimming). */
export const COPILOT_CONTEXT_BUDGET_TOKENS = 300_000;

/** Tokens reserved inside the budget for the model's response. */
export const COPILOT_RESPONSE_RESERVE_TOKENS = 32_000;

/**
 * Auto-compaction (digest) call samplers. A digest must be a faithful, cool
 * summary: low temperature, and an output cap sized for a whole authoring
 * session (2k once let a reasoning model burn the entire cap on thinking and
 * return an empty summary — "Provider returned an empty summary").
 */
export const COPILOT_COMPACT_TEMPERATURE = 0.2;
export const COPILOT_COMPACT_MAX_OUTPUT_TOKENS = 16_000;
