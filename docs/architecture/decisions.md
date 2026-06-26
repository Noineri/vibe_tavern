# Architectural Decisions

> **Why things are done the way they are.** Not what the code does, but why this approach was chosen over alternatives.

---

## AD-001: Bottom-Pinning over Delta-Anchoring for Variant Switches

**Context:** When switching message variants (swipes) on desktop, the message height changes. This causes Virtuoso to recalculate scroll position, making the variant control arrows drift away from the cursor.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|---------|
| **Delta-anchoring** | Calculate height delta, adjust `scrollTop` by that delta | Fragile — Virtuoso's internal measurement cycle can happen after our adjustment, undoing it. Spring animation settling time varies. |
| **Layout animation** | `motion.div layout` on the message wrapper | Conflicts with Virtuoso's own height measurement. Causes flicker and incorrect scroll positions. |
| **Bottom-pinning** | Force `scrollTop = scrollHeight` for 900ms via rAF loop | Works regardless of spring timing, Virtuoso quirks, or message length. |

**Decision:** Bottom-pinning via `requestAnimationFrame` loop + portal overlay for controls.

**Rationale:**
- The 900ms window covers Virtuoso's measurement cycle + Framer Motion's spring settling
- The portal overlay (`createPortal`) keeps the actual clickable arrows at fixed screen coordinates
- Together they guarantee the cursor stays over the arrows during the entire transition
- If the message is at the bottom of the chat (most common case for variant switching), bottom-pinning is exactly the right behavior — the user expects to stay at the bottom

**Trade-off:** Brief visual "stickiness" at the bottom during the pin window. Acceptable because the user is actively interacting with variant controls and not scrolling.

---

## AD-002: True Carousel over Gesture-to-Slide for Mobile Variants

**Context:** Mobile users need to swipe between message variants. Two approaches for horizontal drag interaction.

**Options considered:**

| Approach | Description | Feel |
|----------|-------------|------|
| **Gesture-to-slide** | Current panel slides out after drag threshold, next slides in | "Cheap" — content isn't visible during the gesture. Feels like a page turn. |
| **True carousel** | Previous/current/next panels rendered side-by-side, content follows finger | "Premium" — content is visible during drag. Feels like a native carousel. |

**Decision:** True 3-panel carousel.

**Rationale:**
- RP users swipe frequently between variants to compare responses — seeing the content during drag is valuable
- `items-start` on the flex track prevents height-stretch (each panel is its natural height)
- `dragDirectionLock` + `touchAction: pan-y` prevents horizontal drag from blocking vertical scroll
- Height is locked to the current panel and smoothly adjusted after the slide commits — avoids layout jumps during drag

**Trade-off:** Three panels rendered simultaneously. Acceptable because only markdown text is rendered (no images or heavy components), and only the current panel's content is actively measured.

---

## AD-003: Portal Overlay for Desktop Variant Controls

**Context:** The variant switch arrows (◀ ▶) must stay under the cursor during the height transition.

**Decision:** `createPortal(controls, document.body)` with fixed positioning during the 450ms transition window.

**Rationale:**
- `position: fixed` is immune to scroll position changes, layout shifts, and Virtuoso recalculations
- The portal renders at the exact screen coordinates of the original controls
- After the transition window, the portal is removed and the original (now correctly positioned) controls take over
- Simpler than trying to synchronize React state with Virtuoso's measurement cycle

**Trade-off:** Brief visual discontinuity if the user scrolls during the overlay window. Extremely unlikely — the user is clicking variant arrows, not scrolling.

---

## AD-004: Ghost Message Filtering in MessageList

**Context:** After sending a message, the optimistic UI shows a pending user message. When the backend confirms, the snapshot includes the persisted message. Without filtering, the same message appears twice.

**Decision:** Filter the last persisted user message from the rendered list if its content matches `pendingUserMessageContent`.

