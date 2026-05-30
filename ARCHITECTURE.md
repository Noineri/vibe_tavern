# Vibe Tavern — Architecture

> **Local-first AI roleplay platform.** Self-hosted, zero cloud dependency, single binary distribution.

## What is this?

Vibe Tavern is a self-hosted roleplay chat application — a local alternative to SillyTavern. Import character cards, chat with AI characters through any LLM provider, and manage prompts, personas, and chat history.

**Core features:**

- Import character cards (SillyTavern V2/V3 PNG+JSON), lorebooks, and chat histories
- Chat with AI characters via OpenAI-compatible, Anthropic, Google, Ollama, or llama.cpp endpoints
- Assemble prompts from layered components with priority-based ordering, depth injection, and context-budget-aware compaction
- Resolve macros (`{{char}}`, `{{user}}`, `{{scenario}}`, etc.) — SillyTavern-compatible
- Branch chats from any message, regenerate replies, and maintain multiple response variants (swipes)
- Lorebook system with keyword activation, AND/OR/NOT logic, scan depth, recursive scanning, probability, cooldown/delay windows, position injection, group weights, per-entry overrides
- Script system — user-written JavaScript executed in a sandboxed VM with Janitor AI-compatible `context` object API
- Memory system — ranged summaries with auto-summary, message history limit, branch-scoped storage
- Prompt trace recording for debugging (which layers activated, token counts, final payload)
- Secure mobile access — QR code + token auth for LAN/mobile clients, optional TLS
- Build Mode — unified editor panel for character, lorebooks, scripts, and prompt trace inspection

**Stack:** Bun · Hono · Drizzle ORM / SQLite · Vercel AI SDK · Vite / React · TypeScript monorepo

---

## Architecture Documentation

| Document | Content |
|----------|---------|
| [**Tech Stack**](docs/architecture/stack.md) | Why each technology was chosen. Bun, Hono, Drizzle, Zustand, Virtuoso, Framer Motion, etc. |
| [**Frontend**](docs/architecture/frontend.md) | MessageBlock architecture, variant carousel, ghost message fix, stores, selectors, streaming, Build Mode. |
| [**Backend**](docs/architecture/backend.md) | Session runtime, provider execution, lore activation engine, script sandbox, memory system, prompt pipeline. |
| [**Decisions**](docs/architecture/decisions.md) | Key architectural decisions with rationale: bottom-pinning, carousel, portals, sync scripts, branded IDs, etc. |
| [**Shared Components**](docs/architecture/components.md) | Reusable UI components: Toggle, Checkbox, ToggleChips, DropdownSelect, Modal, AutoTextarea, tooltips, etc. |
| [**Native Elements Index**](docs/architecture/native-elements-index.md) | Audit of native selects, title attributes, textareas, sliders, and suggested custom replacements. |
| [**Database Migrations**](docs/DATABASE_MIGRATIONS.md) | Migration system, journal constraints, schema evolution. |
| [**Packaging**](docs/PACKAGING.md) | Build targets: Docker, standalone .exe, Android ARM64. |

---

## Repository Structure

```
vibe_tavern/
├── apps/web/                    # Frontend SPA (React + Vite)
│   └── src/
│       ├── components/          # UI components (MessageBlock, editors, modals, shared)
│       ├── hooks/               # useBuildPanels, use-chat-controller, use-mobile, etc.
│       ├── lib/                 # build-panel-registry, cn, avatar, macros, markdown, sse-parser
│       ├── stores/              # Zustand stores + API actions
│       └── i18n/                # Multi-language support (en, ru)
├── packages/
│   ├── domain/                  # Shared types, branded IDs, constants — zero logic
│   ├── api-contracts/           # Zod schemas for HTTP request validation
│   ├── db/                      # Drizzle ORM schema, SQLite stores, persistence
│   ├── prompt-pipeline/         # Pure prompt assembly function — no I/O, no DB
│   └── import-export/           # Character card and chat import/export (ST formats)
├── services/api/
│   └── src/
│       ├── routes/              # 11 domain-split route modules
│       ├── ai/                  # Provider execution, tokenizer, sampler mapping
│       ├── session-runtime*.ts  # Session coordination sub-runtimes
│       ├── live-chat-orchestrator.ts  # Streaming message coordination
│       ├── lore-activation-engine.ts  # Pure lore activation function
│       ├── script-sandbox.ts    # node:vm script execution
│       ├── mobile-auth.ts       # Auth middleware + TLS config
│       └── prod-server.ts / standalone-server.ts  # Entry points
├── scripts/                     # Build, dev supervisor, static serving
├── data/                        # Runtime data (SQLite DB, assets, traces, summaries)
└── docs/architecture/           # This documentation
```

