# RP Platform — Architecture

## What is this?

RP Platform is a self-hosted roleplay chat application — a local alternative to SillyTavern and similar tools. It lets you import character cards, chat with AI characters through any LLM provider, and manage prompts, personas, and chat history — all running locally with zero cloud dependency.

**What it does:**

- Import character cards (SillyTavern V2/V3 PNG+JSON), lorebooks, and chat histories
- Chat with AI characters via OpenAI-compatible, Anthropic, Google, Ollama, or llama.cpp endpoints
- Assemble prompts from layered components with priority-based ordering, depth injection, and context-budget-aware compaction
- Resolve macros (`{{char}}`, `{{user}}`, `{{scenario}}`, etc.) — SillyTavern-compatible
- Branch chats from any message, regenerate replies, and maintain multiple response variants (swipes)
- `mesExampleMode` on characters: `always` | `once` | `depth` — controls when example dialogues are included, with optional depth-based injection
- Configure prompt presets (system prompt, jailbreak, summary prompt, tools, author's note, prefill)
- Maintain user personas with name, description, pronouns
- **Lorebook system** — keyword-activated entries with AND/OR/NOT logic, scan depth, recursive scanning, probability, cooldown/delay windows, position injection, group weights, per-entry overrides
- **Script system** — user-written JavaScript executed in a sandboxed VM with `context` object API (chat messages, character data, persistent state). Janitor AI-compatible aliases. Synchronous execution ordered by `sort_order`.
- **AI Script Assistant** — AI-powered script generation/refinement via SSE streaming, separate LLM call reusing provider infrastructure
- **Build Mode** — unified editor panel for character, lorebooks, scripts, and prompt trace inspection
- Record full prompt traces for debugging (which layers activated, token counts, final payload)
- Summarize chat history via AI
- Stream responses with reasoning support (DeepSeek R1 thinking, Claude extended thinking)
- Import thinking tags from SillyTavern chat exports as reasoning variants
- Budget-aware context compaction: reserves tokens for model response, trims history to fit
- **Secure mobile access** — QR code + token auth for LAN/mobile clients, optional TLS

**Stack:** Bun · Hono · Drizzle ORM / SQLite · Vercel AI SDK · Vite / React · TypeScript monorepo

---

## Repository structure

```
rp_platform/
├── apps/web/                    # Frontend SPA (React + Vite)
│   └── src/
│       ├── components/
│       │   ├── editors/         # Build Mode editors (Lorebook, Script, Character)
│       │   ├── modals/          # Modals: MobileAccessModal
│       │   ├── popovers/        # Popovers: TweaksPanel
│       │   └── shared/          # Reusable components (CodeEditor, DropdownSelect, icons)
│       ├── hooks/               # useBuildPanels, use-chat-controller, use-provider-profiles, etc.
│       ├── lib/                 # build-panel-registry, cn, avatar, macros, markdown, sse-parser
│       └── stores/              # Zustand stores + API actions (chat, character, bootstrap, provider)
├── packages/
│   ├── domain/                  # Shared types, branded IDs, constants — zero logic
│   ├── api-contracts/           # Zod schemas for HTTP request validation
│   ├── db/                      # Drizzle ORM schema, SQLite stores, persistence
│   ├── prompt-pipeline/         # Pure prompt assembly function — no I/O, no DB
│   └── import-export/           # Character card and chat import/export (ST formats)
├── services/api/
│   └── src/
│       ├── routes/              # Domain-split route modules (11 files)
│       ├── ai/                  # Provider execution, tokenizer, sampler mapping
│       ├── session-runtime*.ts  # Session coordination sub-runtimes
│       ├── mobile-auth.ts       # Auth middleware + TLS config for mobile access
│       ├── mobile-access-service.ts  # Token management + IP detection
│       ├── standalone-paths.ts  # OS-specific path resolution for .exe distribution
│       ├── prod-server.ts       # Production server entry point
│       ├── standalone-server.ts # Standalone .exe server entry point
│       └── script-ai-prompt.md  # AI script assistant system prompt (loaded at runtime)
├── scripts/                     # Build, dev supervisor, static serving
├── data/                        # Runtime data (SQLite DB, assets, traces)
└── docker-compose.yml + Dockerfile
```

Dependency flow is strictly one-directional. No cycles between packages:

```
services/api
  ├── packages/domain        (types only)
  ├── packages/db            (stores, depends on domain)
  ├── packages/api-contracts (zod schemas, depends on domain)
  ├── packages/prompt-pipeline (depends on domain)
  └── packages/import-export   (depends on domain)

apps/web
  └── services/api  (via HTTP)
```

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (apps/web)  —  React/Vite SPA                  │
│  BuildMode → BuildPanel registry → editors                │
│  Sidebar reads build tabs from registry                   │
└──────────────┬───────────────────────────────────────────┘
               │ HTTP / SSE
┌──────────────▼───────────────────────────────────────────┐
│  routes/ — 11 domain modules, composed via Hono app.route │
│  validates via zod schemas from @rp-platform/api-contracts│
└──────────────┬───────────────────────────────────────────┘
               │ delegates to RuntimeApi interface
┌──────────────▼───────────────────────────────────────────┐
│  RuntimeApiAdapter — thin facade, zero business logic     │
│  resolves active provider, handles asset cleanup          │
└──┬─────┬──────┬───────┬──────┬──────┬──────┬─────────────┘
   │     │      │       │      │      │      │
   ▼     ▼      ▼       ▼      ▼      ▼      ▼
Session  Live   Chat    Provider Prompt Chat  Asset
Runtime  Chat   Summary Profile  Preset Order
         Orch.  Service Service  Service Service
```

---

## Core data flow: sending a message

This is the most important flow in the system. Every other AI generation path (regenerate, continue, summarize) follows the same shape.

```
POST /api/chats/:chatId/messages/stream
  │
  ▼ routes/chat.ts
  RuntimeApiAdapter.sendMessageStream()
  │ resolveActiveProfileOrThrow()
  │
  ▼ LiveChatOrchestrator.sendMessageStream()
  │
  ├─ ChatRuntime.prepareLiveTurn()
  │   ├─ ChatApplicationService.appendUserMessage()      → DB: INSERT message
  │   └─ PromptAssemblyService.assembleForChat()
  │       ├─ StaticPromptResolver: load character, persona, preset from DB
  │       │   ├─ listAllActiveForChat() → load lorebooks + entries
  │       │   ├─ resolveActivatedEntries()                → lore-activation-engine
  │       │   │   ├─ Keyword matching (AND/OR/NOT logic)
  │       │   │   ├─ Scan depth, recursive scanning, probability
  │       │   │   ├─ Cooldown/delay/sticky windows
  │       │   │   └─ Group weights, character filters
  │       │   ├─ executeScripts()                         → script-sandbox
  │       │   │   ├─ Load enabled scripts for chat scope
  │       │   │   ├─ Run in node:vm with 5s timeout
  │       │   │   ├─ Scripts mutate character.personality/scenario
  │       │   │   └─ Scripts read/write persistent state
  │       │   └─ Persist activation state + script state to chat row
  │       ├─ Macro resolution ({{user}}, {{char}}, {{scenario}}, etc.)
  │       └─ assemblePrompt()                            → @rp-platform/prompt-pipeline
  │           ├─ Build layers (preset, character, persona, lore, memory, history)
  │           ├─ Inject activated lore entries at configured positions/depths
  │           ├─ Compact history if context budget exceeded
  │           ├─ Sort by position (before_prompt → in_prompt → in_chat → hidden_system)
  │           ├─ Filter by AssemblyMode (chat / continue / regenerate / summary / tool_call)
  │           └─ Assemble finalPayload.messages[]
  │
  ├─ streamProviderExecutor()
  │   ├─ mapProfileToSdkModel()                          → Vercel AI SDK provider instance
  │   ├─ prepareSdkMessages()                            → split system/conversation, inject prefill
  │   ├─ buildSamplerConfig()                            → temperature, topP, penalties, etc.
  │   └─ streamText()                                    → Vercel AI SDK
  │
  ├─ SSE yield: text-delta / reasoning-delta / finish
  │
  └─ ChatRuntime.appendAssistantReply()
      ├─ ChatStore.addMessage()                          → DB: INSERT assistant message
      ├─ ChatStore.saveTrace()                           → DB: INSERT prompt trace
      └─ SessionRuntime.getSnapshot()                    → full state for frontend
```

**Pipeline order (summary):**

```
Load entities → resolve lorebooks → activation engine → scripts execute → assemble prompt → LLM call
```

Scripts run BEFORE prompt assembly. They can modify `context.character.personality` and `context.character.scenario`, which then flow into the assembled prompt as character data.

---

## Key modules

### `packages/domain`

Shared types and constants. No logic, no imports from other packages.

- **`entities.ts`** — `Character`, `Chat`, `Message`, `MessageVariant`, `ChatBranch`, `LoreEntry`, `Persona`, `PromptTrace`, `PromptPreset`, `ToolProfile`, `SummaryMemorySnapshot`, `RetrievedMemoryHit`, `CharacterVersion`. Characters and personas carry both `avatarAssetId` (cropped thumbnail) and `avatarFullAssetId` (original full-size image for zoom preview).
- **`ids.ts`** — Branded ID types (`Brand<"ChatId">`) to prevent accidental ID swaps
- **`platform-constants.ts`** — Enum-like const objects: `PROVIDER_TYPE`, `CHAT_STATUS`, `MESSAGE_ROLE`, `MESSAGE_STATE`, `LORE_LOGIC`, `PROMPT_LAYER_POSITION`, `CARD_FORMAT`, `SUMMARY_KIND`, `TOOL_PROFILE_MODE`
- **`api-types.ts`** — DTOs for API responses: `AssemblePromptResponse`, `PromptTraceRecordDto`, `PromptPresetDto`, `PromptLayerDto`
- **`provider-profile.ts`** — `StoredProviderProfileRecord` (canonical provider profile type used across all layers)

### `packages/prompt-pipeline`

Pure function that assembles an LLM prompt from structured input. **No I/O, no database access.** Given a `PromptAssemblyContext`, returns a `PromptAssemblyResult`.

**Prompt layers** are the core abstraction. Each layer has:

| Field | Meaning |
|-------|---------|
| `position` | Where it goes: `before_prompt` → `in_prompt` → `in_chat` → `hidden_system` |
| `priority` | Higher number = earlier within the same position (1000 = system prompt, 100 = chat history) |
| `injectionDepth` | For `in_chat` layers: insert N messages from the end of history |
| `modes` | Which `AssemblyMode` this layer is active in (undefined = all modes) |
| `sourceType` | Where it came from: `prompt_preset`, `character`, `persona`, `lore_entry`, `summary_memory`, `retrieval_memory`, `tool_profile`, `chat_history`, `compaction` |

**Layer ordering** (priority, highest first):

```
prompt_preset_system          1000   before all character data
prompt_preset_jailbreak        990
character_system_prompt        950   character's own system prompt
character_base                 900   name + description + scenario
character_personality          890
persona                        850   user persona block
summary_memory                 500   chat summaries
retrieval_memory               400   RAG-like retrieval hits
prompt_preset_summary          350   summary instructions
tool_instructions              300   tool/system prompts
prompt_preset_authors_note     170   injected into chat history at depth
post_history_instructions      160
mes_example                    150   (mode: always | once | depth)
recent_history                 100   actual chat messages (budget-aware compaction)
preflight_compaction            50   metadata about compacted messages
```

Activated lore entries are injected as `lore_entry` source type at their configured position and depth, with their own priority.

**Compaction**: When `contextBudget` is set and history exceeds the budget, older messages are trimmed. The algorithm reserves `responseReserve` tokens (from the provider profile's `maxTokens`) for the model's response, then walks messages from the end, keeping as many as fit within `historyBudget = contextBudget - permanentTokens - responseReserve`. Always keeps at least the last 2 messages. `findSafeCompactionBoundary()` ensures assistant→tool pairs are not split.

**Assembly modes** control which layers are active:

| Mode | Purpose |
|------|---------|
| `chat` | Normal user → assistant turn |
| `continue` | Generate next assistant message without user input |
| `regenerate` | Re-generate a specific assistant message |
| `summary` | Summarize chat history |
| `tool_call` | Tool-use generation |

### `packages/db`

Drizzle ORM schema over SQLite with automatic migration on startup.

**Schema and migrations:**

| File | Role |
|------|------|
| `src/db-schema.ts` | Single file defining all Drizzle tables, indexes, and relations |
| `db-connection.ts` | `createDb()` — opens SQLite, resolves migrations folder, baselines legacy DBs, runs `migrate()` |
| `drizzle.config.ts` | drizzle-kit config (dialect, schema path, migration output, DB path) |
| `drizzle/` | Generated migration SQL files + `meta/_journal.json` |

**Migration flow** (runs on every app startup inside `createDb()`):
1. Open SQLite with WAL mode and foreign keys enabled
2. Resolve migrations folder: env var `RP_PLATFORM_MIGRATIONS_DIR` → exe-relative `drizzle/` → source-tree walk-up
3. `baselineLegacyDb()` — if DB has user tables but no `__drizzle_migrations` tracking table (pre-migration DB), reads `_journal.json`, computes SHA-256 hash of each `.sql` file, and inserts them as already-applied so `migrate()` skips them
4. `migrate()` — apply any unapplied `.sql` files from `drizzle/` in journal order

**Migrations:**

| File | Content |
|------|---------|
| `0000_past_juggernaut.sql` | Initial schema: characters, chats, messages, branches, variants, personas, presets, providers, traces |
| `0001_windy_santa_claus.sql` | Schema refinements |
| `0002_classy_electro.sql` | Schema refinements |
| `0003_bouncy_whizzer.sql` | Trace enrichment: token accounting, activated lore entries, script injections, retrieved memories, latency tracking |
| `0004_trace_enrichment.sql` | Additional trace fields |
| `0005_lorebook_enabled.sql` | `enabled` column on `lorebooks` table |
| `0006_script_ai_prompt.sql` | `script_ai_system_prompt` column on `prompt_presets` table |
| `0007_messages_model_id.sql` | `model_id` column on `message_variants` table |

**Key constraints:**

1. **`when` must be monotonically increasing.** Drizzle's `migrate()` compares `_journal.json`'s `when` field against `__drizzle_migrations.created_at` using `ORDER BY created_at DESC LIMIT 1`. If a new entry's `when` ≤ the last applied migration's `created_at`, the migration is **silently skipped**. Always set `when` to a value larger than all previous entries. Use the pattern: increment by ~5,000,000 from the previous entry.
2. **The `_journal.json` entries must match the `__drizzle_migrations` rows in the DB.** If a migration is in the journal but not in the DB, drizzle applies it. If a migration hash changes (edited SQL file), drizzle will re-apply with potential errors — never edit committed migration files.

**Key tables:**

```
characters ←── chats ──→ personas
  │  (avatarAssetId, avatarFullAssetId → assets)        lorebooks ←── lore_entries
               │                                              │
           chatBranches                                   scripts
               │                                      (same scope FK pattern)
           messages ←── messageVariants
               │
           promptTraces

promptPresets ──→ providerProfiles
                      │
                  cachedModels
                  providerModelFavorites

uiSettings (singleton row)
```

**Lorebook/script scoping** — both `lorebooks` and `scripts` use the same FK pattern:

```
scopeType: "global" | "character" | "persona" | "chat"
characterId: FK → characters (nullable, cascade delete)
personaId:   FK → personas   (nullable, cascade delete)
chatId:      FK → chats      (nullable, cascade delete)
```

Global scope: all three FKs null. Character scope: `characterId` set, etc.

Exposed via **store classes** (`CharacterStore`, `ChatStore`, `PersonaStore`, `PresetStore`, `ProviderStore`, `UiSettingsStore`, `LorebookStore`, `ScriptStore`) behind a `StoreContainer` facade created by `createStoreContainer(dbPath)`.

**File storage** (`packages/db/src/file-store.ts`) — `FileStore` provides structured JSON file I/O under a `data/` root with per-type subfolders:

| Folder | Content |
|--------|----------|
| `characters` | Character card mirrors (not yet fully active — see dual storage proposal) |
| `personas` | Persona data mirrors |
| `promptPresets` | Preset data mirrors |
| `lorebooks` | Lorebook data mirrors |
| `chatMirrors` | Chat transcript exports (JSONL per branch) |
| `assets` | Avatar images |
| `traces` | Prompt trace JSON files |

Currently used for: chat transcript mirrors (`mirrorChatTranscript()`), prompt trace persistence, and asset storage. Character/persona/preset/lorebook folders are defined but not yet wired as primary storage.

### `packages/import-export`

Parses external formats into internal domain types:
- `chara-card-v3.ts` — SillyTavern character cards (V2, V3, and legacy no-spec format). PNG with embedded JSON via tEXt/iTXt chunks, or raw JSON. Accepts `chara_card_v2`, `chara_card_v3`, and spec-less cards with a `name` field.
- `st-chat.ts` — SillyTavern JSONL chat exports. Extracts thinking tags from message content into the `reasoning` field on variants
- `st-lorebook.ts` — SillyTavern lorebook exports. Parses ST format into internal `LoreEntry` shape, mapping field name differences (`groupName`/`group`, `match_whole_words`/`matchWholeWords`, etc.)

### `services/api/`

The backend. Single Bun process serving HTTP API and static frontend.

#### Routing and facade

| File | Role |
|------|------|
| `routes/index.ts` | Composes 11 domain sub-routers via `Hono.app.route()`. Defines `createApiRouter()`. |
| `routes/types.ts` | `RuntimeApi` interface — contract between routes and business logic. |
| `routes/helpers.ts` | Shared utilities (`readOptionalJson`). |
| `routes/debug.ts` | Debug log + bootstrap + defaults endpoints. |
| `routes/chat.ts` | Chat CRUD, messages, branches, summaries, forking, regeneration (streaming + non-streaming). Largest domain (~25 endpoints). |
| `routes/character.ts` | Character CRUD (create, update, delete, duplicate, archive), export. |
| `routes/persona.ts` | Persona CRUD (create, update, delete, duplicate), personal lorebook toggle. |
| `routes/lorebook.ts` | Lorebook CRUD, entry CRUD, test activation, import. |
| `routes/script.ts` | Script CRUD, test, import, AI assistant SSE endpoint. |
| `routes/provider.ts` | Provider CRUD, test, model fetching, favorites. |
| `routes/preset.ts` | Prompt preset CRUD. |
| `routes/settings.ts` | Mobile access settings: status, regenerate token, revoke. |
| `routes/import.ts` | JSON import, SillyTavern directory scan + bulk import. |
| `routes/asset.ts` | Asset upload/serve. |
| `app-factory.ts` | Wires Hono app: CORS, error handling, auth middleware, health check, API routes, SPA static serving. |
| `mobile-auth.ts` | Conditional auth middleware + TLS config resolver. |
| `mobile-access-service.ts` | Token lifecycle (generate/regenerate/revoke), IP detection via UDP + interface scan. |
| `runtime-api-adapter.ts` | Implements `RuntimeApi`. Thin delegation layer — no business logic. Resolves active provider, handles asset cleanup, delegates to `MobileAccessService`. |

### Mobile Access

The platform supports secure access from mobile devices and other LAN clients through token-based authentication with optional TLS encryption.

**Architecture:**

```
┌──────────────────────────────────────────────────────────┐
│  Mobile device / LAN client                              │
│  https://192.168.1.5:8787/#token=<uuid>                 │
└──────────────┬───────────────────────────────────────────┘
               │ HTTP / SSE + { Authorization: Bearer <token> }
               │               or ?token=<uuid> query param
┌──────────────▼───────────────────────────────────────────┐
│  createMobileAuthMiddleware(token)                        │
│  ├─ No token configured → pass-through (no auth)         │
│  ├─ Loopback (127.0.0.1, ::1) → always allowed           │
│  ├─ /api/assets/* → public (img tags can't send headers) │
│  └─ All other /api/* → validate Bearer / ?token=         │
└──────────────┬───────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────┐
│  MobileAccessService                                      │
│  ├─ Token lifecycle: generate / regenerate / revoke       │
│  ├─ Persists token to data/mobile-access.json             │
│  └─ IP detection via UDP + os.networkInterfaces()        │
│       ├─ Primary: UDP socket connect trick (default route)│
│       ├─ Tailscale: 100.x.x.x addresses                  │
│       └─ Fallback: other private IPs (192.168.x.x, etc.) │
└──────────────────────────────────────────────────────────┘
```

**TLS:** When `RP_PLATFORM_TLS_KEY` and `RP_PLATFORM_TLS_CERT` env vars point to valid cert files, the server starts with HTTPS. This enables secure WebSocket/SSE on mobile browsers which block mixed content. Self-signed certs work — the user accepts the warning once.

**QR code flow:**
1. User clicks "Enable Mobile Access" in TweaksPanel
2. Backend generates a UUID token, returns IP + port + token
3. Frontend renders QR code (`qrcode` npm) with `http://IP:PORT/#token=UUID`
4. User scans QR on mobile → browser opens with token in URL hash
5. Frontend reads hash, stores token in localStorage, authenticates all subsequent API calls
6. Token appears in URL only once (hash is not sent to server) — subsequent requests use `Authorization: Bearer` header

**Frontend components:**

| Component | Role |
|-----------|------|
| `MobileAccessModal` | QR code display, URL copy, token show/hide, regenerate/disable buttons, tailscale IP, fallback IPs, firewall warning |
| `TweaksPanel` | "Enable Mobile Access" button → opens `MobileAccessModal` |

**Routes** (`routes/settings.ts`):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/settings/mobile-access` | GET | Get IPs, port, token status, TLS flag |
| `/api/settings/mobile-access/regenerate` | POST | Rotate token (old token invalidated immediately) |
| `/api/settings/mobile-access` | DELETE | Revoke token, disable mobile access |

**Security properties:**
- Token is a UUID v4 — not brute-forceable over LAN
- Token stored in `data/mobile-access.json` (same dir as SQLite DB)
- Loopback always bypasses auth — local dev UX unchanged
- `/api/assets/` is public — `<img>` tags can't send auth headers
- Auth applies only to `/api/*` routes; static frontend files are always public
- Regenerate invalidates old token immediately

#### Session core

| File | Role |
|------|------|
| `session-runtime.ts` | `SessionRuntime` — top-level coordinator. Creates and wires all sub-runtimes via constructor injection + callback functions. |
| `session-runtime-chat.ts` | `ChatRuntime` — live chat orchestration: prepare turn, append reply, manage variants, pending prompt traces. |
| `session-runtime-chat-lifecycle.ts` | `ChatLifecycleRuntime` — create/delete/switch chats, seed opening messages, assemble summary prompts. |
| `session-runtime-character.ts` | `CharacterRuntime` — CRUD characters, archive/unarchive, duplicate, delete, promote system character on first edit. |
| `session-runtime-persona.ts` | `PersonaRuntime` — CRUD personas, duplicate, delete, resolve defaults. |
| `session-runtime-chat-order.ts` | `ChatOrderService` — in-memory ordered list of chat IDs, seeded from DB by `lastAccessedAt`. |
| `session-runtime-lorebook.ts` | Lorebook module — CRUD lorebooks and entries, scope-aware listing, lorebook import. |
| `session-runtime-store.ts` | Store creation and wiring. |
| `session-runtime-presets.ts` | Preset-related session methods. |

#### Lorebook system

| File | Role |
|------|------|
| `lore-activation-engine.ts` | **Pure function** — takes lorebooks with entries + recent messages + activation state → returns activated entries + updated state. No DB access, no side effects. |
| `packages/db/src/stores/lorebook-store.ts` | `LorebookStore` — CRUD for lorebooks and entries. `listAllActiveForChat()` loads all lorebooks matching a chat's scope (global + character + persona + chat), filtered by `enabled`. |
| `prompt-resolver.ts` | `StaticPromptResolver.listActiveLoreEntries()` — orchestrates the full activation flow: load lorebooks → load messages → run activation engine → persist state. |

**Activation engine** (`resolveActivatedEntries()`) evaluates each entry against:

- **Keys** — primary + secondary keyword matching with configurable logic (`AND_ALL`, `AND_ANY`, `NOT_ALL`, `NOT_ANY`)
- **Scan depth** — how many recent messages to scan (per-lorebook, per-entry override)
- **Probability** — random chance check (0–100)
- **Constant entries** — always activate (bypass keyword check)
- **Cooldown/delay/sticky windows** — turn-based timing: `cooldownWindow` prevents re-activation, `delayWindow` skips first N turns, `stickyWindow` keeps activated for N turns
- **Group weights** — entries in the same group compete; `groupWeight` determines selection probability
- **Character filters** — activate only for specific characters (or exclude specific characters)
- **Match sources** — where to look for keys: `scanned_text` (recent messages), `character_description`, `persona_description`
- **Triggers** — what events cause activation: `on_message`, `on_activate`, `on_character_change`
- **Recursion** — entries can activate other entries via `recursiveScanning` on the lorebook
- **Macro resolution** — keys are resolved against `{{user}}`, `{{char}}`, etc. before matching

**Runtime state** — activation state (`LoreActivationState`) is stored as a JSON column on the `chats` table, tracking per-entry activation turn numbers.

#### Script system

| File | Role |
|------|------|
| `script-sandbox.ts` | **Synchronous script execution** in `node:vm` with 5-second timeout. Builds `context` object with Janitor AI-compatible getter aliases. |
| `packages/db/src/stores/script-store.ts` | `ScriptStore` — CRUD for scripts. `listAllEnabledForChat()` loads all enabled scripts matching a chat's scope, sorted by `sort_order`. |
| `prompt-resolver.ts` | `StaticPromptResolver.executeScripts()` — loads scripts, resolves AI model context, delegates to `executeScripts()`. |

**Script execution model:**

1. Load all enabled scripts for the chat scope (global + character + persona + chat)
2. Sort by `sort_order` ascending
3. Execute **synchronously** in a `for...of` loop — NOT `Promise.all()`
4. Each script runs in `node:vm` (`runInNewContext`) with a 5-second timeout
5. Scripts receive a `context` object:
   - `context.chat.messages` — full message array
   - `context.chat.lastMessage` — getter for last message content
   - `context.character.name` — read-only
   - `context.character.personality` — mutable (scripts can `+=` to inject text)
   - `context.character.scenario` — mutable (scripts can `+=` to inject text)
   - `context.lore.activeEntries` — read-only array of activated lore entries
   - `context.state.get(key, default?)` / `set(key, value)` / `increment(key, amount)` — persistent per-script state
   - `context.random()`, `context.randomInt(min, max)`, `context.pick(arr)`, `context.weightedPick(entries)` — utility functions
6. Janitor AI compatibility via getter-based `Object.defineProperty` aliases (e.g. `last_message` → `lastMessage`, `message_count` → `messageCount`)
7. Errors are caught per-script and collected — execution continues to the next script
8. After all scripts run, updated character data flows into prompt assembly

**Runtime state** — script state is stored as a JSON column on the `chats` table, keyed by script ID.

#### AI Script Assistant

| File | Role |
|------|------|
| `script-ai-assistant.ts` | `streamScriptCode()` — SSE streaming generator. Takes a pre-resolved AI model, system prompt, and user request. Yields `{type: "text"}` chunks and `{type: "done"}` or `{type: "error"}`. |
| `routes/script.ts` | `POST /api/scripts/ai-assistant` — resolves provider profile → model, calls `streamScriptCode()`, streams SSE response. |

The AI assistant is a **separate LLM call**, not a prompt layer. It reuses the existing provider infrastructure (any configured provider/model). Key features:

- System prompt loaded at runtime from `script-ai-prompt.md` (version-controlled, editable without recompilation)
- Prompt includes full `context` API reference + coding rules + examples
- Accepts `existingCode` for refinement/modification of current scripts
- Customizable system prompt via `prompt_presets.script_ai_system_prompt` (editable in Prompt Manager) — overrides the default
- Temperature: 0.3, max tokens: 4096

#### Prompt and AI

| File | Role |
|------|------|
| `prompt-assembly-service.ts` | `PromptAssemblyService` — loads context from DB, calls `assemblePrompt()`, returns assembled prompt + trace draft. |
| `prompt-resolver.ts` | `StaticPromptResolver` — reads character/persona/preset/lore from stores. Orchestrates lorebook activation and script execution. |
| `live-chat-orchestrator.ts` | `LiveChatOrchestrator` — coordinates prepare → execute → append for all generation paths (send, generate, regenerate, streaming and non-streaming). Passes `contextBudget` and `responseReserve` from provider profile to prompt assembly. |
| `chat-summary-service.ts` | `ChatSummaryService` — summarize chat via AI, using summary-mode prompt assembly. |

#### AI execution layer (`services/api/src/ai/`)

| File | Role |
|------|------|
| `provider-profile-mapper.ts` | Maps `StoredProviderProfileRecord` → Vercel AI SDK `LanguageModelV1`. Normalizes preset IDs (e.g. "openrouter" → `openai_compat`). Classifies providers as native/fallback/unsupported. |
| `sampler-mapper.ts` | Converts profile sampler settings (temperature, topP, topK, penalties) into AI SDK config. When `customSamplers=false`, only sends basic params. |
| `nonstreaming-provider-executor.ts` | `generateText()` from Vercel AI SDK — single request/response. |
| `stream-provider-executor.ts` | `streamText()` from Vercel AI SDK — async iterable with text-delta and reasoning-delta chunks. Logs and throws on provider stream errors (`type: "error"` chunks). |
| `openai-reasoning-fetch.ts` | Custom fetch wrapper that intercepts SSE streams and rewrites `reasoning_content` fields into regular content with start/end markers, so the AI SDK doesn't silently strip them. |
| `provider-executor-utils.ts` | `toSdkMessages()` — validates messages. `prepareSdkMessages()` — separates system messages from conversation, injects prefill for providers that support it. |
| `provider-capabilities.ts` | Per-provider-type capability flags: streaming, prefill, abort signal support. |
| `provider-execution-types.ts` | Shared types for provider execution (`GenerationResult`, etc.). |
| `builtin-tools.ts` | Built-in tool definitions for tool-use generation. |
| `extract-thinking-tags.ts` | Extracts thinking/reasoning tags from model output. |
| `tokenizer-service.ts` | Token counting: `js-tiktoken` for OpenAI models, `@agnai/web-tokenizers` for Claude/Llama/etc, byte-based fallback. |
| `../tokenizers/` | Pre-built tokenizer vocab files (`claude.json`, `llama3.json`). |

#### Supporting services

| File | Role |
|------|------|
| `provider-gateway.ts` | Pure HTTP functions: probe provider connection, list models, test chat. Supports OpenAI-compat, Anthropic, Google, Ollama. |
| `provider-profile-service.ts` | CRUD provider profiles, cached model lists, favorite models. API key handling (resolve empty string → keep old key). |
| `prompt-preset-service.ts` | CRUD prompt presets. |
| `asset-service.ts` | Upload/serve/cleanup avatar images (jpg, png, gif, webp). Handles both cropped and full-size assets per entity. |
| `provider-orchestrator.ts` | Provider-level coordination logic. |
| `session-runtime-dto.ts` | Mappers: message → DTO (with variants), prompt trace → DTO, provider profile → client-safe (strips apiKey), lore entry activation logic. |
| `st-directory-scanner.ts` | SillyTavern directory bulk import: scans `characters/`, `chats/`, `worlds/` directories, groups files, handles PNG chunk extraction. |
| `errors.ts` | `DomainError` with kind (NotFound/Validation/Conflict/Provider/Cancelled/Unauthorized/Internal) → HTTP status mapping. |
| `send-debug-log.ts` | Append-only debug log to `logs/send-debug.log` with automatic secret redaction. |

---

## Provider support

| Provider type | SDK support | Notes |
|---------------|------------|-------|
| `openai_compat` | Native (`@ai-sdk/openai`) | OpenAI, OpenRouter, DeepSeek, Groq, xAI, Mistral, Fireworks, Perplexity, NanoGPT, and others |
| `anthropic` | Native (`@ai-sdk/anthropic`) | Claude models |
| `google` | Native (`@ai-sdk/google`) | Gemini models |
| `ollama` | OpenAI fallback (`@ai-sdk/openai`) | Uses `/api/tags` for model list |
| `llamacpp` | OpenAI fallback (`@ai-sdk/openai`) | Single loaded model only |
| `koboldcpp` | **Unsupported** | Non-OpenAI-compatible API |

---

## Database conventions

- **IDs:** Prefixed strings (`char_...`, `chat_...`, `msg_...`, `branch_...`, `variant_...`, `persona_...`, `provider_...`, `prompt_preset_...`, `trace_...`, `lb_...` for lorebooks, `le_...` for lore entries, `script_...` for scripts)
- **JSON columns:** Stored as text, suffixed `Json` in schema (e.g. `tagsJson`, `alternateGreetingsJson`, `keysJson`, `scriptStateJson`). Parsed on read.
- **Timestamps:** ISO 8601 strings, not Unix timestamps.
- **Deletion:** Cascading where appropriate (character → chats → messages, lorebook → entries). `set null` for persona references.
- **Message history:** `messageHistoryLimit` on chats (0 = unlimited, all messages passed to pipeline). Pipeline compaction handles actual trimming.
- **Batch queries:** `getVariantsByBranch(branchId)` loads all variants for a branch in a single JOIN query instead of N+1 individual queries.
- **Scope FKs:** Lorebooks and scripts use separate nullable FKs (`characterId`, `personaId`, `chatId`) rather than polymorphic associations. Each scope level is a separate query, unioned.

---

## Prompt trace system

Every AI generation records a **prompt trace** — a full audit of what went into the prompt:

- Which layers were assembled, their source, priority, position, token count
- Which lore entries activated (and why)
- Token accounting (total, per-layer)
- The complete `finalPayload` sent to the provider
- Latency in milliseconds
- Model and preset used

Traces are stored in `promptTraces` table and exported as JSON files under `data/traces/{date}/{traceId}.json`.

---

## Frontend (apps/web)

React SPA built with Vite. Communicates exclusively via the HTTP API defined in `routes/`. Key features:

- Character management (create, edit, import, archive)
- Chat interface with streaming responses and reasoning display
- Branch navigation and message variant selection
- Provider profile configuration and model selection
- Prompt preset editor (chat prompts + service prompts including script AI system prompt)
- Persona management
- **Build Mode** — unified editor panel with dynamic tab registration
- **Lorebook editor** — scope tabs, lorebook accordions, entry editor (Simple + Advanced modes), import wizard, activation tester
- **Script editor** — script list, CodeMirror 6 code editor, AI assistant modal, script templates, API reference
- **Mobile access** — QR code flow, token-based auth, TLS support, IP auto-detection
- Multi-language support (en, ru) via i18n
- Asset upload for character avatars (cropped thumbnail + original full-size)
- Avatar crop modal (react-easy-crop library, circular crop, zoom, pan-to-crop)
- Avatar panel (floating draggable, zoomable full-size avatar preview)
- Context usage display: permanent vs temporary token breakdown from assembled prompt layers
- Build mode: field-based token counting for character cards (no dependency on sending messages)

### BuildPanel registry

Dynamic tab registration system for Build Mode. Allows new panels to be added without modifying `BuildMode.tsx` or `Sidebar.tsx`.

**Files:**

| File | Role |
|------|------|
| `lib/build-panel-registry.ts` | `registerBuildPanel(descriptor)` — registers a panel. `getBuildPanels()` / `subscribeBuildPanels()` for reactive reads. |
| `hooks/use-build-panels.ts` | `useBuildPanels()` — React hook using `useSyncExternalStore`. |
| `lib/register-core-panels.tsx` | Registers core panels: character, lorebook, trace. Auto-imported from `main.tsx`. |

**Panel descriptor:**

```ts
interface BuildPanelDescriptor {
  id: string;           // unique tab id
  icon: ReactNode;      // icon component
  labelKey: string;     // i18n key for sidebar label
  fullBleed?: boolean;  // no padding, no max-width (used by lorebook/scripts)
  render: (ctx: BuildPanelContext) => ReactNode;
}
```

`BuildMode.tsx` reads panels from the registry via `useBuildPanels()` and renders the active panel. `Sidebar.tsx` reads the same registry for both collapsed (icon-only) and expanded (icon + label) navigation. Character and trace panels are special-cased in `BuildMode` for their form/trace logic; all other panels use the generic `render()` path.

### Editors (`components/editors/`)

| File | Role |
|------|------|
| `LorebookEditor.tsx` | World & Logic panel. Scope column (vertical icons) → lorebook list (accordions) → entry list → entry editor. Two modes: Simple (keys + content + test) and Advanced (all ST fields). Full-bleed layout. |
| `ScriptEditor.tsx` | Exports `useScriptPanel()` hook (not a component!). Returns `{ scriptListContent, scriptEditorPanel, modals, ... }`. Embedded inside LorebookEditor as a co-equal tab. |
| `CharacterForm.tsx` | Character editing form with avatar upload, all character fields. Centered layout with `max-w-4xl`. |
| `scriptTemplates.ts` | 7 RP-relevant script templates: relationship progression, scenario events, memory tracking, dynamic lorebook, advanced lorebook, HP tracker, random event. Inserted into current script or create new. |

### Lorebook + Script embedding pattern

**Important architectural detail:** Scripts are NOT a separate build panel. The `useScriptPanel()` hook from `ScriptEditor.tsx` is called inside `LorebookEditor.tsx`, which renders both lorebooks and scripts as tabs within a single full-bleed panel:

```
LorebookEditor
├── Scope selector (character / persona / chat)
├── Tab bar: [Lorebooks] [Scripts]
├── Tab content:
│   ├── "lorebooks" → lorebook accordion list → entry list → entry editor
│   └── "scripts" → useScriptPanel().scriptListContent / scriptEditorPanel
└── Modals from both systems
```

This means:
- `ScriptEditor.tsx` exports a **hook** (`useScriptPanel`), not a component
- The hook manages its own state (active script, test input, AI helper, import, etc.) and returns JSX fragments
- `LorebookEditor.tsx` wires up navigation (`setView`) and coordinates the two systems
- Script list cards are rendered in `ScriptEditor.tsx` → `scriptListContent`
- Script code editor is rendered in `ScriptEditor.tsx` → `scriptEditorPanel`

### Shared components (`components/shared/`)

| File | Role |
|------|------|
| `Modal.tsx` | Radix Dialog wrapper. Provides focus trap, scroll lock, Escape-to-close, overlay click dismiss. All modals in the app use this. Exports `getModalPortal()` for nested Radix components. |
| `CodeEditor.tsx` | React wrapper around CodeMirror 6. JS syntax highlighting, custom dark theme using CSS vars + oklch, line numbers, bracket matching. `value`/`onChange` props. |
| `DropdownSelect.tsx` | @radix-ui/react-select wrapper with search filter, default option, disabled state. Keyboard navigation (arrow keys, Enter, Escape). Portals into Modal focus scope when inside a Dialog. |
| `AvatarCropModal.tsx` | react-easy-crop circular crop tool. Outputs 480×480 PNG. Uses shared `<Modal>` wrapper. |
| `AutoTextarea.tsx` | Auto-resizing textarea. Finds scroll parent, adjusts height on input/change, respects `maxHeight`. Used in chat input, persona editor, prompt fields. |
| `icons.tsx` | All UI icons as React components (`Icons.*` system — no emojis). |
| `Tooltip.tsx` | Custom tooltip component |
| `TokenCounter.tsx` | Token count badge display |
| `SaveBar.tsx` | Sticky save bar with unsaved changes indicator |
| `save-btn.tsx` | Save button component |
| `Toggle.tsx` | Toggle switch component |
| `confirm-close-modal.tsx` | Small "discard changes?" confirm dialog. Uses shared `<Modal>` with `z-[700]`. |
| `destructive-confirm-modal.tsx` | Destructive action confirm dialog (e.g., delete lorebook). Uses shared `<Modal>` with `z-[700]`. |
| `empty-state.tsx` | Empty state placeholder component |

### Frontend data architecture

The frontend uses **Zustand as single source of truth**. React Query was fully removed — it caused dual-state sync bugs (React Query cache + Zustand store fighting over re-render timing, especially with framer-motion animations).

**Data stores (Zustand):**

| Store | Location | Content |
|-------|----------|---------|
| `useChatDataStore` | `stores/chat-data-store.ts` | Messages by ID, message order, chat meta (character, persona, branches, chats list), macro context, prompt trace/history, context preview |
| `useBootstrapStore` | `stores/api-actions/bootstrap-actions.ts` | Bootstrap data (allCharacters, promptPresets), personas, loading state |
| `useProviderDataStore` | `stores/provider-data-store.ts` | Provider profiles, favorites by profile |
| `useChatStore` | `stores/chat-store.ts` | UI state — active chat ID, editing, draft, streaming text/reasoning, pending user message, sending state |
| `useCharacterStore` | `stores/character-store.ts` | Character list for sidebar, confirm-destroy dialog state |
| `useNavigationStore` | `stores/navigation-store.ts` | Theme, sidebar width |
| `useProviderStore` | `stores/provider-store.ts` | Connection UI state, generation status |
| `useModalStore` | `stores/modal-store.ts` | Modal open/close state |

**API actions** (`stores/api-actions/`) are plain async functions that call the API, then call `syncSnapshot()` or targeted store updates. No try/catch inside actions — errors propagate to callers. Actions write to Zustand directly.

**Action modules:** `bootstrap-actions.ts` (initial load), `character-actions.ts`, `chat-actions.ts`, `persona-actions.ts`, `preset-actions.ts`, `provider-actions.ts`.

**Memoized selectors** (`stores/chat-selectors.ts`) use `reselect` for lazy derived data:

- `useDisplayMessage(id)` — resolves macros + counts tokens for a single message. Cache hit when content unchanged.
- `useMessageOrder()` — ordered message ID list from store.
- `useMacroContext()` — character name + persona name/description for macro resolution.
- `useActiveTrace(selectedTraceId)` — active prompt trace from trace history.

Each component subscribes to the minimal slice it needs — e.g. `MessageBlock` only subscribes to `useDisplayMessage(id)`, so switching a variant or streaming only re-renders the affected block.

### Message list virtualization

The message list uses `react-virtuoso` — purpose-built for chat UIs with reverse list support, dynamic height, and auto-follow:

- `<Virtuoso>` component with `followOutput="smooth"` — auto-scrolls when new messages arrive
- `initialTopMostItemIndex` — starts scrolled to bottom on load
- `overscan={5}` for smooth scrolling
- Dynamic height measurement built-in (no manual `measureElement`)
- Virtuoso `Footer` component renders `StreamingContent` (pending user message + streaming assistant reply)

### Variant swipe animation

Message variant switching (swipes) uses `framer-motion`:

- `AnimatePresence mode="popLayout"` — exiting element becomes `position: absolute` (no height collapse), entering element occupies space immediately. Both animate simultaneously.
- `motion.div key={selectedVariantIndex}` — direction-aware slide (left/right) + blur transition
- No `motion.div layout` wrapper — layout animations conflict with Virtuoso's measurement
- Variant content read from `variants[selectedVariantIndex].content` (not `message.content`) — server sets `message.content` to selected variant at load time, but client-side switching only changes `selectedVariantIndex`
- Swipe callbacks read `selectedVariantIndex` directly from store via `useChatDataStore.getState()` — avoids stale closure from memoized `itemContent`

`MessageBlock` is wrapped in `React.memo` and reads all message data from `useDisplayMessage(messageId)` — no message object prop. This ensures streaming text only re-renders the `StreamingContent` component, not existing message blocks.

---

## Server entry points

The platform has two server entry points for different deployment scenarios.

### `prod-server.ts` — Development / Docker / direct Bun

Standard production server. Serves the built frontend from `apps/web/dist/` plus the API from a single Bun process on a single port.

**Usage:** `bun services/api/src/prod-server.ts`

**Paths:** Resolved relative to the source tree:
- Data: `data/` in project root
- Frontend: `apps/web/dist/` (must be built first: `bun run build:web`)

**Config:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `RP_PLATFORM_ROOT_DIR` | Two levels up from `import.meta.dir` | Project root |
| `RP_PLATFORM_HOST` | `0.0.0.0` | Listen host (all interfaces for mobile access) |
| `RP_PLATFORM_PORT` | `8787` | Listen port |
| `RP_PLATFORM_OPEN_BROWSER` | `1` | Auto-open browser on startup |

### `standalone-server.ts` — Compiled .exe (Claw Tavern)

Target for `bun build --compile`. Uses OS-specific data directories instead of project-relative paths.

**Usage:** `claw-tavern.exe` (compiled) or `bun services/api/src/standalone-server.ts`

**Paths** (resolved by `standalone-paths.ts`):

| OS | Data directory |
|----|---------------|
| Windows | `%LOCALAPPDATA%\ClawTavern` |
| macOS | `~/Library/Application Support/ClawTavern` |
| Linux | `~/.local/share/claw-tavern` |

Override with `RP_PLATFORM_DATA_DIR` and `RP_PLATFORM_WEB_DIR` env vars.

The standalone server looks for `web/` directory next to the executable for frontend static files; falls back to the source tree `apps/web/dist/`.

**Both entry points** share the same bootstrap sequence:
1. Create/store initialization (`createRuntimeStore`)
2. Seed data (system character, default persona, default preset, UI settings defaults)
3. Tokenizer warmup + registration with prompt pipeline
4. Service construction (provider profiles, presets, session runtime, orchestrators, mobile access)
5. Hono app creation with auth middleware
6. Bun.serve with optional TLS
7. Graceful shutdown on SIGINT/SIGTERM

---

## Bun-native migration

The project targets a standalone `bun build --compile` executable. To minimize Node.js dependency and maximize Bun-native API usage, a systematic migration was performed.

### Completed migrations

| Before | After | Scope |
|--------|-------|-------|
| `readFileSync` / `writeFileSync` | `Bun.file().text()` / `Bun.write()` | `file-store.ts`, `db-connection.ts`, `tokenizer-service.ts`, `app-factory.ts`, tests |
| `existsSync` | `Bun.file().exists()` | `db-connection.ts`, `app-factory.ts`, `standalone-paths.ts` |
| `appendFileSync` | `Bun.write` with append | `send-debug-log.ts` |
| `mkdirSync` | `mkdir` from `node:fs/promises` | All server entry points, scripts, debug log |
| `cpSync` / `rmSync` | `cp` / `rm` from `node:fs/promises` | `build-standalone.ts` |
| `node:crypto` `createHash('sha1')` / `createHash('sha256')` | `new Bun.CryptoHasher('sha1')` / `Bun.CryptoHasher('sha256')` | `shared.ts`, `file-store.ts` |
| `Buffer.from` | `Uint8Array` / `TextEncoder` | `file-store.ts`, `asset-service.ts`, route files |
| `require('bun:sqlite')` | `import` from `'bun:sqlite'` | `repair-thinking-tags.ts` |
| Bare `'path'` / `'fs'` imports | `'node:path'` / `'node:fs/promises'` | All files |
| `__dirname` / `__filename` | `import.meta.dir` / `import.meta.file` | `tokenizer-service.ts` |

### Remaining `node:fs/promises` usage (intentional)

Bun recommends `node:fs/promises` for directory operations that don't have `Bun.file` equivalents:

- `mkdir` — create directories (used in 11 locations: servers, scripts, debug log, import-export)
- `rename` — atomic file write in `file-store.ts` (write to temp → rename)
- `cp` / `rm` — build scripts
- `readdir` / `stat` — build scripts

These have no Bun-native replacement and are the recommended approach per Bun docs.

### Async propagation

Several core functions became async as a result of migrating to `Bun.file()` (which returns promises). This cascaded to:

- `createDb()` → `createStoreContainer()` → `createRuntimeStore()` → all server entry points
- `createApp()` (reads static files for SPA serving)
- `resolveStandalonePaths()`

All callers were updated to `await` these functions.

---

## Streaming regeneration

Message regeneration handles streaming differently from normal message sending:

- **Problem:** Previously, `isBusy` was derived from the global `isSending` flag, causing all assistant messages to show a loading state during regeneration. Streaming text was appended after the old message content.
- **Solution:** `MessageBlock` now checks `messageActionId === messageId` to determine if it's the specific target of a regeneration action. When active, the block replaces its content with the live streaming text + reasoning instead of appending a separate `StreamingContent` block.

This ensures:
1. Only the message being regenerated shows streaming state
2. The old message content is visually replaced, not duplicated
3. Reasoning (thinking) is displayed inline during regeneration

---

## Import pipeline

The platform imports data from three sources: individual files (PNG/JSON cards, JSONL chats), SillyTavern directory bulk import, and converted Janitor AI exports.

### Character card import

`packages/import-export/src/cards/chara-card-v3.ts` — `importCharacterCardV3Json()` accepts three card formats:

| Format | Detection | Notes |
|--------|-----------|-------|
| V3 (`spec: "chara_card_v3"`) | Explicit spec field | Full support: alternate greetings, extensions, tags, character_book, depth prompts |
| V2 (`spec: "chara_card_v2"`) | Explicit spec field | Same fields as V3, fewer optional fields |
| Legacy (no spec) | Has `name` field but no `spec` | Treated as V2-equivalent |

PNG cards embed JSON in `tEXt`/`iTXt` chunks with keyword `chara` (V2) or `ccv3` (V3). The frontend `png-reader.ts` extracts these chunks, tries base64→UTF-8 decoding first (standard SillyTavern encoding), then falls back to raw JSON.

**Import flow:** `session-runtime-import-export.ts` → `importJson()`:
1. Parse JSON → detect format (character card / JSONL chat / lorebook)
2. Upsert character via `CharacterStore.update()` if exists, `create()` if new
3. When `skipExisting: true`: character data is updated but no new chat is created; returns existing chat so avatars can still be mapped
4. Create a new chat for the character (or return existing if skipped)
5. Return `ImportResult` with `activeChatId`, `snapshot`, and `imported` metadata

### Lorebook import

`POST /api/lorebooks/:lorebookId/import` — accepts SillyTavern lorebook JSON. Two modes:

- **Existing lorebook** (`lorebookId` is a real ID) — imports entries into the specified lorebook
- **Create new** (`lorebookId = "new"`) — creates a new lorebook with imported entries

The importer (`st-lorebook.ts`) maps ST-specific field names to internal names, handles missing optional fields, and creates entries with proper defaults.

### SillyTavern directory bulk import

`StFolderImport` component in `ImportModals.tsx`:

1. **Folder picker** — `<input webkitdirectory>` opens native OS dialog, returns `File[]` with `webkitRelativePath` (e.g. `default-user/characters/Alice.png`)
2. **Scan** — groups files by directory: `characters/` → PNG with `chara`/`ccv3` chunk or JSON, `chats/` → JSONL, `worlds/` → JSON lorebooks. PNG files without character metadata (plain avatar images) are filtered out during scanning.
3. **Import** — two phases:
   - Phase 1: Import each character via `importJson({ skipExisting: true })`. For PNG files, also upload the PNG as avatar via `uploadAsset()` + `updateCharacterAvatar()`. Build a `nameToChatId` map for chat matching.
   - Phase 2: Import each chat via `importJson({ chatId })`, matching chats to characters by folder name.
4. **Error reporting** — per-file errors collected as `{ fileName, reason }[]`, displayed in a collapsible `<details>` list after import.

### Janitor AI conversion (external tool)

`janitor-chat-convert.html` — standalone HTML file (not part of the app) that converts Janitor AI chat dumps to SillyTavern JSONL format. Includes browser console scripts that use Supabase auth cookies to download chats, characters, and chat lists directly from Janitor's API. The converter handles:

- Reversed message order (Janitor returns newest first)
- Swipe grouping (consecutive `is_bot: true` messages become variants; `is_main: true` marks the selected swipe)
- Two input formats: raw message array (from Network tab) and full chat object `{ character, chat, chatMessages, personas }` (from console script)
- Character data extraction: converts Janitor character objects to `chara_card_v3` JSON format for import