**Rationale:**
- Content-based matching is reliable because the pending content is set from the same string that gets persisted
- The filter is reactive — it activates only during streaming and deactivates when the snapshot arrives
- The pending message is shown via Virtuoso's Footer component (`StreamingContent`), so there's always exactly one copy visible
- Simpler than tracking message IDs (the pending message doesn't have a server ID yet)

**Trade-off:** If two identical user messages are sent in sequence, the second could be filtered. Prevented by the UI — the send button is disabled during streaming.

---

## AD-005: Synchronous Script Execution

**Context:** User-written scripts modify character data and chat state before prompt assembly.

**Decision:** Synchronous execution in `node:vm` with 5-second timeout, ordered by `sort_order`.

**Rationale:**
- **Deterministic ordering** — each script sees the mutations of all previous scripts. Async execution would require complex dependency resolution.
- **No race conditions** — no `Promise.all()` surprises, no interleaving.
- **Security** — `node:vm` sandboxing prevents file system access, network access, and process spawning.
- **Janitor AI compatibility** — Janitor executes scripts synchronously. Matching this behavior ensures compatibility.

**Trade-off:** Scripts can't do async I/O (no `fetch`, no `setTimeout`). Acceptable because scripts are meant for prompt manipulation, not network calls.

---

## AD-006: Monorepo with Strict Package Boundaries

**Context:** Code is split across 5 workspace packages plus 2 apps/services with one-directional dependencies.

**Decision:** `domain` → `db` / `api-contracts` / `prompt-pipeline` / `import-export` → `api` → `web`.

**Rationale:**
- **Compile-time boundary enforcement** — TypeScript catches cross-boundary imports. `prompt-pipeline` can't accidentally import from `db`.
- **Shared types** — `domain` is the single source of truth for all type definitions. Both frontend and backend import from it.
- **Atomic changes** — adding a DB column touches domain → db → api-contracts → api → web in one PR. No versioning ceremony between packages.
- **Testable in isolation** — `prompt-pipeline` is pure (no I/O, no DB). Unit tests don't need a database.

**Trade-off:** More files to touch for cross-cutting changes. Acceptable because the monorepo tooling (Bun workspaces, TypeScript project references) makes navigation seamless.

---

## AD-007: Zustand over Redux for State Management

**Context:** Frontend needs a state management solution for the backend snapshot + UI state.

**Decision:** Zustand with Immer for immutable updates. Derived data is memoized with `useMemo` and Zustand's `useShallow` where needed.

**Rationale:**
- **No boilerplate** — no actions, reducers, dispatchers, providers, or middleware. `create((set, get) => ({ ... }))` is the entire API.
- **No context** — Zustand stores are plain JS modules. No `<Provider>` wrapping. Store updates don't trigger React re-renders unless the subscribed slice actually changes.
- **External store compatibility** — `useSyncExternalStore` integration means React treats Zustand like any other external data source.
- **Focused selectors** — components subscribe to narrow slices; derived arrays/objects use `useShallow`/`useMemo` to avoid unnecessary renders.
- **Snapshot pattern** — the backend sends a monolithic snapshot. Zustand's `set()` replaces the entire state atomically. Redux would need a "hydrate" action that touches multiple reducers.

**Trade-off:** Less structured than Redux. No time-travel debugging without extra setup. Acceptable for a local-first app where the backend is the source of truth.

---

## AD-008: SQLite over PostgreSQL

**Context:** Local-first single-user app needs a database.

**Decision:** SQLite with WAL mode, accessed via Drizzle ORM + `bun:sqlite`.

**Rationale:**
- **Zero-config** — no server process, no connection string, no authentication.
- **Single file** — the entire database is `data/vibe_tavern.db`. Backups = copy the file.
- **Bun-native** — `bun:sqlite` is built into Bun. No native bindings to install.
- **WAL mode** — concurrent reads with single writer. Perfect for single-user load profile.
- **Portable** — the DB file works on any OS. No platform-specific setup.

**Trade-off:** No concurrent writes (single writer). Acceptable — only one user at a time. No built-in replication — but the single-file approach makes manual backup trivial.

---

## AD-009: Hono RPC Client for Type-Safe API Calls

**Context:** Frontend needs to call backend API with compile-time safety.

**Decision:** Shared Hono router definition used by both server and `app-client.ts` RPC client.

**Rationale:**
- **Zero code generation** — the Hono client infers types from the router definition at compile time.
- **No OpenAPI/Swagger** — the router IS the contract. No separate spec file to maintain.
- **Change once, catch everywhere** — if a route parameter type changes, TypeScript errors appear in both frontend and backend.

**Trade-off:** Frontend and backend must share the router type definitions (via workspace packages). Currently achieved by both importing from `@vibe-tavern/api`.

---

## AD-010: react-virtuoso over react-window for Message List

**Context:** Chat message list needs virtual scrolling with reverse ordering and dynamic heights.

**Decision:** react-virtuoso.

**Rationale:**
- **Built-in reverse list** — `initialTopMostItemIndex` starts at bottom, `followOutput="smooth"` auto-scrolls on new messages. react-window requires manual reverse logic.
- **Dynamic height** — Virtuoso measures each item automatically. react-window requires `estimateSize` which is inaccurate for variable-length markdown content.
- **Footer component** — renders `StreamingContent` as a virtual item at the bottom. react-window doesn't have this concept.
- **Chat-optimized** — Virtuoso was designed for chat UIs. react-window is general-purpose.

**Trade-off:** Larger bundle than react-window (~15KB vs ~6KB). Acceptable for the feature set.

---

## AD-011: Single-Process Architecture

**Context:** Backend needs to serve API + static files + handle AI streaming.

**Decision:** One Bun process does everything.

**Rationale:**
- **Local-first** — no horizontal scaling needed. One user, one machine.
- **Zero network hops** — API and DB are in the same process. SQLite queries take microseconds, not milliseconds.
- **Simple deployment** — `bun run dev` or a single `.exe`. No docker-compose for local use (Docker is optional).
- **Cold start** — port reachable in milliseconds, fully operational in 2–7s (loading placeholder bridges the gap; see AD-018). No container orchestration, no health checks.

**Trade-off:** No horizontal scaling. Acceptable — the app is explicitly single-user by design.

---

## AD-012: Branded IDs

**Context:** All entity IDs are strings with prefixes (`char_...`, `chat_...`, `msg_...`).

**Decision:** TypeScript branded types (`Brand<"ChatId">`) make ID swaps compile-time errors.

**Rationale:**
- A function expecting `ChatId` won't accept `MessageId` even though both are strings
- Catches the most common bug in CRUD-heavy apps — passing the wrong ID to a function
- Zero runtime cost — brands are erased during compilation

**Trade-off:** Slightly more verbose type signatures. Acceptable for the safety benefit.

---

## AD-013: Visual Position as Source of Truth for Prompt Canvas

**Context:** The Advanced Prompt Manager canvas shows prompt blocks in a sortable layout. Users need to rearrange prompts across zones (before chat, in-chat at various depths, after chat) and have those positions persist reliably.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|----------|
| **Separate inputs** | Position/depth number inputs on each card | Disconnects visual order from stored data. Users see one thing but the numbers say another. |
| **Flat order array** | Single `order` number per entry, derive zone from thresholds | Ambiguous boundaries. Changing a threshold shifts all entries. No explicit zone. |
| **PromptSlot on entries** | Each entry stores `{ zone, depth, order }` directly | Explicit, unambiguous, maps 1:1 to canvas position. |

**Decision:** `PromptSlot` (`zone` + `depth` + `order`) stored on both `PromptOrderEntry` (for built-in slots) and `CustomInjection.slot` (for custom injections). Visual position on the canvas is the absolute authority — no separate position inputs.

**Rationale:**
- **WYSIWYG** — what you see on the canvas is exactly what the pipeline assembles. No hidden state.
- **Zone-explicit** — `before_chat`, `in_chat`, `after_chat` are stored as data, not derived from order thresholds.
- **Backward-compatible** — `migrateInjection()` converts legacy ST fields on first access. `slotToStFields()` reverse-maps for export.
- **Zod-safe** — `zone` and `depth` are included in the Zod validation schema so they survive the server round-trip.

**Trade-off:** More fields per entry (`zone`, `depth`, `order` instead of just `order`). Acceptable because it eliminates an entire class of position desync bugs.

---

## AD-014: Junction Table for Lorebook Links

**Context:** A lorebook can be shared across multiple characters and personas. SillyTavern models this as `charLore: [{ name, extraBooks }] }` in user settings — a flat array mapping character files to world info names.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|----------|
| **FK columns** | `characterId`/`personaId` on `lorebooks` (current) | Only one owner per lorebook. Sharing requires full copies. |
| **Junction table** | `lorebook_links(lorebookId, targetType, targetId)` | Clean many-to-many. Requires migration from FKs. |
| **JSON array** | `linkedTargetIds` JSON column on `lorebooks` | No referential integrity, no indexed joins. |
| **Copy-on-link** | Create a full copy when "linking" | Diverges from original. Wasteful for large lorebooks. |

**Decision:** Junction table `lorebook_links`.

**Rationale:**
- **Referential integrity** — `ON DELETE CASCADE` cleans up links automatically when a lorebook is deleted
- **Indexed lookups** — `listAllActiveForChat` uses `JOIN` through `lorebook_links` for O(log n) lookup instead of scanning JSON arrays
- **Bidirectional queries** — "which lorebooks does this character have?" and "which characters is this lorebook linked to?" are both indexed
- **Migration path** — Existing FK columns (`characterId`, `personaId`) are retained as the "primary owner" for scope-based UI tabs and import/duplicate flows. The migration populates `lorebook_links` from existing FK values.

**Key design choices:**
- **No `chat` target type** — Chat lorebooks are inherently tied to a specific conversation. Linking them to other chats is semantically meaningless. They remain 1:1 via the `chatId` FK.
- **Composite PK** — `(lorebookId, targetType, targetId)` is the natural key. No synthetic `id` column needed.
- **Legacy FK retention** — `lorebooks.characterId`/`personaId` are NOT removed. They serve as the "primary owner" used by the scope column UI and by import/duplicate flows that need to know "where does this lorebook live?"

**Trade-off:** Two sources of truth (FK + links table) for character/persona associations. Mitigated by: (1) the migration seeds links from FKs, (2) `createLorebook` populates both, (3) the pipeline (`listAllActiveForChat`) reads exclusively from links.

---

## AD-015: Flex Centering over CSS Transform for Modal Positioning

**Context:** The Setup Wizard uses a Radix `Dialog` as its container. Child components (model dropdown, avatar crop modal) use `position: fixed` and portal into `#modal-portal` inside the Dialog content.

**Problem:** `Dialog.Content` used `transform: translate(-50%, -50%)` for centering, which creates a new containing block for `position: fixed` descendants. This caused fixed-position portaled elements to be offset by thousands of pixels relative to the viewport.

**Decision:** Replace CSS transform centering with `fixed inset-0 flex items-center justify-center` on the overlay.

**Rationale:**
- `flex` centering does NOT create a new containing block — `position: fixed` children still reference the viewport
- Portaled elements (dropdown, crop modal) render at correct screen coordinates
- No change to visual appearance — dialog is still centered
- Simpler CSS — no negative margins or calc expressions

**Trade-off:** None. Flex centering is strictly superior for this use case.

---

## AD-016: Endpoint-Scoped Responses over Monolithic Snapshots

**Status:** Proposed. The frontend prerequisite landed in Phase 3.4.1 (2026-06-13): `AppSnapshot` fields are now optional, `normalizeSnapshot()` preserves absence, and `ingestSnapshot()` uses presence guards (see `reports/tech-debt.md` TD-004, RESOLVED). The backend half — actually returning partial responses from mutating endpoints — is still pending; every mutating endpoint still returns a full `SessionSnapshot`. The original driving plan (`CODE_REVIEW_REFACTOR_PLAN.md`) has been archived in the planning repo.

**Context:** The current architecture returns a full `SessionSnapshot` from every chat mutation. `getSnapshot(chatId)` recomputes *all* fields — chats list, all characters, messages, branches, summaries, prompt traces, context preview, character, persona — regardless of which field changed. Renaming a chat re-runs `assemblePrompt()` for the context preview and re-reads every character in the database.

**Problem:**
1. **Wasted work** — a rename that only needs `{ chatId, title }` triggers tokenization, prompt assembly, and a full DB sweep.
2. **Coupling** — `contextPreview` is nulled whenever a prompt trace exists, conflating "live preview" with "last generation".
3. **Blocks features** — Novel Mode, Sidechat, and Co-Author Mode each need a different subset of data; forcing them through one snapshot shape is awkward.

**Decision:** Replace monolithic snapshots with **endpoint-scoped response types**. Each endpoint returns only the fields its consumer needs:

| Endpoint | Response |
|----------|----------|
| `POST /messages/stream` | `{ messages, contextPreview, summaries }` |
| `PATCH /variant` | `{ messages, activeBranch, contextPreview }` |
| `PATCH /branch` | `{ messages, activeBranch, branches, summaries, contextPreview }` |
| `PATCH /characters/:id` | `{ character, contextPreview }` |
| `GET /bootstrap` | Full state (character, persona, contextPreview included for instant Build Mode switch) |

There are no "modes" on the server — each endpoint is independently typed. The first examples of this pattern already exist in the codebase: `renameChat` returns `{ chatId, title }`, `archiveCharacter` returns `{ characterId, status }`.

**Frontend impact (TD-004):** Absence is **not** preserved today, despite `ingestSnapshot()`'s guards looking like they protect absent fields. The real pipeline is `backend → normalizeSnapshot() → ingestSnapshot()`, and `normalizeSnapshot()` (`api/normalize.ts`) coerces absent arrays → `[]` and absent scalars → `null`/`{}` *before* the store sees the snapshot. Result: 11 of 12 fields are overwritten with emptiness when absent (not just `messages`), and the `else if` messages-wipe branch is unreachable. This is **latent** today — every backend path returns a full `SessionSnapshot`, so the wipe never fires. Becoming endpoint-scoped makes it active data-loss on the first response that omits a field (e.g. `PATCH /characters/:id → { character, contextPreview }` would wipe the active chat's messages). Fix must be end-to-end before this ADR ships: make omittable fields optional in `AppSnapshot`/`SessionSnapshot`, make `normalizeSnapshot` preserve absence, rewrite `ingestSnapshot` guards to test `"field" in snapshot`, and wire `switchChatAction` to call `clearMessages()` explicitly. See TD-004 for the full Serena-verified data-flow analysis.

