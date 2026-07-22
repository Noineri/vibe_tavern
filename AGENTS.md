# VIBE TAVERN (code repo) — KNOWLEDGE BASE

**Generated:** 2026-07-20 · Branch `dev` @ a52d9443 · Workspace rules: `../AGENTS.md` (codebase reality, type-safety zero tolerance, signed commits) — they apply here in full.

## OVERVIEW

Single-process Bun monolith: React 19 SPA (`apps/web`) + Hono 4 API (`services/api`) + SQLite WAL (`packages/db`) — the API serves the built frontend; no separate deployment units. Local-first, self-hosted AI roleplay with SillyTavern-compatible imports.

## STRUCTURE

```
vibe_tavern/
├── apps/web/                 # React 19 SPA (Vite, no router) — has own AGENTS.md
├── services/api/             # Hono backend (Bun.serve) — has own AGENTS.md
├── packages/domain/          # Zero-dep foundation: branded IDs, entities, constants, EventBus
├── packages/api-contracts/   # Zod schemas shared frontend/backend (+ browser-safe wire-types)
├── packages/db/              # Drizzle ORM (SQLite WAL) + entity stores + VTF codecs — has own AGENTS.md
├── packages/prompt-pipeline/ # Pure prompt assembly + macros + compaction (no I/O) — has own AGENTS.md
├── packages/import-export/   # SillyTavern V2/V3 card/chat/lorebook/persona/preset parsers
├── mobile/                   # Android launcher (Kotlin/Gradle, drives a Termux server) — separate build
├── scripts/                  # Build/packaging/type-gate/test CLIs (Bun.build — no webpack/esbuild/tsc emit)
├── docs/                     # architecture/ (reference + decisions.md ADRs) + guides/ (how-to)
├── data/                     # Runtime data (SQLite, characters, assets) — gitignored
└── out/                      # Build output — gitignored, never edit
```

## DEPENDENCY GRAPH (strictly one-directional, no cycles)

```
packages/domain              ← zero deps, the leaf
├── packages/api-contracts   ← domain + zod
├── packages/db              ← domain + drizzle-orm
├── packages/prompt-pipeline ← domain (pure)
└── packages/import-export   ← domain (parsers)
        ▼
services/api                 ← all packages + hono + AI SDK
        ▼
apps/web                     ← api, domain, db[/codecs], prompt-pipeline, api-contracts, import-export
```

`domain` imports nothing from siblings. Reality check: `services/api/src/domain` is NOT strictly hexagonal — it imports `@vibe-tavern/db` and `infrastructure/ai` directly (see `services/api/AGENTS.md`).

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add API endpoint | `services/api/src/api/routes/` (register in `routes/index.ts`) + adapter in `api/adapters/` + Zod schema in `packages/api-contracts/src/schemas/` |
| Add UI component | `apps/web/src/components/{chat,modals,settings,build,coauthor,shared}/` — check `shared/` first |
| Add Zustand store | `apps/web/src/stores/` (immer for canonical snapshot data, plain for UI state) |
| Add domain type | `packages/domain/src/entities.ts` + branded ID in `ids.ts` |
| Add DB table | `packages/db/src/db-schema.ts` + store in `src/stores/`, then `bun run db:generate` |
| Add Zod schema | `packages/api-contracts/src/schemas/` + export from `schemas/index.ts` |
| Add LLM provider | `services/api/src/domain/providers/` (protocol registry) + `docs/guides/adding-a-provider.md` |
| Modify prompt assembly | `packages/prompt-pipeline/src/assemble.ts` (pure); layer constants in `prompt-layer-constants.ts` |
| Add build tab | `apps/web/src/lib/build-panel-registry.ts` |
| Character card import | `packages/import-export/src/cards/` |

Docs: `docs/architecture/` (stack, backend, frontend, components, prompt-pipeline, lorebooks, scene-tracker, api-reference, `decisions.md` ADRs) + `docs/guides/` (adding a provider/feature/theme/language); authoritative index in `CONTRIBUTING.md`. Where docs and code disagree, the code is what runs — and per workspace rule 1, neither is automatically "correct"; verify against current source.

## CODE MAP

Entry chain: `services/api/src/server/prod-server.ts` (dev/prod) and `standalone-server.ts` (dist binaries; `--version`/`check-update`/`update` CLI) → shared `server-runtime.ts` (bind-first: serves a loading placeholder, async-inits DB/stores/tokenizers/services, then swaps in the live Hono handler) → `app-factory.ts` `createApp()` → `api/routes/index.ts` (central registry) + feature routes + static frontend. Web: `apps/web/index.html` → `src/main.tsx` (fetch interception, i18n, hash dev-surfaces) → `src/app.tsx` → `components/layout/AppShell.tsx`.

