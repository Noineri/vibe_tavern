/**
 * The ONE shared `react-markdown` seam for every apps/web test file that
 * renders through `Markdown` (markdown.test.tsx, markdown.memo.test.tsx).
 *
 * CO-LOAD CONTRACT (owner order 2026-10-24, «markdown co-load factory
 * unification»): `mock.module` is process-global and last-write-wins, and a
 * hand-bundled pair run shares the module registry — so when only
 * markdown.memo.test.tsx mocked react-markdown, its seam factory replaced the
 * real renderer for markdown.test.tsx's renders in the same process (the pair
 * failed 34/78 while each file was green alone). The fix applies the
 * GalleryViewer discipline (IG-CF6) to react-markdown: every file in the set
 * registers the SAME factory, so whichever registration is live, the behavior
 * is identical.
 *
 * Why a shared module instead of byte-identical inline copies: the factory has
 * recording state (`seamCalls`). Inline per-file copies would duplicate that
 * state, and under the reverse co-load order the live factory would push into
 * the array its own file no longer reads. A shared module IS the shared state —
 * the module registry guarantees one instance per process, so every
 * registration records into the one array every importer reads.
 *
 * The factory is the superset both suites need, and it follows the mandatory
 * R4 shape (spread the real namespace, override exactly one export): record
 * the options handed to react-markdown's default, then DELEGATE to the real
 * renderer. The memo suite counts seam entries and compares plugin lists; the
 * characterization suite needs the real pipeline's DOM — recording plus
 * delegating satisfies both, so no assertion had to change in either file.
 *
 * DELEGATION CAPTURE RULE (probe-pinned 2026-10-24): bun's `mock.module`
 * replaces the module's `default` slot IN PLACE — the namespace captured
 * before registration is NOT a frozen snapshot of the originals. A
 * delegating factory that reads `realReactMarkdown.default` after
 * registration gets the MOCK'S default — itself — and re-enters the mock
 * registry's serve path forever: a silent wedge with no output and no test
 * timeout (per-test timeouts do not cover it). Capturing the real default as
 * a bare function reference BEFORE registering severs the re-entry (the
 * GalleryViewer factory never hit this because it overrides without calling
 * through the namespace).
 *
 * Call `installReactMarkdownSeam()` in the test-file body BEFORE importing the
 * component under test: `mock.module` only affects modules imported after the
 * registration.
 */
import { mock } from "bun:test";
import type { Options } from "react-markdown";

const realReactMarkdown = await import("react-markdown");
/** The real default, captured as a bare reference BEFORE any registration — see the header. */
const realReactMarkdownDefault = realReactMarkdown.default;

/** Every options object handed to the react-markdown default since the last clear. */
export const seamCalls: Options[] = [];

/** Register the shared react-markdown seam (idempotent: re-registration replaces with the same shape). */
export function installReactMarkdownSeam(): void {
  mock.module("react-markdown", () => ({
    ...realReactMarkdown,
    default: function ReactMarkdownSeam(options: Options) {
      seamCalls.push(options);
      return realReactMarkdownDefault(options);
    },
  }));
}
