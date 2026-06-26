# Testing

> Companion to [CONTRIBUTING.md → Running the gates](../../CONTRIBUTING.md#running-the-gates) and [Backend Architecture](./backend.md).

Vibe Tavern uses **`bun:test`**, Bun's built-in test runner. There is no Jest, Vitest, or separate test config — `bun test` is the whole story. This document covers where tests live, the patterns that recur across the suite, and the three mechanism-level gotchas that have historically shipped silent cross-file failures.

---

## Commands

```bash
bun run test           # all workspaces
bun test <path>        # one file or directory
bun test -t "name"     # filter by test name
bun run check          # typecheck + test + i18n:check (the full local gate)
```

CI runs `build` but **not** `test` or `typecheck` — the local `bun run check` is the gate that matters. See [CONTRIBUTING.md → Running the gates](../../CONTRIBUTING.md#running-the-gates) for the typecheck caveat (always `bun run typecheck` from the repo root; bare `tsc` from `apps/web/` emits ~80 false errors).

---

## Where tests live

| Location | Convention | Typechecked? |
|----------|-----------|--------------|
| `<package>/test/<module>.test.ts` | Backend & package tests (`packages/*/test/`, `services/api/test/`) | ✅ |
| `apps/web/src/**/<module>.test.ts(x)` | **Colocated** next to the source under test | ✅ |
| `apps/web/test/**` | Non-colocated web tests | ❌ not typechecked |

**Rule:** web tests must be colocated under `apps/web/src/` if they need to be part of the typecheck gate. `apps/web/tsconfig.json` has `rootDir:"src"` + `include:["src/**"]`, so anything under `apps/web/test/` is invisible to `tsc`. (The one helper there, [`apps/web/test/dom-env.ts`](../../apps/web/test/dom-env.ts), is fine — it's imported by colocated tests, which pulls it into the type graph.)

Current suite size: ~96 test files, spread across `services/api` (~39), `packages/db` (~18), `apps/web/src` (~22), `packages/api-contracts` (~9), `packages/prompt-pipeline` (~7), `packages/domain` (~4), `packages/import-export` (~2).

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

**This is the dangerous one.** A mock registered with `mock.module(specifier, factory)` persists for the **entire process** across every test file in the same `bun test` run, not just the file that registered it. If the factory returns only a few exports, every *other* export of that module becomes `undefined` for all subsequent files — a silent cross-file leak.

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
