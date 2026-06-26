# Tech Stack & Dependencies

> **Why each technology was chosen and what role it plays.**

---

## Runtime & Language

| Choice | What | Why |
|--------|------|-----|
| **Bun** | Runtime, bundler, test runner, SQLite driver, file I/O | Single binary handles everything Node does plus native SQLite (`bun:sqlite`), built-in test runner, `Bun.file()` API, `Bun.write()`, crypto via `Bun.CryptoHasher`. Enables `bun build --compile` → single `.exe` distribution. No Node.js installation required for end users. |
| **TypeScript ^6** | Language | Strict mode throughout. Branded IDs (`Brand<"ChatId">`) prevent accidental ID swaps at compile time. All API contracts are Zod schemas that produce TS types. |
| **Vite 8** | Frontend build, HMR | Fastest dev server available. Native TS/ESM support. Plugin system for React, Tailwind. Bun-level startup speed. |

**Why not Node.js:** Bun provides native SQLite, faster `crypto`, `Bun.file()` as a cleaner fs API, and single-binary compilation. The project still uses `node:vm` (script sandbox), `node:fs/promises` (directory ops with no Bun equivalent), `node:crypto` (where needed for compatibility), `node:os` / `node:path` (platform paths) — but these are isolated cases.

---

## Backend

### Hono ^4

HTTP framework. Replaces Express/Koa/Fastify.

**Why Hono:**
- **Edge-first, Bun-native** — runs on Bun, Deno, Cloudflare Workers, Node. No Express/Connect legacy.
- **Type-safe routing** — `app.get('/api/chats/:id', handler)` infers param types.
- **Built-in middleware** — CORS, validator, error handler. No need for `cors`, `helmet`, `body-parser` packages.
- **Tiny** — 14KB gzipped. Express is 200KB+.
- **Shared between client and server** — the `app-client.ts` Hono RPC client type-checks API calls against route definitions. Frontend gets compile-time safety without code generation.

**Why not Express:** Unmaintained patterns, no native TypeScript, middleware ecosystem is aging, bloated for an API-only server.

**Why not Fastify:** Heavier plugin system, less elegant Bun integration, overkill for the routing needs.

### Vercel AI SDK (`ai` ^6)

Unified streaming interface across LLM providers.

**Why AI SDK:**
- **Provider-agnostic** — `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google` all share the same `streamText()` / `generateText()` API. Adding a new provider = adding a package. OpenAI-compatible aggregators (OpenRouter, NanoGPT, Featherless, local llama.cpp / Ollama) all go through `createOpenAICompatible()` from `@ai-sdk/openai-compatible` — **never** `createOpenAI()` from `@ai-sdk/openai`. The latter defaults to the Responses API (`input` + `max_output_tokens`), which aggregators serve unreliably; `createOpenAICompatible()` uses the classic Chat Completions format that aggregators implement correctly.
- **Streaming built-in** — `streamText()` returns an async iterable of `{type: "text-delta" | "reasoning-delta" | "finish"}` chunks. No SSE parsing needed.
- **Reasoning support** — native `reasoning` field on responses (DeepSeek R1 thinking, Claude extended thinking).
- **Tool calling** — structured tool definitions with Zod schemas.

**Why not raw fetch:** Every provider has different SSE formats, error handling, and streaming quirks. AI SDK normalizes all of this.

### Drizzle ORM ^0.38

SQL-first ORM over SQLite.

**Why Drizzle:**
- **SQL-like API** — `db.select().from(messages).where(eq(messages.chatId, id))` maps 1:1 to SQL. No magic query builder.
- **Type inference** — schema definition produces full TypeScript types. No code generation step.
- **Migration system** — `drizzle-kit generate` produces SQL migration files. `drizzle-kit push` for prototyping.
- **SQLite-native** — uses `bun:sqlite` as driver. No native bindings to install.
- **Zero runtime overhead** — queries compile to SQL strings, not interpreted at runtime.

**Why not Prisma:** Rust engine binary download issues on some platforms, slower cold starts, abstraction too far from SQL for complex queries (joins, aggregations). Prisma's `queryRaw` defeats the purpose.

**Why not TypeORM:** Decorator-heavy, less type-safe, active record pattern doesn't fit the store architecture.

### SQLite

**Why SQLite:**
- **Zero-config** — single file, no server process, no connection pooling.
- **WAL mode** — concurrent reads with single writer. Perfect for local single-user app.
- **Embedded** — ships with Bun, no separate installation.
- **Portable** — the entire database is one file in `data/`. Backups = copy the file.

**Why not PostgreSQL/MySQL:** Local-first single-user app. A database server is unnecessary overhead. SQLite handles the load profile (one user, bursty writes, many reads) perfectly.

