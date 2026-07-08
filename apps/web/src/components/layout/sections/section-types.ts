/**
 * Shared type aliases for the sidebar section components.
 *
 * Kept minimal: only the translation-function shape. Controller and dialog
 * types are NOT re-invented here — sections import `CharacterControllerActions`
 * / `ChatControllerActions` from the controller hooks and `ConfirmDestroyDialog`
 * from character-store directly, so they can't drift from the real signatures.
 */

/**
 * The translation function shape returned by `useT().t`. Accepts an optional
 * interpolation/`count` options object (mirrors `TFunc` in
 * `i18n/locale-helpers.ts`) so call sites can pass `t("k", { n: 5 })` or
 * `t("k", { count: 5 })`. Single-arg `t("k")` calls are unchanged.
 */
export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** The import-modal discriminator state held by both sidebars. */
export type ImportModalKind = "character" | "chat" | null;
