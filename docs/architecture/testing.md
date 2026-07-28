# Testing

> Companion to [CONTRIBUTING.md → Running the gates](../../CONTRIBUTING.md#running-the-gates) and [Backend Architecture](./backend.md).

Vibe Tavern uses **`bun:test`**, Bun's built-in test runner. There is no Jest, Vitest, or separate test config — `bun test` is the whole story. This document covers where tests live, the patterns that recur across the suite, and the three mechanism-level gotchas that have historically shipped silent cross-file failures.

---

## Commands

```bash
bun run test           # all workspaces (scripts + packages + api + web)
bun run test web       # just the web suite
bun test <path>        # one file or directory (packages/services/scripts)
cd apps/web && bun run test apps/web/src/lib/avatar.test.ts   # one web file (path is repo-root-relative), via the web orchestrator
bun test -t "name"     # filter by test name
bun run check          # typecheck + test + i18n:check (the full local gate)
```

The web suite is orchestrated by [`scripts/test-web.ts`](../../scripts/test-web.ts): it discovers `apps/web/src/**/*.test.{ts,tsx}` plus the `apps/web/test/harness.smoke.test.tsx` canary and runs **each file in its own `bun test` subprocess** (per-file isolation, 8 concurrent workers). `--reverse` runs the same files in reverse order — the cheap way to surface hidden file-order dependencies.

CI runs `typecheck` as the sole blocking gate plus an advisory `test` job (`continue-on-error`) — green CI ≠ tested; the local `bun run check` is the gate that matters. See [CONTRIBUTING.md → Running the gates](../../CONTRIBUTING.md#running-the-gates) for the typecheck caveat (always `bun run typecheck` from the repo root; bare `tsc` from `apps/web/` emits ~80 false errors).

---

## Where tests live

| Location | Convention | Typechecked? |
|----------|-----------|--------------|
| `<package>/test/<module>.test.ts` | Backend & package tests (`packages/*/test/`, `services/api/test/`) | ✅ |
| `apps/web/src/**/<module>.test.ts(x)` | **Colocated** next to the source under test | ✅ |
| `apps/web/test/**` | Non-colocated web tests | ❌ not typechecked |

**Rule:** web tests must be colocated under `apps/web/src/` if they need to be part of the typecheck gate. `apps/web/tsconfig.json` has `rootDir:"src"` + `include:["src/**"]`, so anything under `apps/web/test/` is invisible to `tsc`. (The one helper there, [`apps/web/test/dom-env.ts`](../../apps/web/test/dom-env.ts), is fine — it's imported by colocated tests, which pulls it into the type graph.)

The suite spans every workspace; the bulk lives in `services/api/test/`, `packages/db/test/`, and colocated under `apps/web/src/`. File counts drift constantly — count them (`rg --files -g '*.test.ts*' | wc -l`) rather than trusting any number written here.

---

## Mocking

Three primitives from `bun:test`, each with a different blast radius.

### `mock()` — function spies

```ts
import { mock, describe, it, expect } from "bun:test";

const onSave = mock();
// ... exercise code that calls onSave ...
expect(onSave).toHaveBeenCalledTimes(1);
```

File-scoped. Safe to use freely.

### `globalThis.fetch = mock(...)` — network stubs

For tests that exercise code calling `fetch`. Assign in `beforeEach`, restore in `afterEach`. The override is process-global while it's in place, so always restore it — a stale `fetch` mock leaks into later files in the same `bun test` run.

### `mock.module()` — whole-module replacement (⚠️ process-global)

**This is the dangerous one.** A mock registered with `mock.module(specifier, factory)` persists for the **entire process** across every test file that shares it, not just the file that registered it. If the factory returns only a few exports, every *other* export of that module becomes `undefined` for all subsequent files — a silent cross-file leak.

Blast radius differs by suite: the web orchestrator ([`scripts/test-web.ts`](../../scripts/test-web.ts)) gives every file its own subprocess, so a web leak is contained to that one file (and `--reverse` exists precisely to smoke out order dependence). The packages/services/scripts suites share one process per `bun test` invocation, so there the leak crosses files and the safe pattern below is mandatory.

The safe pattern: import the real module **before** registering the mock to capture genuine references, then in the factory spread `...real` first and override only the specific function(s):

```ts
import { mock } from "bun:test";

// Import the real module FIRST — `real` holds the genuine function references.
const real = await import("../src/infrastructure/ai/vision-gate.js");

await mock.module("../src/infrastructure/ai/vision-gate.js", () => ({
  ...real,                          // ← every other export passes through unchanged
  describeAttachments: async (attachments) => {
    /* the one function we want to stub */
  },
}));
```

The canonical example is [`services/api/test/gallery-describe.test.ts`](../../services/api/test/gallery-describe.test.ts), which overrides two functions of `vision-gate.js` but spreads the real module so `vision-gate.test.ts` (a different file that exercises the un-mocked `resolveMultimodalContent` directly) still works. **Diagnose suspected leaks by binary-searching test-file pairs** (`bun test A.test.ts B.test.ts`) — if B passes alone but fails after A, A's `mock.module` is shadowing an export B needs.

### Fake timers — `jest.*` compat from `bun:test`

`jest.useFakeTimers()` and `jest.advanceTimersByTime()` (imported from `bun:test`) work and are the sanctioned way to control `setTimeout`/`setInterval` in tests. **`jest.setSystemTime()` is inert on the pinned Bun build** — it neither throws nor changes the clock, so tests must not rely on faking `Date.now()` through it; inject the clock or seed the time-dependent value instead.

---

## Cross-platform: the suite runs on Windows too

CI runs the full suite on both `ubuntu-latest` (`test-linux`) and `windows-latest` (`test-windows`), and **both are blocking**. Development happens almost entirely on Linux, so `test-windows` is where portability mistakes surface — every red `test-windows` to date has been a test written against Linux semantics rather than a product bug. The job stays blocking anyway: the code it covers (self-updater, installer, archive extraction, path handling) is precisely where Windows behaves differently, and that is also where most users are.

Four rules, each one a real failure that has already cost a red build:

**Never spell a path as a literal in an assertion.** `resolveEntryPath("/tmp/x", "web/a.js")` returns `/tmp/x/web/a.js` on Linux and `D:\tmp\x\web\a.js` on Windows — both correct. Build the expectation the same way the code does, with `join()`/`resolve()`, so the pin is the *nesting* an entry maps to rather than the separator character.

**Never inject a failure with POSIX mode bits.** `chmod(dir, 0o555)` is the obvious way to make a rename or an unlink fail on Linux; on Windows the read-only attribute does not block either, so the injection silently does nothing, the operation succeeds, and a test expecting `rejects.toThrow()` goes red. This failure mode is dangerous because it **fails open** — an assertion that passes under a Windows-inert injection is telling you the injection did nothing, not that the code handled the failure.

**Never assert on an RSS or an mtime delta.** Windows reports the process working set, which includes file-cache pages: a correctly-streaming 128 MB download measured +302 MB there against +17 MB on Linux. NTFS likewise bumps mtime even for a read-only SQLite open. Pin the property you actually care about instead — the schema is unchanged, the digest matches, the file on disk is the right size.

**Never shell out to a tool that is not on every runner.** `zip` is not installed on `windows-latest` (`tar` is). Prefer an in-process library; if the point of the test is specifically to consume a *foreign* artifact, branch to the platform's native tool — `Compress-Archive` on Windows — rather than dropping the case.

**Always close every `Database` handle before the temp dir is removed.** Windows locks an open SQLite file, so `rm(root, { recursive: true, force: true })` in `afterEach` fails with `EBUSY`, the directory survives, and later tests in the file inherit it until something as unrelated as `VACUUM INTO` reports "unable to open database". POSIX unlinks a file with open handles happily, so this leak is invisible on Linux and silently fatal on Windows. If a fixture must keep a connection open *during* the test — snapshotting a live uncheckpointed WAL database, say — collect the handles and close them in `afterEach`:

```ts
const openDatabases: Database[] = [];
afterEach(async () => {
	for (const db of openDatabases.splice(0)) db.close();
	await rm(root, { recursive: true, force: true });
});
```

The same applies to any OS handle a test holds — file descriptors, servers, watchers. On Windows the cleanup step is where the leak surfaces, usually blamed on whichever test ran next.

### Gating: use the smallest scope that stays honest

When behaviour genuinely has no Windows counterpart, skip explicitly and say why:

```ts
const IS_WINDOWS = process.platform === "win32";

// setuid is a POSIX-only escalation vector — there is no Windows bit to strip.
it.skipIf(IS_WINDOWS)("strips setuid/setgid bits rather than honoring them", async () => { … });
```

When only one *assertion* is unportable, keep the test running on both platforms and guard that line — the portable half still has value:

```ts
expect(await read("vibe-tavern")).toBe("#!/bin/sh\necho hi\n");   // runs everywhere
if (!IS_WINDOWS) {
	expect(((await stat(bin)).mode & 0o777).toString(8)).toBe("755");   // POSIX-only
}
```

Never leave a test green on Windows when the behaviour in its name is not being exercised there. A vacuous pass is worse than a skip: it reports coverage that does not exist.

**Known gap:** `performSwap`'s rollback path and `cleanupOldInstall`'s locked-generation sweep have no Windows coverage — their failure injection is mode-bit based and inert there, so those cases are skipped. Closing this needs a real injection seam in the updater rather than another filesystem trick.

---

## DOM tests (React components)

Component tests use **`@testing-library/react`** + **happy-dom**. The one rule that matters: **the DOM environment is scoped per file, never a global preload.**

### `useDomEnv()` — the scoped helper

Call [`useDomEnv()`](../../apps/web/test/dom-env.ts) once at the top of any `describe` that renders React:

```tsx
import { useDomEnv } from "../../../../test/dom-env.js";

describe("VibeMdView", () => {
  useDomEnv();   // registers happy-dom for THIS file only, extends expect with jest-dom, cleans up after each test

  it("renders the scenario", () => {
    const { getByText } = render(<Harness draft={makeDraft()} />);
    expect(getByText(/scenario/i)).toBeInTheDocument();
  });
});
```

**Why scoped, not a `bunfig.toml` preload:** the repo has DOM-averse tests (`avatar.test.ts`, `gateway-client`, …) that rely on `typeof window === "undefined"` so e.g. `getGatewayBaseUrl()` returns its SSR fallback. A global preload that registers happy-dom permanently injects a `window` into *every* file and breaks those. `useDomEnv()` registers in `beforeAll` and unregisters in `afterAll`, so pure-logic files never see a `window`. **Never add a `[test] preload = …` happy-dom line to `bunfig.toml`.**

### Query from `render()`, not the global `screen`

```tsx
// ✓ GOOD — queries bound to the rendered container
const { getByText } = render(<Harness />);
getByText("Save");

// ✗ BAD — `screen` binds to document.body at import time, before beforeAll runs
screen.getByText("Save");
```

`screen` captures `document.body` when the module is imported — before `useDomEnv()`'s `beforeAll` has registered the happy-dom `window`. The destructured queries from `render()` are always correct because they run after registration.

---

## Test factories

Factories are **inline per file** — there are no shared fixtures. Each test file defines its own small builders next to the tests that use them:

```ts
// common shapes: baseContext(), makeDeps(), ctx()
function baseContext(overrides: Partial<PromptAssemblyContext> = {}): PromptAssemblyContext {
  return {
    identity: { chatId: "chat_1" },
    character: { id: "char_1", name: "Aria", /* …defaults… */ },
    chat: { recentMessages: [] },
    /* … */
    ...overrides,
  };
}
```

This looks repetitive across files, but it's deliberate: shared fixtures couple every test to one builder, so a change to the shared shape breaks unrelated suites silently. A per-file `baseContext()` only changes when *that file's* needs change. Copy the closest existing factory and adapt — don't extract a shared one.

---

## What there is no framework for

- **E2E / browser automation:** there is currently no committed end-to-end test harness. For live frontend verification, run the dev server ([`bun run dev`](../../CONTRIBUTING.md#first-run) or the [split HMR setup](../../CONTRIBUTING.md#frontend-development-with-hot-module-replacement-hmr)) and test manually at desktop and mobile widths. The layout-sensitive areas (i18n text length, theme gradients, bottom-pinned message lists) are documented with the manual checks that cover them — see the checklists in [adding-a-language](../guides/adding-a-language.md#checklist) and [adding-a-theme](../guides/adding-a-theme.md#checklist).
- **Snapshot tests:** none. Behavioral assertions (`expect(...).toBe(...)`, `.toEqual(...)`, `.toBeInTheDocument()`) are preferred — they describe *what* the code does, not *what the source looked like* last Tuesday.
- **Coverage thresholds:** none configured. Coverage is uneven by design in some areas; the [tests-before-changes](../../CONTRIBUTING.md#tests-before-changes) practice (write a characterization test first) is the safeguard where coverage is thin.