### Zod ^3.24

Runtime validation + static types.

**Why Zod:**
- **Shared between front and back** — `@vibe-tavern/api-contracts` defines schemas once, used by both route validation (`@hono/zod-validator`) and frontend type inference.
- **Type inference** — `z.infer<typeof schema>` produces TypeScript types from schemas. No duplicate type definitions.
- **Error messages** — structured validation errors with path info. Frontend can display field-level errors.

### `@agnai/web-tokenizers` + `js-tiktoken`

Token counting for context budget management and tokenizer-specific logit-bias tooling.

**Why two libraries:**
- `js-tiktoken` — fast BPE tokenization for OpenAI models (cl100k, o200k, p50k encodings).
- `@agnai/web-tokenizers` — WASM/JSON tokenizers for Claude, Llama 3, Mistral, Nemo, Qwen2, DeepSeek, Xiaomi MiMo, GLM-4.6/ZAI, and Command R/A. Larger but more accurate for non-GPT models.
- Default fallback — prompt budgeting can fall back to `cl100k_base`/rough estimates when no tokenizer matches, but logit bias is fail-closed and disabled for unknown tokenizers.

---

## Frontend

### React 19

UI framework.

**Why React (not Svelte/Vue/Solid):**
- **Largest ecosystem** — Radix UI, Framer Motion, react-virtuoso, react-markdown all have first-class React support.
- **React 19 features used:** `useSyncExternalStore` (Zustand integration), `React.memo` for message block optimization, `useActionState`.
- **Server components not used** — the app is a SPA with HTTP API. No SSR/RSC.

### Tailwind CSS 4

Utility-first styling.

**Why Tailwind:**
- **Zero runtime** — all classes purged at build time.
- **Dark mode** — `dark:` variant for theme switching.
- **oklch colors** — modern color space for consistent perceptual lightness across palette.
- **No CSS-in-JS** — avoids runtime style injection overhead. classNames are static strings.

**Why not CSS Modules / Styled Components:** Chat UI has hundreds of unique one-off styles. Named classes become noise. Utility classes are co-located with the markup they style.

### Framer Motion ^12

Animation library. Used for:
- **Variant swipe animation** — `AnimatePresence mode="popLayout"` with direction-aware slide + blur transition.
- **Modal open/close** — smooth enter/exit transitions.
- **Mobile carousel** — `useAnimationControls` for programmatic slide commits after drag.
- **Toggle switches** — smooth transition between states.

**Why not CSS transitions only:** `AnimatePresence` handles exit animations (unmounting elements). CSS `transition` can't animate elements leaving the DOM. Direction-aware animations (slide left vs right based on swipe direction) need JS-driven state.

**Why not GSAP:** Imperative API, no React integration story, larger bundle. Framer Motion is declarative and React-native.

### react-virtuoso ^4

Virtual scrolling for message list.

**Why Virtuoso (not react-window / @tanstack/virtual):**
- **Reverse list support** — chat messages grow upward. Virtuoso has built-in `initialTopMostItemIndex` and `followOutput="smooth"` for auto-scroll.
- **Dynamic height** — messages vary from 1 line to 500+ tokens. Virtuoso measures each item automatically. No manual `estimateSize` needed.
- **Footer component** — renders `StreamingContent` (pending user message + streaming reply) as a virtual item at the bottom.

### Radix UI

Accessible primitives for dialogs, selects, tooltips.

**Why Radix (not Headless UI / shadcn):**
- **Unstyled** — full control over appearance with Tailwind. No overriding default styles.
- **Focus management** — focus trap in modals, arrow key navigation in selects, proper ARIA attributes.
- **Portal support** — `DropdownSelect` portals into modal focus scope. Native `<select>` can't portal and breaks z-index in modals.

### Zustand ^5 + Immer ^11

State management.

**Why Zustand (not Redux / Jotai / MobX):**
- **Minimal boilerplate** — `create((set, get) => ({ ... }))`. No actions, reducers, dispatchers, or providers.
- **External store** — `useSyncExternalStore` integration. Components subscribe to focused slices, not entire state tree.
- **No context** — Zustand stores are plain JS modules. No `<Provider>` wrapping needed. Store updates don't trigger React re-renders unless the subscribed slice actually changes.

**Why Immer:** `produce(draft => { draft.chats[id].messages.push(msg) })` — mutable syntax for immutable updates. Avoids spread operator hell for deeply nested state.

**Memoization:** `useMemo` + `useShallow` from Zustand for derived data. `useDisplayMessage(id)` computes message + variants + streaming state without re-computing on every render.

### React Hook Form + Zod resolver

Form handling.

