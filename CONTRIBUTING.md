# Contributing to Vibe Tavern

Thanks for considering a contribution! Vibe Tavern is a self-hosted AI-roleplaying platform — a single-process Bun monolith (React 19 SPA + Hono API + SQLite). This guide covers getting the code running locally and the conventions that keep the codebase healthy.

For the product overview, see [README.md](./README.md). For architecture deep-dives, see [`docs/architecture/`](./docs/architecture/). This document is the short path from clone to a merged change.

---

## Prerequisites

- **[Bun](https://bun.sh) 1.3.x** — the only runtime. The project does not run on Node.js. The exact pin is in the [Dockerfile](./Dockerfile); install that version (or the closest available) via `bun upgrade` or your platform installer.
- **Git** — the usual.
- An **OpenAI-compatible API key** for any provider you want to talk to (configured in-app after first launch; not needed to build or run unit tests).

No global Node, no Docker required for development. Docker is only one of the packaging targets.

---

## First run

```bash
git clone <repo-url> vibe_tavern
cd vibe_tavern
bun install
bun run dev
```

`bun run dev` starts a single dev process ([`apps/web/dev-server.ts`](./apps/web/dev-server.ts)) on **http://127.0.0.1:4173**: Bun's HTML dev server with HMR for the frontend, plus the full API mounted **in-process** — `/api`, `/assets` and `/health` are handled directly by the Hono app. No proxy, no second port, no static prod bundle. While the backend initializes (DB, tokenizers, services) API calls get a structured 503, then start answering automatically. If you want the production-style process instead (full build, static bundle served by the API on **:8787**), run `bun run prod`.

### Frontend development with Hot Module Replacement (HMR)

`bun run dev` already gives you HMR out of the box. Run the two sides separately only when you need independent control (e.g. restarting the API without losing the web session):

```bash
# terminal 1 — API only, on :8787
bun run dev:api

# terminal 2 — standalone frontend on :4173, pointed at that API
VIBE_TAVERN_WEB_API_URL=http://127.0.0.1:8787 bun run dev:web
```

`bun run dev:web` serves the frontend standalone on :4173 with no backend mounted (`--no-api`). Point it at a real backend with `VIBE_TAVERN_WEB_API_URL`: the frontend resolves its API base URL via `getGatewayBaseUrl()` ([`apps/web/src/gateway-client.ts`](./apps/web/src/gateway-client.ts)), which prefers the configured URL and otherwise falls back to `window.location.origin`.

> Port note: the dev server defaults to `4173` (override with `VIBE_TAVERN_WEB_DEV_PORT`), the API to `8787` (override with `VIBE_TAVERN_PORT`). `server-runtime.ts` frees its target port before binding, so it will never collide with another instance, but pick a free port if you run more than one.

---

## Project orientation

The repo is a Bun workspace monolith. One dependency graph, strictly downward — `domain` is the leaf (imports nothing from siblings), `services/api` sits at the top, `apps/web` consumes everything:

```
packages/domain           types, branded IDs, constants, EventBus        (zero deps)
packages/api-contracts    Zod schemas shared frontend/backend
packages/db               Drizzle ORM (SQLite WAL) + entity stores
packages/prompt-pipeline  pure prompt assembly + macro engine (no I/O)
packages/import-export    SillyTavern V2/V3 card/chat/lorebook parsers
services/api              Hono backend (Bun.serve) — the app
apps/web                  React 19 SPA (Bun-native build, no router)
```

Before changing architecture, read the relevant doc — each one explains *why* the code is shaped the way it is, including the ADRs ([`docs/architecture/decisions.md`](./docs/architecture/decisions.md)) behind anything that looks unusual (bottom-pinned message lists, the protocol registry, bind-first server bootstrap, progressive disclosure, …).

| Topic | Document |
|-------|----------|
| Tech stack & rationale | [`docs/architecture/stack.md`](./docs/architecture/stack.md) |
| Backend (routing, providers, AI execution, features) | [`docs/architecture/backend.md`](./docs/architecture/backend.md) |
| Frontend (components, stores, streaming) | [`docs/architecture/frontend.md`](./docs/architecture/frontend.md) |
| Component inventory | [`docs/architecture/components.md`](./docs/architecture/components.md) |
| API routes & contracts | [`docs/architecture/api-reference.md`](./docs/architecture/api-reference.md) |
| Prompt assembly | [`docs/architecture/prompt-pipeline.md`](./docs/architecture/prompt-pipeline.md) |
| Lorebooks & activation | [`docs/architecture/lorebooks.md`](./docs/architecture/lorebooks.md) |
| Scene Tracker (schema DSL, JSON/XML injection, AI-gen, rendering, header matrix) | [`docs/architecture/scene-tracker.md`](./docs/architecture/scene-tracker.md) |
| Experience Copilot (authoring assistant: tools, ask split-turn, todo, skills, profiles) | [`docs/architecture/experience-copilot.md`](./docs/architecture/experience-copilot.md) |
| Scripts (sandbox, lifecycle, templates) | [`docs/architecture/scripts.md`](./docs/architecture/scripts.md) |

### How-to guides

Adding one of these is mostly mechanical — each guide walks through the registry-driven pattern:

- [Adding an AI provider](./docs/guides/adding-a-provider.md)
- [Adding a chat mode (shell surface + prompt strategy)](./docs/guides/adding-a-chat-mode.md)
- [Adding a feature (assistant mode vs background LLM feature)](./docs/guides/adding-a-feature.md)
- [Adding a prompt-assembly kind (one-shot registry: summary / AI-assistant / insights)](./docs/guides/adding-an-assembly-kind.md)
- [Adding a UI theme](./docs/guides/adding-a-theme.md)
- [Adding a language (i18n)](./docs/guides/adding-a-language.md)
- [Publishing to npm (`bun install -g vibe-tavern`)](./docs/guides/publishing-to-npm.md)

---

## Engineering expectations

### Tests before changes

Test coverage is thin on some critical paths. Before changing a module:

1. Find an existing test (`<package>/test/`, or colocated under `apps/web/src/`) and run it to see current behavior.
2. **If there is no test, write one that reproduces the current behavior first** (a characterization test), then make it assert the new behavior. This is how subtle regressions get caught.
3. A logic bug in clean, typed, documented code is the normal failure mode here — not "legacy workaround decay". Catch it with a test, not a rewrite.

For the test patterns themselves (mocking, DOM tests, factories) and the three mechanism-level gotchas that have shipped silent cross-file failures, see [`docs/architecture/testing.md`](./docs/architecture/testing.md).

### Read critically, don't assume breakage

Existing code is usually intentional. When something looks over-complicated, check `docs/architecture/decisions.md` for an ADR explaining the constraint before "fixing" it. If you still can't justify it, ask rather than assume it's wrong. **Rewrite only with named, concrete defects** — "it looked messy" is the #1 way to lose load-bearing behavior. Prefer targeted edits and extend existing patterns.

### Verify before any workaround

The stack is cutting-edge. Before writing a compatibility shim, polyfill, or "just in case" helper, check the library's current docs against the installed version (`package.json`) — the framework likely already provides it natively.

---

## Code style conventions

- **Runtime:** Bun. Prefer `Bun.file()` / `Bun.write()` over `node:fs/promises` where a Bun equivalent exists.
- **TypeScript:** strict mode, ESM only, bundler module resolution. Explicit `.js` extensions on relative imports (source files are `.ts`).
- **Exports:** named only — no default exports. Components are `export function X()`.
- **Naming:** kebab-case files (`chat-store.ts`), PascalCase components (`AppShell.tsx`).
- **Branded IDs:** `CharacterId`, `ChatId`, etc. Cast only at DB/API boundaries via `brandId<T>(raw)` — never elsewhere.
- **Enums:** `as const` objects + derived types. **No TypeScript `enum`.**
- **Tailwind CSS 4:** config via `@theme {}` in `apps/web/src/styles.css`, no JS config file.

### Type safety (hard rules)

- **No `as any`.** Fix the type; if you can't, ask.
- **No `@ts-ignore` / `@ts-expect-error`** unless documenting a genuinely missing library type, with a comment.
- **No empty `catch {}`.** Handle or log the error.
- **`unknown`** is correct at type-erased boundaries (parsed JSON, catch clauses) — not as a lazy replacement for a type you could find.

---

## Database changes

SQLite (WAL mode) via Drizzle ORM. Schema lives in [`packages/db/src/db-schema.ts`](./packages/db/src/db-schema.ts); one store per entity in `packages/db/src/stores/`.

- **Add a table/column:** edit `db-schema.ts`, then `bun run db:generate` (creates a new migration). Never hand-write migration files.
- **Never edit committed migration files** in `packages/db/drizzle/` — add new ones only.
- Prototyping? `bun run db:push` pushes the schema directly without a migration.
- See [`docs/DATABASE_MIGRATIONS.md`](./docs/DATABASE_MIGRATIONS.md) for the full migration story.

---

## Running the gates

There is no eslint/prettier/biome — **TypeScript strict is the only automated gate**, plus the test runner. Run them locally before considering work done:

```bash
bun run typecheck   # typecheck every workspace — THE valid typecheck
bun run test        # bun:test across all workspaces
bun run check       # typecheck + test + i18n:check (the full local gate)
bun run i18n:check  # i18next-cli gate: missing/phantom keys (extract --ci) + incomplete translations (status)
```

> **Typecheck gotcha:** always run `bun run typecheck` from the repo root. Running bare `tsc` / `bunx tsc` from `apps/web/` against the default `tsconfig.json` produces ~80 false errors (`Property X does not exist on ClientRequest`) because that config's `rootDir` + path aliases collapse Hono's `AppType` inference. CI runs `build`, not `typecheck`; the local `check` is the gate that matters.

The test orchestrator gives every run a disposable temp root and removes it after all suites exit, while DB-only fixtures use SQLite `:memory:` where filesystem persistence is not part of the tested boundary. To place the remaining real-filesystem fixtures on an existing RAM disk, set `VIBE_TAVERN_TEST_TEMP_BASE` to a directory on that disk before running `bun run test`; Windows does not provide a native RAM-disk filesystem, so this requires a separately mounted RAM disk.

---

## Submitting your work

- **Stage explicit paths** (`git add packages/db/...`), not `git add -A` / `git add .` — the working tree often holds unrelated local experiments that shouldn't land in your commit.
- Run `bun run check` (typecheck + test + i18n) for every workspace you touched.
- `git diff --stat` should match what you intended to change — no surprise files.
- No new `as any`, `@ts-ignore`, or empty `catch {}` (or each has a justified comment).
- If you translated strings or touched UI text, re-read [the layout section of adding-a-language](./docs/guides/adding-a-language.md#layout--text-length) — translated text is longer than English and breaks fixed-width layouts.

### Good first contributions

- 🌍 **Translations** — see [adding-a-language](./docs/guides/adding-a-language.md); the `i18n:check` script tells you exactly what's missing.
- 🎨 **CSS themes** — see [adding-a-theme](./docs/guides/adding-a-theme.md).
- 🐛 **Bug reports** — include the dev-server console output and the `data/logs/` debug log when relevant.
- 📖 **Documentation improvements** — typos, gaps, and clearer explanations are always welcome.

---

## License

By contributing, you agree your changes will be released under the project's license (see [README.md](./README.md#license)).
