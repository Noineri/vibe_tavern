/**
 * Shared type aliases for the sidebar section components.
 *
 * Kept minimal: only the translation-function shape, which has no existing
 * exported type (`useT()` returns `LocaleContextValue`; `t` is an inline
 * `(key: string) => string`). Controller and dialog types are NOT re-invented
 * here — sections import `CharacterControllerActions` / `ChatControllerActions`
 * from the controller hooks and `ConfirmDestroyDialog` from character-store
 * directly, so they can't drift from the real signatures.
 */

/** The translation function shape returned by `useT().t`. */
export type TFn = (key: string) => string;

/** The import-modal discriminator state held by both sidebars. */
export type ImportModalKind = "character" | "chat" | null;
