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
 * `i18n/locale-helpers.ts`) so call sites can pass an opts object with `n` or
 * `count`. Single-arg calls are unchanged.
 */
export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Dynamic-key sibling of {@link TFn} — accepts a runtime-computed key string
 * (registry selectors like `panel.labelKey`, prefix-concat). Mirrors `TDynamic`
 * in `i18n/locale-helpers.ts`. Stays loose when `TFn` is tightened to
 * `keyof Resources["en"]`, so layout sections with computed keys keep compiling.
 */
export type TFnDynamic = (key: string, opts?: Record<string, unknown>) => string;

/** The import-modal discriminator state held by both sidebars. */
export type ImportModalKind = "character" | "chat" | null;