**Rationale:**
- Each consumer gets exactly what it needs — no over-fetching, no wasted tokenization
- `contextPreview` is included only in endpoints that change text content (token counts must update in the UI token bar)
- Build Mode data (`character`, `persona`, `contextPreview`) is loaded once at bootstrap, enabling instant Chat ↔ Build switching with no extra requests
- Trace (immutable record of a *past* generation) and Preview (live computation of the *next* prompt) become cleanly separated: traces load lazily via `GET /api/chats/:id/traces`

**Trade-off:** More response types to maintain (one per endpoint family) instead of a single `SessionSnapshot`. Acceptable — the types are small and the backend derives them from the same DB reads, just selects fewer fields. Net reduction in wasted computation.

---

## AD-017: `vision_describe` as a Non-User-Facing AI Assistant Mode

**Status:** Implemented (commit `eb51215`).

**Context:** The attachment-description pipeline (vision fallback — describing images as text when the primary model lacks vision) needs a system prompt. Before this ADR, `vision-gate.ts` carried its own duplicate prompt-loading machinery: a hard-coded candidate-path list and a separate cache, distinct from the `ai-assistant-prompts.ts` loader used by the five user-facing assistant modes (`script`, `lore_entry`, `lore_keys`, `chat_impersonate`, `md_import`). Two `.md`-loading code paths for prompts that should behave identically.