### Dependency Flow

Arrows point downward only. No cycles. `domain` is the leaf — zero imports from other packages.

```
services/api
  ├── packages/domain        (types only)
  ├── packages/db            (stores, depends on domain)
  ├── packages/api-contracts (zod schemas, depends on domain)
  ├── packages/prompt-pipeline (depends on domain)
  └── packages/import-export   (depends on domain)

apps/web
  └── services/api  (via HTTP — Hono RPC client for type safety)
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (apps/web)  —  React/Vite SPA                  │
│  Zustand stores ← API actions ← Hono RPC client          │
│  MessageBlock (memo) reads useDisplayMessage(id)          │
│  BuildMode → BuildPanel registry → editors                │
└──────────────┬───────────────────────────────────────────┘
               │ HTTP / SSE
┌──────────────▼───────────────────────────────────────────┐
│  routes/ — 11 domain modules, composed via Hono app.route │
│  validates via zod schemas from @vibe-tavern/api-contracts│
└──────────────┬───────────────────────────────────────────┘
               │ delegates to RuntimeApi interface
┌──────────────▼───────────────────────────────────────────┐
│  RuntimeApiAdapter — thin facade, zero business logic     │
└──┬─────┬──────┬───────┬──────┬──────┬──────┬─────────────┘
   │     │      │       │      │      │      │
   ▼     ▼      ▼       ▼      ▼      ▼      ▼
Session  Live   Chat    Provider Prompt Chat  Asset
Runtime  Chat   Summary Profile  Preset Order
         Orch.  Service Service  Service Service
```

---

## Core Data Flow: Sending a Message

The most important flow. Every AI generation path follows this shape:

```
POST /api/chats/:chatId/messages/stream
  │
  ▼ LiveChatOrchestrator.sendMessageStream()
  │
  ├─ prepareLiveTurn()
  │   ├─ appendUserMessage()                    → DB INSERT
  │   └─ assembleForChat()
  │       ├─ Load character, persona, preset, lorebooks
  │       ├─ Load summaries + exclusion ranges
  │       ├─ resolveActivatedEntries()           → lore-activation-engine (pure)
  │       ├─ executeScripts()                    → node:vm sandbox (sync, 5s timeout)
  │       ├─ Macro resolution
  │       └─ assemblePrompt()                    → prompt-pipeline (pure)
  │           ├─ Build layers by position + priority
  │           ├─ Inject lore at configured depths
  │           └─ Compact history if budget exceeded
  │
  ├─ streamProviderExecutor()
  │   ├─ mapProfileToSdkModel()                  → AI SDK provider instance
  │   └─ streamText()                            → SSE: text-delta / reasoning-delta
  │
  └─ appendAssistantReply()
      ├─ INSERT message + variant + trace
      ├─ triggerAutoSummary()                    → fire-and-forget
      └─ getSnapshot()                           → full state for frontend
```

**Pipeline order:** Load entities → load summaries → exclude ranges → resolve lorebooks → activation engine → scripts → assemble prompt → LLM call

Scripts run BEFORE prompt assembly. They can modify `character.personality`, `character.scenario`, and inject messages via `chat.injectMessage()`.

---

## Key Modules

### `packages/domain`

Shared types and constants. **No logic, no imports from other packages.**

- **`entities.ts`** — `Character`, `Chat`, `Message`, `MessageVariant`, `ChatBranch`, `LoreEntry`, `Persona`, `PromptTrace`, `PromptPreset`, `ToolProfile`, `SummaryMemorySnapshot`, `CharacterVersion`, `ChatAutoSummaryConfig`
- **`ids.ts`** — Branded ID types (`Brand<"ChatId">`) to prevent accidental ID swaps at compile time
- **`platform-constants.ts`** — Enum-like constants: `PROVIDER_TYPE`, `CHAT_STATUS`, `MESSAGE_ROLE`, `LORE_LOGIC`, `PROMPT_LAYER_POSITION`, etc.

### `packages/prompt-pipeline`

Pure function. **No I/O, no database.** Given a `PromptAssemblyContext`, returns `PromptAssemblyResult`.