| Symbol | Location | Role |
|---|---|---|
| `useChatStore` | `apps/web/src/stores/chat-store.ts` | Frontend state center (~170 refs): active chat, drafts, streaming, abort controllers |
| `app-client.ts` | `apps/web/src/app-client.ts` | Compat barrel re-exporting all `src/api/*-api.ts` (~53 importers) |
| `assemblePrompt` | `packages/prompt-pipeline/src/assemble.ts` | Canonical prompt assembly (~35 refs / 13 modules) |
| `createDb` / `AppDb` | `packages/db/src/db-connection.ts` | DB init + boot migrations; shared DB type for all stores |
| `createStoreContainer` | `packages/db/src/persistence.ts` | Store composition root (16 stores + filesystem) |
| `createApp` | `services/api/src/server/app-factory.ts` | Hono app factory (middleware, API router, static/embedded frontend) |
| `SessionRuntime` | `services/api/src/runtime/session/session-runtime.ts` | Session/bootstrap/chat orchestration |

Centrality counts are text-reference proxies (no TS LSP installed) — treat as approximate.

## CONVENTIONS

- **Runtime: Bun, never Node.** All scripts use the `bun` CLI; prefer `Bun.file()`/`Bun.write()` over `node:fs/promises` where a Bun equivalent exists.
- **TypeScript:** strict, ESNext target, bundler module resolution, ESM only (`"type": "module"` in every workspace).
- **Imports:** explicit `.js` extension on relative imports (source is `.ts`); `@vibe-tavern/*` aliases resolve to raw TS source — no build step in dev.
- **Exports:** named only, no default exports; components are `export function X()`.
- **Naming:** kebab-case files (`chat-store.ts`), PascalCase components (`AppShell.tsx`), `use-*.ts` hooks → `useXxx`, `*-store.ts` → `useXxxStore`, `*-api.ts` → verb-named async functions.
- **Branded IDs:** phantom `Brand<T>` (`CharacterId`, `ChatId`, …); cast only at DB/API boundaries via `brandId<T>(raw)`.
- **Enums:** `as const` objects + derived types — NEVER TypeScript `enum`.
- **Tailwind 4:** CSS-first config via `@theme {}` in `apps/web/src/styles.css`; no JS config file. Fonts: Inter (UI), Alegreya (body/reading), JetBrains Mono (code).
- **No linter/formatter** (no eslint/prettier/biome/editorconfig anywhere) — TS strict is the only static gate; `i18n:check` rides along in `bun run check`.
- **Markdown prose:** one sentence/point per single unwrapped line — no mid-sentence hard breaks; code blocks, tables, diagrams keep their formatting.
- **Versions:** live in `package.json`; Bun is pinned in `Dockerfile`. Do not hardcode version numbers in code or comments.

## ANTI-PATTERNS (this project — on top of the workspace zero-tolerance list)