At the same time, the Settings prompt editor already surfaced a `vision_describe` key in the preset's `aiAssistantPrompts` JSON — but that key resolved to nothing, because `vision_describe` was not a real mode in `MODE_CONFIGS`. It was a phantom: editable in the UI, ignored by the backend.

**Decision:** Register `vision_describe` as a real `AiAssistantMode` in `MODE_CONFIGS` (`ai-assistant-modes.ts`), pointing its `defaultPromptFile` at `services/api/assets/vision-describe-ai-prompt.md`. Delete the bespoke candidate-path + cache in `vision-gate.ts`; `resolveVisionDescribePrompt` now delegates to the shared `resolveSystemPrompt("vision_describe")`. The preset override → default `.md` fallback chain now applies uniformly to all six modes.

Crucially, `vision_describe` is **not added to the AI Assistant modal's mode picker** — it remains a backend-only mode. It exists in the mode registry purely to (a) share the prompt-loading machinery and (b) back the Settings prompt-editor key with a real config.

**Rationale:**
- **One prompt-loading truth.** All prompt `.md` files load through the same cache and the same fallback order. No second code path to keep in sync.
- **No phantom keys.** The Settings prompt editor's `vision_describe` entry is now backed by a real mode config and a real default `.md`, instead of being silently ignored.
- **Users can still override the describe prompt** via their prompt preset, the same way they override `script` or `lore_entry` — no special UI for vision prompt editing.
- **Non-destructive to the modal.** The assistant modal's mode list is a separate concern (driven by what the modal offers), so adding a backend mode does not clutter the user-facing picker.