**Why RHF:** Handles character editor, persona editor, preset editor. `register()` binds inputs, `handleSubmit()` validates via Zod schema. No controlled component overhead for large forms.

### react-markdown + remark-gfm

Markdown rendering in chat messages.

**Why react-markdown (not marked / markdown-it):** React component, not a string renderer. Properly escapes HTML, handles JSX renderers for custom elements. `remark-gfm` adds tables, strikethrough, task lists. A custom rehype pass highlights exact quoted-dialogue ranges, including inline markup split across AST nodes.

### CodeMirror 6

Script editor.

**Why CM6 (not Monaco):** Lightweight (~200KB vs Monaco's ~4MB). Prosemirror-like state management. `@codemirror/lang-javascript` for syntax highlighting. Custom dark theme using CSS vars + oklch. Syncs with React via `value`/`onChange` props.

### Sonner

Toast notifications.

**Why Sonner (not react-hot-toast):** Cleaner API, better animations, supports `position`, `duration`, `richColors`. Single function call: `toast.success("Saved")`.

### react-easy-crop

Avatar cropping tool. Provides circular crop overlay with zoom/pan. Outputs 480×480 PNG.

### qrcode

QR code generation for the web Mobile Access flow. Renders `http(s)://IP:PORT/#token=UUID` as a scannable QR/copy URL; the browser stores the token locally before API bootstrap.

### @dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities

Drag-and-drop primitives. Two surfaces:
- **Lorebook editor** (`LoreEntryList.tsx`) — single-container sortable list with drag handles for reordering lore entries.
- **Prompt injection table** (`InjectionTable.tsx`) — cross-container drag and drop (multiple `SortableContext`s) for reordering prompt injections.

Both use `<DragOverlay>` to render the dragged item in a portal, which avoids the first-frame layout jump that plain `useSortable` produces and lets dnd-kit autoscroll the container during a drag.

**Why dnd-kit (not react-beautiful-dnd):** Active maintenance, better touch support, `SortableContext` for list reordering with minimal boilerplate, and `<DragOverlay>` for portal-style drag previews (react-beautiful-dnd is unmaintained and has no overlay equivalent).

---

## Monorepo Structure

Bun workspace with 5 packages + 2 apps:

```
vibe-tavern/
├── packages/domain/          # Zero deps. Types, IDs, constants.
├── packages/api-contracts/   # Zod schemas + shared wire-DTO interfaces. Depends on domain only.
├── packages/db/              # Drizzle stores. Depends on domain.
├── packages/prompt-pipeline/ # Pure assembly function. Depends on domain.
├── packages/import-export/   # Card/chat parsers. Depends on domain.
├── services/api/             # Backend. Depends on all packages.
└── apps/web/                 # Frontend SPA. Imports shared types from api-contracts; talks to api over HTTP.
```

**Dependency rule:** Arrows point downward only. No cycles. `domain` is the leaf — zero imports from other packages.

**Why monorepo (not polyrepo):** Shared types between front and back. Single `bun install`. Atomic changes across packages (e.g., adding a DB column touches domain → db → api-contracts → api → web in one PR). The shared `api-contracts` package is what makes type drift between the two sides a compile error instead of a silent runtime bug — the wire-format DTO interfaces live there once and are imported by both the backend mappers and the frontend `api/types.ts`.

**Why workspace packages (not a single `src/`):** Enforces dependency boundaries. `prompt-pipeline` cannot accidentally import from `db`. The compiler catches violations.

---

## Build & Deploy

| Target | Method | Output |
|--------|--------|--------|
| **Dev (frontend)** | `bun run dev:web` — Vite dev server with HMR | Vite-served SPA |
| **Dev (backend)** | `bun run dev:api` — Bun API server with watch | `services/api/src/` |
| **Dev (full stack)** | `bun run dev` — builds the API stack then starts the production-style server | `out/services/api/` + `data/` |
| **Production bundle** | `bun run build` — builds the API stack + Vite frontend | `out/services/api/`, `out/apps/web/` |
| **Docker** | `docker-compose up` — Bun runtime + built frontend in single container | Uses production bundle |
| **Standalone .exe** | `bun run build:standalone` — single binary with embedded frontend + assets | `out/standalone/vibe-tavern.exe` |
| **Windows installer** | `bun run build:installer` — Inno Setup wrapper around the standalone exe | `out/installer/vibe-tavern-setup.exe` |
| **Linux** | `bun run build:linux-dist` — cross-compile + self-updater tarball | `out/linux-dist/` |
| **Android** | `bun run build:android-arm64` — cross-compile for ARM64 | `out/android-arm64/` |

**Why standalone .exe:** The target audience (RP community) includes non-technical users. Download one file, double-click, it opens in browser. No Node.js, no `npm install`, no terminal.

---

