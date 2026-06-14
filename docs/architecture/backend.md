# Backend Architecture

> **services/api** — Single Bun process serving HTTP API and static frontend. No microservices, no queues.

---

## Entry Points

Two server entry points for different deployment scenarios:

| Entry Point | Use Case | Data Paths |
|-------------|----------|------------|
| `server/prod-server.ts` → `out/services/api/prod-server.js` | Dev, Docker, production bundle | `data/` relative to project root, `out/apps/web/` for frontend |
| `server/standalone-server.ts` → `out/standalone/vibe-tavern.exe` | Compiled `.exe` | OS-specific (`%LOCALAPPDATA%\VibeTavern`, `~/Library/Application Support/VibeTavern`, `~/.local/share/vibe-tavern`) |

Both entry points delegate to `server-runtime.ts:startServerRuntime()`, which uses a **two-phase bind-first bootstrap** so the port is reachable within milliseconds of launch:

**Phase 1 — Immediate port bind** (milliseconds):
1. Port availability check (if `checkPortBeforeListen`)
2. Pre-load Alegreya font for the loading placeholder (from `staticDir/fonts/` or `apps/web/public/fonts/`)
3. `Bun.serve()` binds the port with a **loading placeholder handler** (`loading-placeholder.ts`) — returns branded loading HTML for browser routes, 503 JSON for `/health` and `/api/*`
4. Browser opens, SIGINT/SIGTERM handlers registered

**Phase 2 — Background initialization** (~2–7s, port already bound):
5. `runStartupFileChecks()` — verify runtime files exist (DB, migrations, tokenizers, prompt, web bundle)
6. `createRuntimeStore()` → `createStoreContainer()` → `createDb()` (SQLite + migrations)
7. Seed data (system character, default persona, default preset, UI settings)
8. Tokenizer warmup + registration with prompt pipeline
9. Service construction (providers, presets, session runtime, orchestrators, mobile access)
10. Hono app creation with auth middleware (`createApp()`)
11. **Handler swap** — the mutable `fetchHandler` closure is reassigned from the loading placeholder to `app.fetch`; all subsequent requests hit the real Hono app

**On init failure:** handler is swapped to a static 500 error page so the user sees "Vibe Tavern failed to start" in their browser instead of an infinite loading spinner. The process stays alive for Ctrl+C.

**Why bind-first:** the user's browser gets a branded loading page instead of "connection refused" during the init window. The loading page auto-polls `/health` (503 → 200) and reloads into the real SPA when the server is ready.

**Why single process:** Local-first single-user app. No horizontal scaling needed. One process = zero deployment complexity, zero network hops between API and DB.

---

## Routing Layer

### Routes

12 domain route modules under `api/routes/`, composed via `Hono.app.route()`, plus shared `api/routes/types.ts` (contracts) and `api/routes/helpers.ts` (utilities):

| File | Domain | Endpoints |
|------|--------|----------|
| `api/routes/chat.ts` | Chat CRUD, messages, branches, summaries, streaming, variants, fork | ~47 (largest) |
| `api/routes/lorebook.ts` | Lorebook CRUD, entry CRUD, test activation, import, links, duplicate, export | ~19 |
| `api/routes/provider.ts` | Provider CRUD, test, test-chat, model fetching, favorites | ~17 |
| `api/routes/persona.ts` | Persona CRUD, duplicate, lorebook toggle | ~10 |
| `api/routes/character.ts` | Character CRUD, archive, duplicate, export | ~9 |
| `api/routes/script.ts` | Script CRUD, test, import, AI assistant SSE | ~9 |
| `api/routes/settings.ts` | UI settings CRUD, mobile access: status, regenerate/revoke token | ~7 |
| `api/routes/preset.ts` | Prompt preset CRUD | ~5 |
| `api/routes/import.ts` | JSON import, ST directory scan + bulk import | ~3 |
| `api/routes/debug.ts` | Debug log, bootstrap, defaults | ~3 |
| `api/routes/asset.ts` | Asset upload/serve | 2 |
| `api/routes/types.ts` | `RuntimeApi` interface — contract between routes and adapters |
| `api/routes/helpers.ts` | `readOptionalJson` — shared utility for routes with optional bodies |