**Trade-off:** A `AiAssistantMode` value that isn't reachable from the assistant modal — mildly counterintuitive for a reader of the mode union. Mitigated by a comment in `MODE_CONFIGS` stating explicitly that it is backend-only. Considered alternatives (a separate `PromptResolvableMode` type for backend modes; a flag on the config) and rejected as over-engineering for a single case.

**Related:** This ADR covers prompt-resolution unification only. The three-path vision gate (native vision / describe-fallback / `VisionNotSupportedError`) and the skip-if-described caching rule are documented in [Vision and Attachment Pipeline](./backend.md#vision-and-attachment-pipeline), not part of this decision. `vision_describe` is a Case A (stateless) feature in the taxonomy of [Adding a feature](../guides/adding-a-feature.md) — the result is returned to the caller, not persisted and not injected into future prompts.

---

## AD-018: Bind-First Loading Placeholder for Server Startup

**Context:** All initialization (DB open, 32 migrations, 56MB tokenizer warmup, service wiring) ran BEFORE `Bun.serve()`, leaving port 8787 unreachable for 2–7 seconds after launch. Users saw "connection refused" in their browser during this window.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|---------|
| **Status quo** | Init everything, then `Bun.serve()` last | 2–7s of "connection refused" on every launch |
| **`server.reload()`** | Bind with placeholder, swap via Bun's built-in `reload()` API | Reported bugs in `reload()` (see effect-start's `BunServer.ts`); designed for `routes` + `fetch` together, overkill for a handler-only swap |
| **Mutable closure** | `let fetchHandler = placeholder; /* init */ fetchHandler = app.fetch` | Pure JS, no API surface, atomic swap |

**Decision:** Mutable closure pattern. `Bun.serve()` is called immediately with a loading placeholder handler from `loading-placeholder.ts`. After all init completes, the `fetchHandler` variable is reassigned to `app.fetch`. The next request sees the real Hono app.

**Rationale:**
- **Port reachable in milliseconds** — the user's browser gets a branded "Vibe Tavern is loading…" page instead of "connection refused" during the entire init window
- **Auto-refresh** — the loading page polls `/health` every 1s (503 → 200) and reloads into the real SPA when the server is ready
- **API clients get structured feedback** — `/health` and `/api/*` return 503 with `Retry-After: 2` during startup, so programmatic clients can retry with backoff instead of guessing
- **Graceful failure** — if init fails, the handler is swapped to a static 500 error page. The process stays alive so the user can read the error; Ctrl+C still exits cleanly
- **Zero API surface** — the mutable closure is plain JavaScript. No dependency on `server.reload()`, no risk of Bun type-parameter issues, no framework coupling
- **Single-file change** — the entire pattern lives in `server-runtime.ts` + `loading-placeholder.ts`. No changes to the Hono app, routes, adapters, or any other module

**Trade-off:** During the init window (2–7s), all requests are served by the placeholder handler — no API functionality. This is acceptable because the user's browser is showing a loading page and API clients receive structured 503s with retry guidance.

