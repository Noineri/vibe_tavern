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
- Record full prompt traces for debugging (which layers activated, token counts, final payload)
- Summarize chat history via AI
- Stream responses with reasoning support (DeepSeek R1 thinking, Claude extended thinking)
- Import thinking tags from SillyTavern chat exports as reasoning variants
- Budget-aware context compaction: reserves tokens for model response, trims history to fit

**Stack:** Bun · Hono · Drizzle ORM / SQLite · Vercel AI SDK · Vite / React · TypeScript monorepo

---

## Repository structure

```
rp_platform/
├── apps/web/                    # Frontend SPA (React + Vite)
├── packages/
│   ├── domain/                  # Shared types, branded IDs, constants — zero logic
│   ├── api-contracts/           # Zod schemas for HTTP request validation
│   ├── db/                      # Drizzle ORM schema, SQLite stores, persistence
│   ├── prompt-pipeline/         # Pure prompt assembly function — no I/O, no DB
│   └── import-export/           # Character card and chat import/export (ST formats)
├── services/api/                # Backend service (Hono server + business logic)
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
└──────────────┬───────────────────────────────────────────┘
               │ HTTP / SSE
┌──────────────▼───────────────────────────────────────────┐
│  routes.ts — Hono router, ~80 endpoints                  │
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
  ▼ routes.ts
  RuntimeApiAdapter.sendMessageStream()
  │ resolveActiveProfileOrThrow()
  │
  ▼ LiveChatOrchestrator.sendMessageStream()
  │
  ├─ ChatRuntime.prepareLiveTurn()
  │   ├─ ChatApplicationService.appendUserMessage()      → DB: INSERT message
  │   └─ PromptAssemblyService.assembleForChat()
  │       ├─ StaticPromptResolver: load character, persona, preset from DB
  │       ├─ Macro resolution ({{user}}, {{char}}, {{scenario}}, etc.)
  │       └─ assemblePrompt()                            → @rp-platform/prompt-pipeline
  │           ├─ Build layers (preset, character, persona, lore, memory, history)
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

Drizzle ORM schema over SQLite. Key tables:

```
characters ←── chats ──→ personas
  │  (avatarAssetId, avatarFullAssetId → assets)
                 │
             chatBranches
                 │
             messages ←── messageVariants
                 │
             promptTraces

promptPresets ──→ providerProfiles
                      │
                  cachedModels
                  providerModelFavorites

