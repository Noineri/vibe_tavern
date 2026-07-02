// Module augmentation: teach React's type definitions about the non-standard
// directory-upload attributes (`webkitdirectory`, `directory`) used by the
// SillyTavern folder-import inputs in ImportModals + PersonaModal. These are
// Chrome/Edge/Firefox extensions not present in @types/react. Augmenting here
// (in a module file — `export {}` makes it a module so `declare module` MERGES
// rather than replaces) lets us drop the per-usage @ts-expect-error suppressions
// that previously masked the missing types. Mirrors the project convention of
// extending library types via dedicated .d.ts files (debug-globals.d.ts,
// hono-types.d.ts).
export {};

declare module "react" {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}