### RuntimeApi Interface

`api/routes/types.ts` defines `RuntimeApi` — the contract between routes and business logic. `RuntimeApiAdapter` (`api/adapters/runtime-api-adapter.ts`) implements it as a **pure composite with zero business logic**: it wires the sub-adapters in `api/adapters/` (one per domain) and delegates every method to the appropriate adapter. Each adapter (`ChatAdapter`, `CharacterAdapter`, `LorebookAdapter`, etc.) is focused on its own domain.

**Why an interface:** Routes are HTTP concern. Business logic lives in sub-runtimes and adapters. The adapter prevents routes from depending on runtime internals. Also enables testing routes with a mock adapter.

---

## Session Runtime Decomposition

`SessionRuntime` (`runtime/session/session-runtime.ts`) is the top-level coordinator. It creates and wires all sub-runtimes via constructor injection. The runtime is split across focused files in `runtime/session/`:

```
runtime/session/
├── session-runtime.ts            SessionRuntime (coordinator)
├── session-runtime-chat.ts       ChatRuntime (live chat: prepare turn, append reply, manage variants)
├── session-runtime-chat-lifecycle.ts  ChatLifecycleRuntime (create/delete/switch chats, seed openings)
├── session-runtime-chat-order.ts ChatOrderService (in-memory ordered list by lastAccessedAt)
├── session-runtime-store.ts      StoreContainer (all DB stores behind a facade)
├── session-runtime-presets.ts    preset/prompt wiring
├── session-runtime-import-export.ts  import/export
└── session-runtime-dto.ts        snapshot/DTO builders
```

Domain sub-runtimes live with their own domain:

```
domain/character/character-runtime.ts   CharacterRuntime (CRUD characters, archive, duplicate, promote system char)
domain/persona/persona-runtime.ts       PersonaRuntime (CRUD personas, resolve defaults)
domain/prompt/prompt-assembly-service.ts  PromptAssemblyService (loads context from DB, calls assemblePrompt())
domain/prompt/prompt-resolver.ts        StaticPromptResolver (resolves character, persona, lore entries from DB)
```

SessionRuntime also exposes direct methods for prompt trace history, bootstrap, and `getSnapshot()`.

**Note:** Lorebook CRUD, scripts, provider profiles, presets, assets, AI assistant, and settings are **not** in SessionRuntime. They are handled by dedicated adapters that work directly with stores:
- `LorebookAdapter` → `StoreContainer.lorebooks`
- `ScriptAdapter` → `StoreContainer.scripts`
- `ProviderAdapter` → `ProviderProfileService`
- `PresetAdapter` → `PromptPresetService`
- `AssetAdapter` → `AssetService`
- `SettingsAdapter` → `StoreContainer.uiSettings`
- `MobileAccessAdapter` → `MobileAccessService`

**Why decomposition (not one god class):** Each sub-runtime owns a clear domain boundary. Dependencies flow one way — `ChatRuntime` uses `StoreContainer` but doesn't know about `PersonaRuntime`. The top-level `SessionRuntime` wires them together.

---

## Core Data Flow: Sending a Message

The most important flow in the system. Every AI generation path (send, regenerate, continue, summarize) follows this shape:

```
POST /api/chats/:chatId/messages/stream
  │
  ▼ RuntimeApiAdapter.sendMessageStream()
  │ resolveActiveProfileOrThrow()
  │
  ▼ LiveChatOrchestrator.sendMessageStream()
  │
  ├─ ChatRuntime.prepareLiveTurn()
  │   ├─ appendUserMessage()           → DB INSERT
  │   └─ PromptAssemblyService.assembleForChat()
  │       ├─ StaticPromptResolver:
  │       │   ├─ Load character, persona, preset from DB
  │       │   ├─ Load lorebooks + entries (scope-filtered, enabled-only)
  │       │   ├─ Load ranged summaries + exclusion ranges
  │       │   ├─ resolveActivatedEntries()       → domain/prompt/lore-activation-engine
  │       │   ├─ executeScripts()                 → domain/scripts-engine/script-sandbox
  │       │   └─ Persist activation + script state
  │       ├─ Macro resolution ({{user}}, {{char}}, {{scenario}}, etc.)
  │       └─ assemblePrompt()                    → @vibe-tavern/prompt-pipeline
  │           ├─ Build layers (preset, character, persona, lore, memory, history)
  │           ├─ Inject activated lore at configured positions/depths
  │           ├─ Compact history if context budget exceeded
  │           ├─ Sort by position → priority
  │           └─ Filter by AssemblyMode
  │
  ├─ streamProviderExecutor()   (infrastructure/ai/stream-provider-executor)
  │   ├─ mapProfileToSdkModel()         → resolveProtocol(type).resolveModel() — Vercel AI SDK model
  │   ├─ prepareSdkMessages()           → split system/conversation, inject prefill
  │   ├─ buildSamplerConfig()           → infrastructure/ai/sampler-mapper
  │   └─ streamText()                   → Vercel AI SDK → SSE
  │
  └─ ChatRuntime.appendAssistantReply()
      ├─ INSERT assistant message + variant
      ├─ INSERT prompt trace
      ├─ triggerAutoSummary()           → fire-and-forget background
      └─ getSnapshot()                  → full state for frontend
```

> **Known issue:** `getSnapshot()` currently returns a monolithic `SessionSnapshot` on every call — it computes all fields including `contextPreview` (via `assemblePrompt`) and `promptTraceHistory` regardless of what triggered the call. When any prompt trace exists, `contextPreview` is set to `null` (the trace "shadows" the preview). This will be replaced with per-endpoint response builders (see Phase 3.4 in `CODE_REVIEW_REFACTOR_PLAN.md`).
>
> **Exception:** `renameChat` already returns a minimal `{ chatId, title }` object instead of a full snapshot — an early example of endpoint-scoped responses.

**Pipeline order (summary):**

```
Load entities → load summaries → exclude summarized ranges → resolve lorebooks →
activation engine → scripts execute → assemble prompt → LLM call
```

Scripts run BEFORE prompt assembly. They can modify `character.personality`, `character.scenario`, and inject messages via `chat.injectMessage()`. All mutations flow into the assembled prompt.

---

## Lorebook Activation Engine

**File:** `domain/prompt/lore-activation-engine.ts` — **pure function**, no DB access, no side effects.

Takes: lorebooks with entries + recent messages + activation state
Returns: activated entries + updated state

**Why pure function:** Testable in isolation. No mocking needed. Deterministic — same input always produces the same output. The caller (`StaticPromptResolver`) handles persistence.

### Activation Criteria

Each entry is evaluated against:

| Criterion | Description |
|-----------|-------------|
| **Keys** | Primary + secondary keyword matching. Logic: `AND_ALL`, `AND_ANY`, `NOT_ALL`, `NOT_ANY` |
| **Scan depth** | How many recent messages to scan (per-lorebook, per-entry override) |
| **Probability** | Random chance check (0–100). Constant entries bypass this. |
| **Cooldown/Delay/Sticky** | Turn-based timing windows. Cooldown prevents re-activation. Delay skips first N turns. Sticky keeps active for N turns. |
| **Group weights** | Entries in same group compete by weight. |
| **Character filters** | Activate only for specific characters (or exclude). |
| **Match sources** | Where to look: `scanned_text`, `character_description`, `persona_description` |
| **Triggers** | Events: `on_message`, `on_activate`, `on_character_change` |
| **Recursion** | Entries can activate other entries via `recursiveScanning`. |
| **Macro resolution** | Keys are resolved against `{{user}}`, `{{char}}`, etc. before matching. |

Activation state (`LoreActivationState`) is stored as JSON on the `chats` table, tracking per-entry activation turn numbers.

---

## Script System

**File:** `domain/scripts-engine/script-sandbox.ts`

Scripts execute **synchronously** in `node:vm` with 5-second timeout.

### Why synchronous (not async):

1. **Deterministic ordering** — scripts run in `sort_order` sequence. Each script's mutations are visible to the next.
2. **No race conditions** — no `Promise.all()` surprises.
3. **Simple mental model** — scripts can't do async I/O (no `fetch`, no `setTimeout`).

### Script Context API

