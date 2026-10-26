/**
 * Web-side starting values for a brand-new provider profile that are NOT the
 * domain generation defaults.
 *
 * `PROVIDER_PROFILE_GENERATION_DEFAULTS.contextBudget` is `null` (a stored
 * profile with no budget); the web create paths (first-run wizard, settings
 * "new profile", the Provider modal fallbacks) instead start the editor at
 * this value. It is only the starting point: it is replaced by the picked
 * model's context length once that autofills the field (unless the budget is
 * pinned).
 */
export const NEW_PROFILE_CONTEXT_BUDGET = 16000;
