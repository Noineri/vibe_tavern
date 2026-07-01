/// <reference types="vite/client" />

// Injected at build time by vite.config.ts (`define` block). Replaced with a
// string literal taken from the root package.json — no runtime file access.
// Used by the update-check feature to compare the running build against the
// latest GitHub release.
declare const __APP_VERSION__: string;