Layers are ordered by position → priority. See [Backend → Prompt Pipeline](docs/architecture/backend.md#prompt-pipeline) for the full priority stack and compaction algorithm.

### `packages/db`

Drizzle ORM schema over SQLite with automatic migration on startup.

- Single schema file (`db-schema.ts`) defining all tables, indexes, and relations
- Store classes (`CharacterStore`, `ChatStore`, `LorebookStore`, `ScriptStore`, etc.) behind a `StoreContainer` facade
- Migration system with baseline, heal, and repair mechanisms for robust schema evolution
- See [DATABASE_MIGRATIONS.md](docs/DATABASE_MIGRATIONS.md) for migration constraints and procedures

### `packages/import-export`

Parses external formats into internal domain types:
- `chara-card-v3.ts` — SillyTavern V2/V3/legacy character cards (PNG + JSON)
- `st-chat.ts` — SillyTavern JSONL chat exports (extracts thinking tags into reasoning variants)
- `st-lorebook.ts` — SillyTavern lorebook exports (maps field name differences)

### `services/api`

The backend. See [Backend Architecture](docs/architecture/backend.md) for:
- Session runtime decomposition
- Lorebook activation engine (pure function)
- Script sandbox (synchronous node:vm)
- AI execution layer (provider mapping, streaming, tokenization)
- Memory system (ranged summaries)
- Mobile access (token auth, TLS, QR code flow)

### `apps/web`

The frontend. See [Frontend Architecture](docs/architecture/frontend.md) for:
- Store architecture (Zustand + Immer + Reselect)
- MessageBlock component (variant system, portal overlay, bottom-pinning)
- Mobile variant carousel (3-panel drag)
- Message list virtualization (react-virtuoso)
- Ghost message prevention
- Build Mode panel registry
- Streaming architecture

---

## Provider Support

| Provider type | SDK | Notes |
|---------------|-----|-------|
| `openai_compat` | `@ai-sdk/openai` (native) | OpenAI, OpenRouter, DeepSeek, Groq, xAI, Mistral, Fireworks, Perplexity, NanoGPT |
| `anthropic` | `@ai-sdk/anthropic` (native) | Claude models |
| `google` | `@ai-sdk/google` (native) | Gemini models |
| `ollama` | `@ai-sdk/openai` (fallback) | Uses `/api/tags` for model list |
| `llamacpp` | `@ai-sdk/openai` (fallback) | Single loaded model only |
| `koboldcpp` | **Unsupported** | Non-OpenAI-compatible API |

---

## Database Conventions

- **IDs:** Prefixed strings (`char_...`, `chat_...`, `msg_...`, `variant_...`, `persona_...`, `lb_...`, `le_...`, `script_...`, `summary_...`)
- **JSON columns:** Stored as text, suffixed `Json` in schema. Parsed on read.
- **Timestamps:** ISO 8601 strings.
- **Deletion:** Cascading where appropriate. `set null` for persona references.
- **Scope FKs:** Lorebooks and scripts use separate nullable FKs (`characterId`, `personaId`, `chatId`) rather than polymorphic associations.

---

## UI/UX Conventions

For detailed UI component guidelines (tooltips, dropdowns, toggles, modals, destructive actions, Russian text considerations), see the [Frontend Architecture → UI/UX Conventions](docs/architecture/frontend.md) section.

Key rules:
- Always use `<CustomTooltip>` (Radix) — never native `title`
- Always use `<DropdownSelect>` (Radix) — never native `<select>`
- Always use `<Toggle>` — never native checkboxes
- Always use `<DestructiveConfirmModal>` before delete operations
- Test Russian locale — words are 20-30% longer than English

---

## Server Entry Points

| Variable | Default | Purpose |
|----------|---------|---------|
| `RP_PLATFORM_ROOT_DIR` | Two levels up from `import.meta.dir` | Project root |
| `RP_PLATFORM_HOST` | `0.0.0.0` | Listen host |
| `RP_PLATFORM_PORT` | `8787` | Listen port |
| `RP_PLATFORM_TLS_KEY` | — | Path to TLS private key |
| `RP_PLATFORM_TLS_CERT` | — | Path to TLS certificate |
| `RP_PLATFORM_OPEN_BROWSER` | `1` | Auto-open browser on startup |

> **Note:** Env vars use the legacy `RP_PLATFORM_` prefix. A rename to `VIBE_TAVERN_` is planned.
