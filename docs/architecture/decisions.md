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

**Context:** Code is split across 7 packages with one-directional dependencies.

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

**Decision:** Zustand with Immer for immutable updates and Reselect for memoized selectors.

**Rationale:**
- **No boilerplate** — no actions, reducers, dispatchers, providers, or middleware. `create((set, get) => ({ ... }))` is the entire API.
- **No context** — Zustand stores are plain JS modules. No `<Provider>` wrapping. Store updates don't trigger React re-renders unless the subscribed slice actually changes.
- **External store compatibility** — `useSyncExternalStore` integration means React treats Zustand like any other external data source.
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
- **Cold start** — <1 second to fully operational. No container orchestration, no health checks.

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

## AD-013: Junction Table for Lorebook Links

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