```js
context.chat.messages          // full message array
context.chat.lastMessage       // getter: last message content
context.chat.injectMessage(content, role?)  // inject system message before model response
context.character.name         // read-only
context.character.personality  // mutable (scripts can +=)
context.character.scenario     // mutable (scripts can +=)
context.lore.activeEntries     // read-only array of activated lore entries
context.state.get(key, default?) / set(key, value) / increment(key, amount)  // persistent state
context.random() / randomInt(min, max) / pick(arr) / weightedPick(entries)   // utilities
```

**Janitor AI compatibility:** Getter-based aliases via `Object.defineProperty` (`last_message` → `lastMessage`, `message_count` → `messageCount`).

**Error handling:** Per-script try/catch. Errors are collected but execution continues to the next script. Script state is persisted as JSON on the `chats` table, keyed by script ID.

### Top-level `return` is a `SyntaxError`

`vm.runInNewContext` parses script bodies as **Program**, not function bodies — bare `return;` throws `SyntaxError: Return statements are only valid inside functions`. Wrap any early-exit logic in an IIFE:

```js
(() => {
  if (context.chat.messageCount < 10) return;
  // ...rest of script
})();
```

Built-in templates that need early exit (`memory`, `dice`) already follow this pattern.

### Built-in Script Templates

**File:** `apps/web/src/components/build/editors/scriptTemplates.ts`

The ScriptEditor offers pre-built templates you can insert with one click:

| Key | Name | What it does |
|-----|------|--------------|
| `relationship` | Relationship Progression | Evolves `character.personality`/`scenario` based on `messageCount` |
| `events` | Scenario Events | Triggers scenario changes from keywords in the last message |
| `memory` | Conversation Memory | Detects hobbies/preferences mentioned in chat and adds them to personality |
| `lorebook` | Dynamic Lorebook | Keyword-triggered backstory injection |
| `advanced_lore` | Advanced Lorebook | Multi-pass activation with priorities, filters, recursive triggers |
| `hp` | HP Tracker | Persistent HP system with damage/heal keywords; uses `context.state` |
| `dice` | Dice Roller (`/roll`) | Parses `/roll dN[+/-M]` in the last user message, caches results in `context.state` for regen-stability. Supports `d%`, multiple dice, and `adv`/`dis` (D&D advantage/disadvantage) |
| `random` | Random Event | 5% chance per turn to inject an ambient flavor event |

#### Dice Roller (`/roll`) — pattern for stable randomness

```text
/roll d20           → 🎲 1d20 → 14   [14]
/roll 2d6+3         → 🎲 2d6+3 → 11   [4 + 4]
/roll 2d20 adv      → 🎲 2d20 → 17   [17] (advantage, dropped 4)
/roll d%            → 🎲 1d% → 78    [78]
```

The script caches results in `context.state` under a key derived from the last message's content+length — **the same input message always returns the same dice values on regeneration**. The cache is per-chat (`scriptState` on the `chats` table). Output is injected as a system message visible to the LLM in trace, not shown in the UI.

This pattern (cache keyed by input content in `context.state`) is the recommended way to implement any "honest" random outcome that must survive regen.

---

## AI Execution Layer

The AI layer is split across two slices: **provider knowledge** lives in `domain/providers/` (the registry), and the **generation pipeline** lives in `infrastructure/ai/` (executors, sampler wiring, tokenizer, vision).

### Protocol registry — `domain/providers/protocol-registry.ts`

The single source of truth for per-protocol behaviour. Each canonical `ProviderType` (defined in `packages/domain/src/platform-constants.ts`) has one `ProtocolAdapter` object that carries **everything** previously scattered across four hand-synced switch-ladders:

- `capabilities` — capability flags (`streaming`, `nonStreamGeneration`, `abortSignal`, `prefill`, `logitBias`, `samplers`, `textCompletion`). The derived `PROTOCOL_CAPABILITIES` map is exported for compat callers.
- `resolveModel(profile, model)` — builds the Vercel AI SDK `LanguageModel` (chat model) for this protocol.
- `limitations` — human-readable constraints surfaced to the UI.
- `probe / testChat / listModels` — the HTTP shape of that protocol's connectivity probe, test chat, and model-list endpoints.