**Implementation:** See [Backend Architecture — Entry Points](./backend.md#entry-points) for the full two-phase bootstrap sequence.

**Related:** AD-011 (Single-Process Architecture) — this ADR refines the cold-start characteristic by splitting "port available" (milliseconds) from "fully operational" (2–7s).

---

## AD-019: Protocol Registry over Switch-Ladders for Provider Knowledge

**Context:** Per-protocol knowledge was scattered across four sites that had to be edited in lock-step by hand:

1. `mapProfileToSdkModel` — a 7-arm `switch (providerType)` returning the AI SDK model
2. `PROVIDER_CAPABILITIES` — a separate capability-flag map keyed by type
3. `provider-gateway` — `switch` ladders for probe / test-chat / list-models
4. `SAMPLER_SETS` — a separate per-protocol sampler-surface lookup

Adding a native provider (e.g. Vertex AI) meant touching all four sites and keeping their `ProviderType` cases consistent. Capability/protocol mismatches were easy to introduce silently, and the duplication made the provider layer the single biggest obstacle to Novel Mode's text-completion axis.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|--------|
| **Status quo** | Keep the four switch sites, add a fifth for `textCompletion` | Lock-step edits; silent drift; every new protocol multiplies the surface |
| **Strategy/enum per axis** | Separate registry per concern (capabilities, model, ops, samplers) | Four registries to keep in sync — same problem, relocated |
| **One `ProtocolAdapter` per type** | A single object per `ProviderType` carrying capabilities + model resolution + limitations + probe/test/list | One edit site; the adapter is the protocol's complete description |

**Decision:** One `ProtocolAdapter` object per `ProviderType`, registered in an exhaustive `Record<ProviderType, ProtocolAdapter>` in `domain/providers/protocol-registry.ts`. `resolveProtocol(type)` is the single lookup. The gateway is a thin delegator. The legacy `mapProfileToSdkModel` / `PROVIDER_CAPABILITIES` compat shims that initially bridged callers during the registry rollout have since been deleted (T3, 2026-06); all callers now go through `resolveProtocol()` directly.

**Rationale:**
- **One-site edits** — adding a native protocol is one object entry + one `protocols` record line, not a four-site lock-step edit
- **Compile-time exhaustiveness** — the `Record<ProviderType, ProtocolAdapter>` is exhaustive over the union; a new `PROVIDER_TYPE` without an adapter is a type error, not a silent fallthrough
- **Colocation** — a protocol's capabilities, model resolution, limitations, and HTTP ops sit together; nothing about one protocol is spread across files
- **Gateway stays thin** — `provider-gateway.ts` only normalizes the preset and dispatches; per-protocol HTTP shapes live in the registry, not in a switch
- **Forward-looking axis** — the `textCompletion` capability flag is present on every adapter (default `false`) and is the sole switch needed to opt a protocol into Novel Mode's flat-prompt assembler (plan §5.3.3)

**Trade-off:** One intentional switch remains: per-protocol sampler *wire serialization* in `buildSamplerConfig` (`infrastructure/ai/sampler-mapper.ts`). Native parameter names genuinely differ per protocol (`repeat_penalty` vs `repetition_penalty`, `typical` vs `typical_p`, etc.), so this is legitimate per-protocol logic, not a registry candidate. Capability *gating* is registry-driven (`SAMPLER_SETS`); only the wire *names* are switched.

**Implementation:** See [Adding a new AI provider](../guides/adding-a-provider.md) and [Backend Architecture — AI Execution Layer](./backend.md#ai-execution-layer).

**Related:** AD-020 (Feature-Sliced Layout) — the registry lives in `domain/providers/`, with the generation pipeline in `infrastructure/ai/` depending on it one-way.

---

## AD-020: Feature-Sliced Layout for the Backend Source Tree

**Context:** `services/api/src/` had accumulated ~20 folders and loose files at the root — `ai/`, `routes/`, `adapters/`, `session/`, `chat/`, `prompt/`, `providers/`, `ai-assistant/`, `lorebook/`, `scripts-engine/`, `errors/`, plus loose `asset-service.ts`, `mobile-access-*.ts`, `runtime-api-adapter.ts`. Placement was ad-hoc: some folders were technical layers (`routes/`, `adapters/`), some were features (`chat/`, `lorebook/`), some were mixed. There was no reliable answer to "where do I look / where does this go?", so agent navigation required memorizing incidental history.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|--------|
| **Status quo** | Flat root with mixed technical/feature folders | No navigation heuristic; agents grep instead of navigate |
| **Technical layering (MVC)** | `controllers/`, `services/`, `models/`, `views/` | Forces cross-cutting features into separate folders; a single feature touches 3+ dirs |
| **Feature-sliced by agent question** | Folders answer "what am I doing?" — adding a feature → `domain/`; wiring endpoints → `api/`; transport → `infrastructure/` | One more migration; but each slice has a single clear responsibility |

**Decision:** Six slices, each answering a distinct question:

| Slice | Question it answers | Contents |
|-------|---------------------|----------|
| `domain/` | "I'm adding/changing a feature" | `chat/`, `prompt/`, `providers/`, `character/`, `persona/`, `lorebook/`, `scripts-engine/`, `ai-assistant/`, `asset/`, `mobile-access/` |
| `infrastructure/` | "How does it talk to the outside world?" | `ai/` (generation pipeline: executors, sampler wiring, tokenizer, vision) |
| `api/` | "How is it exposed over HTTP?" | `routes/`, `adapters/`, `contract/` (the `RuntimeApi` interface + session types) |
| `runtime/` | "How is it all wired together at boot?" | `session/` (the composition root: `SessionRuntime` + sub-runtimes) |
| `server/` | "How does it start?" | `server-runtime.ts`, entry points |
| `shared/` | "What's cross-cutting?" | `errors/`, logging, shared utilities |

Dependencies flow strictly downward: `api/` → `runtime/` → `domain/` → `infrastructure/` → `shared/`, and `domain/providers/` ← `infrastructure/ai/` (never reversed). The central API contract (`RuntimeApi` + session types) is colocated with the routes under `api/contract/`.

**Rationale:**
- **Navigation-first** — an agent (or human) can pick the slice from the task: a feature goes in `domain/`, an endpoint in `api/`, transport details in `infrastructure/`
- **Single responsibility per slice** — no folder is simultaneously a technical layer and a feature bucket
- **Isolated composition root** — the only place that wires everything together is `runtime/session/`, so bootstrap dependencies are auditable in one place
- **Contract colocated with consumers** — `api/contract/` sits beside the routes that implement it and the adapters that consume it
- **Mirrors AD-006 at a finer grain** — the same strict-downward-dependency principle that governs the monorepo packages now governs the backend folders

**Trade-off:** Import paths are longer and a one-time migration churn touched every backend file. A handful of compat shims (TD-006) carry old names so call sites migrate incrementally. The navigation payoff outweighs the path verbosity: the folder name now predicts the file's role.

**Implementation:** See [Backend Architecture](./backend.md) for the per-slice contents. (The original folder-move migration map lived in `CODE_REVIEW_REFACTOR_PLAN.md` §5.2, now archived in the planning repo.)

**Related:** AD-006 (Monorepo with Strict Package Boundaries) — same strict-dependency principle, applied at the folder level within `services/api`. AD-019 (Protocol Registry) — the registry/generation split between `domain/providers/` and `infrastructure/ai/` is a direct instance of this layout.

---

## AD-021: Locale Registry over Scattered Type Literals for i18n

**Context:** The `Locale` type was a hardcoded `"en" | "ru"` literal union defined in `i18n/context.tsx` and re-stated — as the same literal, as an inline `as 'en' | 'ru'` cast, or as an inline options array — across seven consumer files: the type definition, the module-level helpers, `detectLocale()` in `main.tsx`, the `setLocale` cast in `AppShell.tsx`, both language selectors (`TweaksPanel`, `MobileSettings`), and the `lang` default in `local-storage.ts`. Adding a language meant finding and editing all seven by hand, and the duplication made it easy to forget a site (a selector that doesn't list the new language, a cast that rejects its value, a detection branch that never selects it). This was the exact problem the theme system had before `themes/registry.ts` consolidated it.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|--------|
| **Status quo** | Keep the scattered `"en" \| "ru"` literals; edit 7 files per language | Lock-step edits; silent drift; a forgotten site ships a half-working language |
| **Enum / config object per concern** | Separate config for selectors, detection, defaults | Three configs to keep in sync — same problem, relocated |
| **One `LOCALES` registry array** | A single array of `{ id, label, match? }` entries; `Locale` type derived from it; detection + normalization + selectors all read from it | One edit site; everything else derives automatically |

**Decision:** Create `apps/web/src/i18n/registry.ts` as the single source of truth, mirroring `themes/registry.ts`. It exports a `LOCALES: readonly LocaleDef[]` array and derives `Locale`, `DEFAULT_LOCALE`, `isLocale()`, `normalizeLocale()`, and `detectBrowserLocale()` from it. `LocaleProvider` loads the matching JSON dynamically (`import(`./locales/${locale}.json`)`), so it needs no change — the registry is purely a compile-time + UI concern, the strings are still loaded on demand at runtime. All seven consumer sites now import from the registry instead of restating the literal.

**Rationale:**
- **One-site edits** — adding a language is one JSON file + one `LOCALES` entry, parallel to how themes work; no consumer file needs editing because selectors iterate `LOCALES`, detection uses `detectBrowserLocale`, and casts go through `normalizeLocale`
- **Type derived, not declared** — `Locale = (typeof LOCALES)[number]["id"]`, so the union tracks the array; a language in the array without a JSON file is a runtime load error, not a silent type gap
- **Breaks an import cycle** — `locale-helpers.ts` previously imported `Locale` from `context.tsx` (a React module); it now imports from the plain `registry.ts`, removing a type-only dependency on a Fast Refresh boundary
- **Mirrors a proven pattern** — the theme registry solved the identical shape of problem and has held up across four themes; reusing it keeps the codebase's "how do I add a thing" answer uniform

**Trade-off:** Pre-React and pre-SPA surfaces (the server boot placeholder in `loading-placeholder.ts`, the first-paint splash in `index.html`) cannot read the registry — they run before the bundle parses, and the i18n JSON is loaded by React at runtime, not available as a static string. This means any user-visible text on those surfaces would need to be duplicated inline and hand-synced per language. The chosen resolution is to ship **no text** on those surfaces (logo only) so there is nothing to sync — see the loading placeholder's doc comment. This is the one place where adding a language does not "just work" automatically, and it is documented as such in the adding-a-language guide rather than papered over.

**Implementation:** See [Adding a new language](../guides/adding-a-language.md). The registry lives at `apps/web/src/i18n/registry.ts`; translations at `apps/web/src/i18n/locales/<id>.json`.

**Related:** AD-021's theme counterpart is implicit — there is no ADR for the theme registry (it predates the decisions log), but `themes/registry.ts` is the direct template. AD-022 (Flexible Layouts over Fixed Widths) covers the layout half of i18n.

---

## AD-022: Flexible Layouts over Fixed Widths for Translated Text

**Context:** The UI ships in English and Russian, with Russian text running roughly 20–30% longer than English for the same meaning — compound words, longer affixes, and unabbreviable grammatical forms (e.g. "настройки" vs "settings", "продолжить историю" vs "continue the story"). Any container sized to the English string — a fixed `w-[110px]` dropdown, a `min-w` button, a two-word-per-line segment control — clips, wraps ugly, or overflows in Russian. This is not a translation problem; it is a layout problem that every language addition will surface in a different shape (German compounds, French articles, etc.). Before this decision it was addressed ad hoc, container by container, which meant each new string was a latent layout bug waiting for a non-English locale.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|--------|
| **Fixed widths sized to the longest locale** | Measure Russian, hardcode that width | Brittle; re-breaks on the next language; widths balloon for short strings |
| **Truncation / ellipsis everywhere** | `truncate` on all text containers | Hides meaning; unacceptable for labels, buttons, settings |
| **Flexible, content-driven sizing** | Let text define the width; reserve space with `min-w` only where a control needs a hit target, not to fit copy | Containers grow with content; works for any language without per-locale tuning |

**Decision:** Layout must be **content-driven, not copy-driven**. The rules, enforced by review (there is no linter for this):
- No fixed pixel/`ch` widths on elements whose text comes from i18n keys — let `w-auto` / `flex` / `inline-flex` size to content.
- `min-w` is allowed only to guarantee a click/tap target (e.g. a 40px button height/width), never to fit a specific string.
- `max-w` with `truncate` is allowed only for genuinely unbounded content (user input, message bodies, entity names), never for fixed UI labels.
- Flex/grid gaps and `justify-between` must not assume a label's rendered width — pair a label with a control via `flex` + `gap`, not by pixel-padding the label.

**Rationale:**
- **Scales to N languages, not just the current two** — a flexible layout that survives Russian (the longest current locale) also survives German compounds or French expanded forms without re-measuring every container
- **Catches at write time, not translate time** — if a layout depends on a fixed width, the bug only appears when a translator fills in a longer string, often after the feature ships; content-driven sizing makes the layout locale-agnostic from the first commit
- **Consistent with the theme strategy** — themes declare tokens and let consumers consume them without hardcoding values; i18n declares strings and lets layouts consume them without hardcoding widths; same principle (AD-021, AD-019)

**Trade-off:** Content-driven sizing can produce minor visual jitter when switching languages (a button that's 110px in English becomes 140px in Russian). This is accepted and preferable to clipping. Where visual stability matters (e.g. a row of equal-width segment controls), size all siblings to the widest via `flex-1` so they grow together, rather than pinning one to a fixed width.

**Verification requirement:** Any change touching UI text containers must be checked at mobile width in both `en` and `ru` before merge — Russian's 20–30% length delta surfaces most reliably in the narrow viewport. Use the Playwright MCP server (`browser_resize` to mobile, then `browser_snapshot`) for this, or `bun run dev:web` with the viewport toggled.

**Implementation:** See [Adding a new language — Layout & text length](../guides/adding-a-language.md#layout--text-length). The concrete do/don't examples live there.

**Related:** AD-021 (Locale Registry) — the architecture half of i18n; this is the layout half. Together they are the full "add a language" story.

---

## AD-023: Shared Wire-DTO Contracts in `api-contracts`

**Status:** Implemented (commit `686ccd06`, 2026-06).

**Context:** The wire-format DTOs that cross the HTTP boundary — what the backend serializes and what the frontend deserializes — were re-declared on each side. `services/api/src/runtime/session/session-runtime-dto.ts`, `domain/persona/persona-runtime.ts`, and `api/contract/session-types.ts` defined the backend shapes; `apps/web/src/api/types.ts` re-stated them independently. Two declarations for one wire format is a silent-drift trap: a field added on one side (or, as actually happened, a field present in the domain model, DB column, Zod schema, and backend logic but omitted from the wire interface and its mapper) never reaches the other side, and nothing compiles to warn you. The `bindPerModel` round-trip bug — the "Bind per model" toggle silently resetting to off on every modal open — was exactly this failure mode.

**Options considered:**

| Approach | Description | Problem |
|----------|-------------|--------|
| **Status quo (re-declare on each side)** | Backend and frontend each define their own interface for the same wire shape | Silent drift; a field present in the DB/logic but absent from the wire interface ships undetected (the `bindPerModel` bug) |
| **Generate from Zod** | Derive wire types from the Zod request/response schemas | The wire DTOs are security projections (e.g. `apiKey` → `hasStoredApiKey`), not 1:1 with any single Zod schema; generation would need a projection layer |
| **Shared interfaces in `api-contracts`** | One interface per wire shape, imported by both sides; backend re-exports from its existing modules so importer paths don't change | Drift becomes a compile error; no codegen; re-export keeps the blast radius to zero |

**Decision:** The wire-DTO interfaces live once in `packages/api-contracts/src/wire-types.ts`. The backend modules that previously defined them (`session-runtime-dto.ts`, `persona-runtime.ts`, `session-types.ts`) now `import type` + `export type` re-export from `api-contracts`, so existing backend importers need no path change. The frontend `apps/web/src/api/types.ts` does the same, keeping two local aliases (`ProviderProfileRecord = ClientProviderProfileRecord`, `CachedModelsRecord = CachedProviderModelsRecord`) to avoid churn at the many call sites that use the short names.

The **mapper functions stay backend-side.** They depend on `@vibe-tavern/db` (and `bun:sqlite` transitively); moving them into `api-contracts` would drag the database driver into the frontend's dependency graph and regress the browser-safety split (AD for the codecs split). The interface is shared; the code that builds it is not.

**Rationale:**
- **Drift is a compile error, not a runtime bug.** Adding a field to the shared interface forces both the backend mapper and the frontend consumer to acknowledge it in the same PR.
- **No code generation.** The interfaces are hand-written because they are security projections (what the client is allowed to see), not mechanical projections of a DB row or a Zod schema.
- **Zero blast radius on the backend.** Re-exporting from the existing module paths means the move touched three definition sites + the mapper, not every importer.
- **Extends AD-006 and AD-009.** AD-006 (monorepo boundaries) already makes `api-contracts` the shared contract package; AD-009 (Hono RPC client) gives type-safe routing. This ADR closes the gap for response *body* shapes that the Hono client doesn't infer (streaming endpoints, security-projected records).

**Trade-off:** `api-contracts` now depends on `@vibe-tavern/domain` (for branded IDs like `CharacterId` in `ChatListItem`). This is fine — `domain` is the zero-dep leaf, so the dependency edge points strictly downward and stays browser-safe. The frontend also gains a direct dep on `api-contracts` (it previously reached the package only transitively); this is the intended sharing surface.

**Scope:** Six interfaces moved: `ClientProviderProfileRecord`, `CachedProviderModelsRecord`, `FavoriteProviderModelRecord`, `ProviderModelSettingsRecord`, `PersonaRecord`, `ChatListItem`. The mapper functions (`toClientProviderProfile`, `mapMessageDto`, etc.) are intentionally NOT in `api-contracts`.

**Related:** AD-006 (Monorepo with Strict Package Boundaries) — the package this lives in. AD-009 (Hono RPC Client) — type-safe routing for the paths this doesn't cover. The `bindPerModel` bug this prevents is pinned by a regression test in `services/api/test/session-runtime-dto.test.ts`.