- **Never run table-rebuild migrations through the statement-by-statement healer** (`packages/db/src/db-connection.ts`) — transactional `migrate()` only; a loud boot failure beats silent data loss.
- **Scene/job/projection tables are NEVER authoritative** — canonical scene data lives in `message_variants.scene_tracker_json`; caches are rebuildable mirrors; changing tracker config never hides/invalidates persisted records; schema incompatibility is a coherence check, not a visibility gate.
- **Never split a tool-call from its tool-result during prompt compaction** (`packages/prompt-pipeline/src/compaction.ts` — read the boundary algorithm's doc comment first).
- **Do not "simplify" streaming-scroll / bottom-pinning effects** in `MessageScroller.tsx` / `MessageBlock.tsx` — load-bearing; manually test long↔short variant swipes at chat bottom before any change.
- **Co-author tools NEVER write to `CharacterStore`** — they return validated proposals; the user commits via the Apply RPC.
- **Greeting filenames are stable IDs** — never derived from content (`packages/db/src/vtf/greetings.ts`); profile MD always emits PERSONALITY/SCENARIO/EXAMPLES headings, even empty (`vtf/profile-md.ts`).
- **Model-overlay PATCHes exclude provider identity fields** — overlays carry sampler/context settings only (`apps/web/src/hooks/save-provider-patch.ts`).
- **Prompt-injection drag reorders positional metadata only** — never mutates `customInjections` (`InjectionTable.tsx`).
- **Do not edit generated files:** committed migrations in `packages/db/drizzle/`, embedded-web-manifest outputs (`scripts/generate-embedded-web-manifest.ts`).

## COMMANDS (run from `vibe_tavern/`)

```bash
bun run dev          # build all + start prod server (NOT an HMR server)
bun run dev:web      # vite dev server, frontend only (port 4173)
bun run dev:api      # API server only
bun run build        # full production build → out/
bun run typecheck    # THE only valid typecheck (type-gate + per-workspace tsconfig.typecheck.json)
bun run test         # isolated suites: scripts + packages + api (bun:test), web (vitest)
bun run check        # typecheck + test + i18n:check — the local gate
bun run db:generate  # generate Drizzle migration from db-schema.ts changes
bun run db:push      # push schema directly (prototyping only)
```

- CI (`.github/workflows/ci.yml`): typecheck is the sole blocking gate; tests are `continue-on-error` — green CI ≠ tested; run `bun run check` locally.
- Bun 1.3.14 `bun install --frozen-lockfile` resolves platform-specific optional dependencies correctly (Bun issue #16696 is fixed); no post-install workaround exists.
- No mandatory env vars; `VITE_RP_API_URL=http://127.0.0.1:8787` for split vite+API dev. Runtime overrides: `RP_PLATFORM_*` (port, host, data/db/migrations dirs, TLS).

## TEST PATTERNS

- **Split runners, NOT interchangeable:** `apps/web` = vitest (`happy-dom` env, setup `test/vitest-setup.ts`, include `src/**/*.test.ts(x)`, `vi.mock`); packages + services + scripts = bun:test (`mock()`, `mock.module()`). Imports come from `"vitest"` vs `"bun:test"` respectively.
- **Location:** web tests colocated in `src/` (files under `apps/web/test/` are NOT typechecked — tsconfig `rootDir:"src"`); packages/services use `<pkg>/test/*.test.ts` — flat, feature-named, not mirroring src.
- **DB/API tests:** real Bun SQLite via `createDb()` (tmp file from `mkdtemp`, or `:memory:` — both run the real migration stack); no PGlite; no shared fixtures (inline `makeDeps()`/`ctx()` factories per file).
- **`mock.module()` is process-global (bun:test only):** a partial factory makes every OTHER export `undefined` for all later files in the same run. Safe pattern: `const real = await import(spec)` BEFORE registering, then spread `...real` and override only what you need. Never delete a test to dodge this.
- **No e2e config** (no Playwright/Cypress); `apps/web/test/harness.smoke.test.tsx` sits outside vitest's include. For live UI checks use the agent-browser MCP against `bun run dev:web`.

## GOTCHAS

- **Bare `tsc --noEmit` from `apps/web/` emits ~80 false errors** ("Property X does not exist on ClientRequest" across RPC client files) — the default tsconfig's `rootDir:"src"` + `composite:true` + aliases outside rootDir collapses Hono's `AppType` inference. Only `bun run typecheck` from the repo root is valid; if you see ClientRequest errors, you ran the wrong config.
- **Duplicate basenames, different worlds:** `apps/web/src/stores/{chat,character,provider}-store.ts` (Zustand UI state) vs `packages/db/src/stores/{chat,character,provider}-store.ts` (Drizzle persistence); also `apps/web/src/api/runtime-api.ts` vs `services/api/src/api/contract/runtime-api.ts`. Check the path before editing.
- **`extract-thinking-tags.ts` exists twice** (`packages/domain/src/` and `services/api/src/infrastructure/ai/`) — parallel implementations; check both before "fixing" one.
- **God-objects (>1000 lines, workspace-rule-2 rewrite candidates — but behavior-pinned, boundaries first):** `services/api/src/domain/insights/tracker-service.ts` 1167, `services/api/src/runtime/session/session-runtime.ts` 1129, `packages/db/src/stores/lorebook-store.ts` 1208, `packages/prompt-pipeline/src/assemble.ts` 1009, `apps/web/src/components/dev/ThemeTuner.tsx` 1344, `apps/web/src/components/build/editors/LorebookEditor.tsx` 1028.
- **`chat-application-service.ts` reaches a store's private DB handle** for a branch insert — a known exception, not a pattern to copy.
- **i18n:** en + ru, registry-driven (`apps/web/src/i18n/registry.ts`); Russian runs 20–30% longer — never fix-width i18n strings; run `bun run i18n:check` after touching strings.

## BUILD & DEPLOY

Custom `scripts/build.ts` (`Bun.build`) compiles API/packages; Vite builds the frontend → `out/`. Targets: Docker (multi-stage, Alpine + tini, port 8787), Windows installer (Inno Setup), Linux tar.gz + self-updater, Android APK (Kotlin launcher + Termux). Bun version pinned in `Dockerfile`. Release: push a `v*` tag → `.github/workflows/release.yml` (artifacts + GHCR + SHA256 checksums).