`resolveProtocol(type)` looks up the adapter. `normalizeProviderType(raw)` (in `packages/domain/src/provider-support.ts`) maps a raw preset id to a `ProviderType` via `PRESET_TO_PROVIDER_TYPE`, falling back to `openai_compat`.

The 7 protocols: `openai_compat`, `anthropic`, `google`, `ollama`, `llamacpp`, `koboldcpp`, `unsloth`. Native (non-SDK) protocols (`ollama`, `koboldcpp`) have dedicated adapters (`ollama-adapter.ts`, `koboldcpp-adapter.ts`) for their text-completion API shapes.

### Compat shims — `infrastructure/ai/`

These are thin delegators kept for call-site compatibility (tracked as tech-debt TD-006 — callers should eventually import `resolveProtocol()` directly):

- `provider-profile-mapper.ts` → `mapProfileToSdkModel()` calls `resolveProtocol(type).resolveModel()`. `isUnsupportedProvider()` checks capabilities.
- `provider-capabilities.ts` → `PROVIDER_CAPABILITIES` re-exports `PROTOCOL_CAPABILITIES`; `getProviderCapabilities(type)` delegates to the registry.

### Gateway & orchestrator — `domain/providers/`

- `provider-gateway.ts` — public dispatch surface for probe / test-chat / model-list. `normalizeProviderType` → `resolveProtocol(type).<op>`. Plus the `requiresAuthForModels` guard. This is a thin delegator; the per-protocol HTTP shapes live in the registry, not here.
- `vendor-registry.ts` — aggregator-specific quirks for OpenAI-compat `/models` responses (OpenRouter, xAI, ElectronHub, Groq, etc.). `resolveVendor(baseUrl)` returns a `VendorAdapter` (match regex, optional `buildModelsUrl` / `extractRecords` / `filterRecords` / `extractCapabilities`). First match wins, else `genericVendor`. Adding a vendor that speaks standard OpenAI-compat = zero new code; a vendor with a non-standard model list = one `VendorAdapter` entry here.
- `provider-orchestrator.ts` → `ProviderOrchestrator.refreshProfileModels()` composes `listProviderModels` + `provider-profile-service` caching + a `defaultModel` fallback.
- `provider-transport.ts` — shared HTTP helpers (URL normalisation, header building, timeouts, `extractChoiceContent`, error wrapping) and the shared types (`ProviderConnectionInput`, `ProviderModelOption`, `ProviderProbeResult`, `TestChatResult`).

**Why a registry:** Adding a native provider is one object entry in `protocol-registry.ts`, not a four-site lock-step edit. See [Adding a new AI provider](./adding-a-provider.md).

### Sampler wiring — `infrastructure/ai/sampler-mapper.ts`

`buildSamplerConfig(profile)` converts stored provider-profile sampler fields into AI SDK arguments. Capability gating comes from `resolveSamplerCapabilities(preset, type)` → `SAMPLER_SETS` (`packages/domain/src/sampler-params.ts`), which defines per-set capability flags (e.g. `openai_local`, `anthropic`, `minimal_reasoning`, `koboldcpp_native`).

- `temperature`, `maxTokens`, and `stopSequences` are sent whenever set.
- `stopSequences` are provider-profile strings; the UI `ChipInput` supports literal `\n`, `\t`, and space shortcuts and stores the parsed characters.
- `seed` is still sent when set, even if custom samplers are disabled.
- Advanced sampler fields are only sent when `customSamplers` is enabled, then routed per protocol: native AI SDK fields, or `providerOptions.<providerName>` for OpenAI-compat locals (Ollama/llamacpp/unsloth), or `providerOptions.koboldcpp` for KoboldCPP's native body params. The per-protocol serialization switch in `buildSamplerConfig` is intentionally kept here — native param *names* genuinely differ per protocol, unlike capabilities which are registry-driven.

### Logit Bias

Logit bias is model-aware and fail-closed because token IDs are tokenizer/model-local.