uiSettings (singleton row)
```

Exposed via **store classes** (`CharacterStore`, `ChatStore`, `PersonaStore`, `PresetStore`, `ProviderStore`) behind a `StoreContainer` facade.

### `packages/import-export`

Parses external formats into internal domain types:
- `chara-card-v3.ts` — SillyTavern character cards (PNG with embedded JSON via tEXt chunks)
- `st-chat.ts` — SillyTavern JSONL chat exports. Extracts thinking tags from message content into the `reasoning` field on variants
- `st-lorebook.ts` — SillyTavern lorebook exports

### `services/api/`

The backend. Single Bun process serving HTTP API and static frontend.

#### Routing and facade

| File | Role |
|------|------|
| `routes.ts` | Hono router with ~80 endpoints. Defines `RuntimeApi` interface. |
| `app-factory.ts` | Wires Hono app: CORS, error handling, health check, API routes, SPA static serving. |
| `runtime-api-adapter.ts` | Implements `RuntimeApi`. Thin delegation layer — no business logic. Resolves active provider, handles asset cleanup. |

#### Session core

| File | Role |
|------|------|
| `session-runtime.ts` | `SessionRuntime` — top-level coordinator. Creates and wires all sub-runtimes via constructor injection + callback functions. |
| `session-runtime-chat.ts` | `ChatRuntime` — live chat orchestration: prepare turn, append reply, manage variants, pending prompt traces. |
| `session-runtime-chat-lifecycle.ts` | `ChatLifecycleRuntime` — create/delete/switch chats, seed opening messages, assemble summary prompts. |
| `session-runtime-character.ts` | `CharacterRuntime` — CRUD characters, archive/unarchive, promote system character on first edit. |
| `session-runtime-persona.ts` | `PersonaRuntime` — CRUD personas, resolve defaults. |
| `session-runtime-chat-order.ts` | `ChatOrderService` — in-memory ordered list of chat IDs, seeded from DB by `lastAccessedAt`. |

#### Prompt and AI

| File | Role |
|------|------|
| `prompt-assembly-service.ts` | `PromptAssemblyService` — loads context from DB, calls `assemblePrompt()`, returns assembled prompt + trace draft. |
| `prompt-resolver.ts` | `StaticPromptResolver` — reads character/persona/preset/lore from stores. (Phase 1: lore and memory return empty.) |
| `live-chat-orchestrator.ts` | `LiveChatOrchestrator` — coordinates prepare → execute → append for all generation paths (send, generate, regenerate, streaming and non-streaming). |
| `chat-summary-service.ts` | `ChatSummaryService` — summarize chat via AI, using summary-mode prompt assembly. |

#### AI execution layer (`services/api/src/ai/`)

| File | Role |
|------|------|
| `provider-profile-mapper.ts` | Maps `StoredProviderProfileRecord` → Vercel AI SDK `LanguageModelV1`. Normalizes preset IDs (e.g. "openrouter" → `openai_compat`). Classifies providers as native/fallback/unsupported. |
| `sampler-mapper.ts` | Converts profile sampler settings (temperature, topP, topK, penalties) into AI SDK config. When `customSamplers=false`, only sends basic params. |
| `nonstreaming-provider-executor.ts` | `generateText()` from Vercel AI SDK — single request/response. |
| `stream-provider-executor.ts` | `streamText()` from Vercel AI SDK — async iterable with text-delta and reasoning-delta chunks. |
| `openai-reasoning-fetch.ts` | Custom fetch wrapper that intercepts SSE streams and rewrites `reasoning_content` fields into regular content with start/end markers, so the AI SDK doesn't silently strip them. |
| `provider-executor-utils.ts` | `toSdkMessages()` — validates messages. `prepareSdkMessages()` — separates system messages from conversation, injects prefill for providers that support it. |
| `provider-capabilities.ts` | Per-provider-type capability flags: streaming, prefill, abort signal support. |
| `tokenizer-service.ts` | Token counting: `js-tiktoken` for OpenAI models, `@agnai/web-tokenizers` for Claude/Llama/etc, byte-based fallback. |

#### Supporting services

| File | Role |
|------|------|
| `provider-gateway.ts` | Pure HTTP functions: probe provider connection, list models, test chat. Supports OpenAI-compat, Anthropic, Google, Ollama. |
| `provider-profile-service.ts` | CRUD provider profiles, cached model lists, favorite models. API key handling (resolve empty string → keep old key). |
| `prompt-preset-service.ts` | CRUD prompt presets. |
| `asset-service.ts` | Upload/serve/cleanup avatar images (jpg, png, gif, webp). Handles both cropped and full-size assets per entity. |
| `session-runtime-dto.ts` | Mappers: message → DTO (with variants), prompt trace → DTO, provider profile → client-safe (strips apiKey), lore entry activation logic. |
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

- **IDs:** Prefixed strings (`char_...`, `chat_...`, `msg_...`, `branch_...`, `variant_...`, `persona_...`, `provider_...`, `prompt_preset_...`, `trace_...`)
- **JSON columns:** Stored as text, suffixed `Json` in schema (e.g. `tagsJson`, `alternateGreetingsJson`). Parsed on read.
- **Timestamps:** ISO 8601 strings, not Unix timestamps.
- **Deletion:** Cascading where appropriate (character → chats → messages). `set null` for persona references.
- **Message history:** `messageHistoryLimit` on chats (0 = unlimited, all messages passed to pipeline). Pipeline compaction handles actual trimming.
- **Batch queries:** `getVariantsByBranch(branchId)` loads all variants for a branch in a single JOIN query instead of N+1 individual queries.

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

React SPA built with Vite. Communicates exclusively via the HTTP API defined in `routes.ts`. Key features:

- Character management (create, edit, import, archive)
- Chat interface with streaming responses and reasoning display
- Branch navigation and message variant selection
- Provider profile configuration and model selection
- Prompt preset editor
- Persona management
- Multi-language support (en, ru) via i18n
- Asset upload for character avatars (cropped thumbnail + original full-size)
- Avatar crop modal (canvas-based circular crop with zoom slider and scroll-to-zoom)
- Avatar panel (floating draggable, zoomable full-size avatar preview)
- Context usage display: permanent vs temporary token breakdown from assembled prompt layers
- Build mode: field-based token counting for character cards (no dependency on sending messages)

Built as static assets served by the same Hono server in production.
