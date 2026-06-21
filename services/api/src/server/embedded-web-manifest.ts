// AUTO-GENERATED stub. Replaced by scripts/generate-embedded-web-manifest.ts
// during `bun run build:standalone`, then restored to this stub afterward.
//
// In dev and `bun run dev`, this empty map means the frontend is served from
// the on-disk web/ directory via hono serveStatic. In the compiled standalone
// executable, the build script regenerates this file with real
// `import ... with { type: "file" }` entries embedding every file under
// out/apps/web/ — so the .exe is fully self-contained and no external web/
// folder is required. This eliminates the "frozen splash" failure mode where
// a user extracts only the .exe (or an antivirus quarantines a single JS
// chunk) and the browser can't load the SPA bundle.
//
// Map shape: URL pathname (e.g. "/assets/index-Abc.js") → embedded file path
// (an opaque "$bunfs/..." or "B:/~BUN/root/..." string returned by the
// `with { type: "file" }` import). Served verbatim in app-factory.ts.

export const embeddedWebFiles: Record<string, string> = {};