- Support is decided by `resolveLogitBiasSupport()` in `packages/domain/src/provider-support.ts`, shared by web and API.
- Router/mixed presets (for example OpenRouter/NanoGPT/Chutes/ElectronHub/Fireworks/SiliconFlow/Together/Perplexity) are disabled because a single profile can target multiple tokenizer families.
- Providers that do not support logit bias at the API level (Anthropic, Google, Groq, xAI, Moonshot, AI21, Xiaomi MiMo, KoboldCpp) are disabled even if a tokenizer exists for counting.
- Unknown models/tokenizers are disabled rather than falling back to `cl100k_base` for bias IDs.
- Each saved logit-bias entry is stamped with the model it was tokenized for; generation only sends entries whose `entry.model` matches the current `defaultModel`.
- Supported direct/local cases require a known tokenizer hint: OpenAI (`o200k`/`cl100k`/`p50k`), Mistral/Nemo, DeepSeek, ZAI GLM, Llama 3, Qwen2, Command R/A, and local OpenAI-compatible servers.

### Streaming

`stream-provider-executor.ts` uses AI SDK's `streamText()` — returns async iterable of chunks:
- `text-delta` — assistant text content
- `reasoning-delta` — thinking/reasoning content (DeepSeek R1, Claude extended thinking)
- `error` — provider-side stream errors (logged and thrown)

### OpenAI Reasoning Fetch

`domain/providers/openai-reasoning-fetch.ts` — custom fetch wrapper that intercepts SSE streams and rewrites `reasoning_content` fields into regular content with markers. This prevents AI SDK from silently stripping reasoning from providers that include it as a non-standard field.

### Tokenizer Service

`infrastructure/ai/tokenizer-service.ts` — three-tier token counting:

1. **`js-tiktoken`** — BPE tokenization for OpenAI models (cl100k, o200k, p50k). Fast, accurate.
2. **`@agnai/web-tokenizers`** — WASM/JSON tokenizers for Claude, Llama 3, Mistral, Nemo, Qwen2, DeepSeek, Xiaomi MiMo, GLM-4.6/ZAI, and Cohere Command R/A. Slower but accurate for non-GPT models.
3. **Default/fallback** — prompt token counting falls back to `cl100k_base` and then a rough `length / 4` estimate if tokenization fails.

The fallback is acceptable for context-budget accounting, but **not** for logit bias. Logit bias must have a known tokenizer/provider match or it is disabled.

---

## Vision and Attachment Pipeline

**Modules:** `infrastructure/ai/vision-gate.ts`, `image-compress.ts`, the two provider executors, and `api/adapters/chat-adapter.ts`.

Image/video attachments attached to a message take one of three paths depending on the active profile's capabilities. The decision is made per-send in the provider executors (`infrastructure/ai/stream-provider-executor.ts` / `nonstreaming-provider-executor.ts`) and finalized in `resolveMultimodalContent`.

### The three paths

| # | Condition | What happens |
|---|-----------|--------------|
| 1 | Primary model **has vision** (`capabilities.vision`) | Attachment is sent to the provider as an `ImagePart`. Large PNGs are compressed to JPEG first (`compressForVision`). |
| 2 | Primary model **lacks vision**, but a **`visionModel`** is configured in the profile | Attachments are first *described* by the vision model into text, then injected into the prompt as a `TextPart`: `[Attached image: <name>]\n<description>`. The original `image`/`video` attachment is rewritten to `type: "file"` so it is never sent as an image. |
| 3 | Primary model **lacks vision** *and* **no vision model** is configured | Send is rejected with `VisionNotSupportedError` → HTTP **422** `vision_not_supported`. |

### Describe step (path 2) — `describeAttachments`

Runs in the executor **before** `resolveMultimodalContent`, only when `shouldDescribe = hasAttachments && visionModel`:

1. **Skip-if-described guard** — only attachments with `!description?.trim()` are collected. Attachments that already carry a description (auto-generated on a previous turn, or hand-edited in the lightbox) are left untouched. This is the non-destructive caching rule: descriptions are generated **once**, never re-generated unless the user explicitly asks.
2. **Describe** — for each remaining image/video attachment, `generateText` is called against the profile's `visionModel` (same provider/endpoint/apiKey as the primary model), using the `vision_describe` system prompt (see resolution below). One call per attachment; no batching.
3. **Reasoning strip** — the full response is passed through `splitReasoningFromText` (the same splitter the AI Assistant modal uses). Chain-of-thought (`<think>…</think>`, reasoning markers) is stripped so it never leaks into the persisted description or the model's context on later turns. Falls back to the raw text only if stripping yields an empty string.
4. **Persist** — descriptions are written back to the message's attachments JSON via `onAttachmentDescriptions` callback → `chatApp.updateSingleAttachmentDescription`. This is **unconditional**: even when the primary model *has* vision (path 1), a `visionModel` config still triggers describing + persisting, purely so the lightbox can show the caption. The difference is the attachment keeps `type: "image"` (so `resolveMultimodalContent` sends it as an image), rather than being rewritten to `file`.

### Prompt resolution (unified with the AI Assistant)

`vision_describe` is registered as a real `AiAssistantMode` in `domain/ai-assistant/ai-assistant-modes.ts` (`MODE_CONFIGS`). It is **not user-facing** in the AI Assistant modal — it exists solely so the describe pipeline resolves its prompt through the *same* `resolveSystemPrompt` fallback chain as the other modes, and so the Settings prompt editor's `vision_describe` key is backed by a real config rather than a phantom.

Resolution order (in `resolveVisionDescribePrompt` → `resolveSystemPrompt("vision_describe")`):

1. Preset override — `aiAssistantPrompts["vision_describe"]` from the active prompt preset.
2. Default `.md` — `services/api/assets/vision-describe-ai-prompt.md` (loaded + cached by `ai-assistant-prompts.ts`).

There is no legacy column for this mode (it is newer than the `scriptAiSystemPrompt` migration). The default `.md` instructs the model to describe only what is visible, stay sensory/specific, quote in-image text verbatim, and emit **no** meta-commentary ("The image shows…").

### Manual regeneration

Because of the skip-if-described guard, a described attachment is never re-described automatically. Forced re-description is exposed as an explicit user action:

`ChatAdapter.regenerateAttachmentDescription(chatId, messageId, attachmentId)` (`api/adapters/chat-adapter.ts`) —
- Validates the attachment is `image`/`video` and a `visionModel` is configured.
- Calls `describeAttachments([single])` using the **same** vision resolution path as send (active profile's `visionModel` + the `vision_describe` prompt), **ignoring** any existing description.
- Persists the new description via `updateSingleAttachmentDescription`.

This keeps the auto-describe cache non-destructive while still letting the user force a fresh caption (or add one to a previously-empty attachment) from the lightbox.

### Type: `Attachment` (`packages/domain/src/attachment.ts`)

```ts
type AttachmentType = "image" | "file" | "video";
interface Attachment {
  id: string;          // correlates vision descriptions back to the attachment
  assetId: string;     // stored asset in AssetService
  type: AttachmentType;// image → ImagePart, file → TextPart, video → frame extraction
  name: string;
  mimeType: string;
  sizeBytes: number;
  description?: string | null;  // populated by the vision model (path 2); null = not described
}
```

The `type` rewrite `image → file` in path 2 is how a described image becomes a pure-text prompt injection downstream — `resolveMultimodalContent` only sends `image`/`video` typed attachments as actual images.

---

## Prompt Pipeline

**Package:** `@vibe-tavern/prompt-pipeline` — pure function, no I/O, no database.

### Layer System

Prompts are assembled from ordered layers. Each layer has:

| Field | Meaning |
|-------|---------|
| `position` | `before_prompt` → `in_prompt` → `in_chat` → `hidden_system` |
| `priority` | Higher = earlier within position (1000 = system prompt, 100 = history) |
| `injectionDepth` | For `in_chat`: insert N messages from end of history |
| `modes` | Which `AssemblyMode` this layer is active in |
| `sourceType` | `prompt_preset`, `character`, `persona`, `lore_entry`, `summary_memory`, `chat_history`, etc. |

### Default Priority Stack

```
1000  prompt_preset_system        — before all character data
 990  prompt_preset_jailbreak
 950  character_system_prompt     — character's own system prompt
 900  character_base              — name + description + scenario
 890  character_personality
 850  persona                     — user persona block
 500  summary_memory              — chat summaries
 400  retrieval_memory            — RAG hits
 350  prompt_preset_summary       — summary instructions
 300  tool_instructions
 170  prompt_preset_authors_note  — injected at depth in history
 160  post_history_instructions
 150  mes_example                 — mode: always | once | depth
 100  recent_history              — actual chat messages
  50  preflight_compaction        — metadata about compacted messages
```

### Context Compaction

When `contextBudget` is set and history exceeds budget:

1. Reserve `responseReserve` tokens (from provider's `maxTokens`)
2. Calculate `historyBudget = contextBudget - permanentTokens - responseReserve`
3. Walk messages from the end, keeping as many as fit
4. Always keep at least last 2 messages
5. `findSafeCompactionBoundary()` ensures assistant→tool pairs aren't split

### Assembly Modes

| Mode | Purpose |
|------|---------|
| `chat` | Normal user → assistant turn |
| `continue` | Generate next assistant message without user input |
| `regenerate` | Re-generate a specific assistant message |
| `summary` | Summarize chat history |
| `tool_call` | Tool-use generation |

---

## Memory System (Ranged Summaries)

Chat summaries are stored as **ranged records** — each covers a specific message range (e.g. T1–T40) within a chat branch.

**Storage split:**
- **Metadata** → SQLite `chat_summaries` table (range, toggles, source, timestamps)
- **Text content** → `.md` files under `data/summaries/{id}.md` via `ContentStore`

**Why split:** Summary text can be very long (thousands of tokens). SQLite text columns handle it, but `.md` files are easier to browse, backup, and edit manually. The split also avoids bloating the DB for a data type that's read-heavy and rarely queried by content.

### Exclusion Filtering

When a summary has `excludeSummarized=true`:
1. Build exclusion ranges from `summarizedFrom`/`summarizedTo`
2. Filter messages whose position falls within any range
3. **Always preserve the last user message** — prevents empty prompt on regenerate

### Auto-Summary

Fire-and-forget background task triggered after `appendAssistantReply()`:
- Config: `enabled`, `everyN` (default 20), `useChatModel`, `excludeSummarized`
- Guards: concurrent run lock per chat+branch, message count threshold
- Creates a new summary covering messages since the last summary's `summarizedTo`
- Range capped at `lastMessagePosition - 1` (excludes last user message)

---

## Mobile Access

Token-based authentication with optional TLS for LAN/Tailscale/mobile clients.

**Flow:**
1. User enables mobile access → backend generates a UUID token
2. Frontend renders QR/copy URLs as `http(s)://IP:PORT/#token=UUID`
3. Mobile browser opens URL → reads token from hash → stores it in `localStorage` (`vibe_mobile_token`) → removes the hash from the visible URL
4. API calls include `Authorization: Bearer <token>`; bootstrap also appends `?token=...` as a fallback for first-load/retry robustness

**Security:**
- Loopback (`127.0.0.1`/`::1`) always bypasses auth
- Remote `/api/*` requests are denied with 401 when no mobile token is configured, so LAN exposure is fail-closed
- Remote clients must provide the current token via `Authorization: Bearer <token>` or `?token=<token>`
- `GET`/`HEAD /api/assets/*` stay public for `<img>` rendering; asset upload/mutation routes require auth
- Token regeneration/revocation is dynamic and invalidates old tokens immediately without server restart
- TLS via self-signed certs is optional (user accepts warning once)

**API base URL:** `apps/web/src/gateway-client.ts` prefers `window.location.origin` when the web app is opened from a non-loopback host but `VITE_RP_API_URL` points at `localhost`/`127.0.0.1`. This prevents LAN/Tailscale clients from trying to call their own loopback address.

---

## Error Handling

`DomainError` with kind → HTTP status mapping:

| Kind | HTTP Status |
|------|-------------|
| `NotFound` | 404 |
| `Validation` | 400 |
| `Conflict` | 409 |
| `Provider` | 502 |
| `Cancelled` | 499 |
| `Unauthorized` | 401 |
| `Internal` | 500 |

All route handlers catch `DomainError` and map to the appropriate HTTP response. Unknown errors become 500 with a generic message.
