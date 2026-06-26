# Frontend Architecture

> **apps/web** — React 19 SPA. Communicates exclusively via HTTP API. No server state in the browser.

---

## Data Layer

### Store Architecture

The frontend uses **Zustand as single source of truth**. No React Query, no SWR, no Apollo. The backend sends snapshots; the frontend normalizes them into Zustand stores via `ingestSnapshot()`.

`ingestSnapshot()` uses Immer's structural sharing — it only replaces object references for fields that actually changed. Components subscribe to focused slices via selectors and only re-render when their specific data changes.

**Absence preservation (Phase 3.4.1, shipped):** the pipeline is `backend → normalizeSnapshot() → ingestSnapshot()`. `AppSnapshot`'s fields are all optional, and `normalizeSnapshot()` (`api/normalize.ts`) passes absent fields through untouched (no absent→`[]`/`{}` coercion). `ingestSnapshot()` then uses presence guards (`"x" in snapshot` / `Array.isArray`) so an absent field leaves the store untouched rather than wiping it. This is what makes endpoint-scoped responses (AD-016) safe on the frontend: a `PATCH /characters/:id` that returns only `{ character, contextPreview }` updates just those two fields and leaves the active chat's messages intact. `switchChatAction` / `createChatAction` call `clearMessages()` explicitly before ingesting, because non-message mutations can legitimately omit `messages`. (Backend `SessionSnapshot` stays all-required — it always returns full; the two types are decoupled by an `unwrapRpc<AppSnapshot>` cast.)

The stores split into three layers: **canonical backend-confirmed state**, **UI/runtime state**, and **per-feature caches**.

| Store | File | Responsibility |
|-------|------|----------------|
| `useSnapshotStore` | `stores/snapshot-store.ts` | **Canonical backend-confirmed state.** Chats by ID, messages by ID, message order, active chat/character/persona/branch, summaries, the latest prompt trace. This is the "database" of the frontend. |
| `useChatStore` | `stores/chat-store.ts` | Per-chat generation state, active chat ID, draft text + draft attachments, editing state, selected trace ID, action spinners (`messageActionId`). See [Streaming Architecture](#streaming-architecture). |
| `useGenerationQueueStore` | `stores/generation-queue-store.ts` | Per-chat sequential regeneration queue — the ordered list of enqueued "generate more" jobs and their per-job status. See [Generation Queue](#generation-queue). |
| `useTraceHistoryStore` | `stores/trace-history-store.ts` | Branch-scoped prompt-trace history cache, lazy-loaded via `GET /api/chats/:chatId/traces` and keyed by `${chatId}::${branchId}`. Replaces the `promptTraceHistory` field that used to ship in every snapshot. |
| `useGalleryStore` | `stores/gallery-store.ts` | Per-character media-gallery cache (UI/cache, not canonical — the server owns the gallery). See [Media Gallery](#media-gallery). |
| `useProviderDataStore` | `stores/provider-data-store.ts` | Provider profiles, favorite models per profile. |
| `useCharacterStore` | `stores/character-store.ts` | Build-mode UI state, rename/confirm-destroy dialogs. |
| `useNavigationStore` | `stores/navigation-store.ts` | Theme, mode (chat/build/play), sidebar/rail state. |
| `useProviderStore` | `stores/provider-store.ts` | Connection test UI state. |
| `useModalStore` | `stores/modal-store.ts` | Modal open/close state. |

Bootstrap reference data (prompt presets, personas, first-run/loading state) lives in the action module `stores/api-actions/bootstrap-actions.ts`, not a dedicated store.

**Key pattern:** `useSnapshotStore.ingestSnapshot(snapshot)` is the single entry point for backend data. API actions (`stores/api-actions/*.ts`) call the backend, receive a snapshot or partial response, and write it through this method. No individual `setState` calls for server data.

### Selectors

Components subscribe to **focused slices**, never the entire snapshot.

Canonical selectors live in `stores/snapshot-store.ts`: `useChatList()`, `useOrderedMessages()`, `useMessage(id)`, `useActiveCharacter()`, `useActivePersona()`, `useBranches()`, `useAllCharacters()`, `usePromptTrace()`.

Streaming-target selectors live in `stores/chat-selectors.ts`:
- **`useIsStreamingTarget(messageId)`** — `true` if `streamingMessageId === messageId` for the active chat's generation. This is how a `MessageBlock` decides whether to render live streaming text instead of its stored content (regeneration path).
- **`useStreamingRevealedFor(messageId)`** — the throttled-reveal view of the streaming text for that message (see [Streaming Architecture](#streaming-architecture)).
- `useMessageAuthor()`, `useActiveTrace(traceId)`.

`chat-selectors.ts` also carries a few **`@deprecated`** wrappers (`useDisplayMessage`, `useMessageOrder`, `useChatMeta`, `useMacroContext`) that delegate to the snapshot store; new code reads the snapshot-store selectors directly.

### Selector rules

1. Never return freshly allocated objects from selectors without memoization (`useShallow` or `useMemo`).
2. Effects that write to Zustand must use primitive dependencies and equality guards.
3. `AppShell` does NOT receive a large `snapshot` prop — it reads exact fields from stores.

---

## Message List (`MessageList.tsx`)

### Virtualization with react-virtuoso

The message list uses `<Virtuoso>` with:
- `followOutput="smooth"` — auto-scrolls when new messages arrive
- `initialTopMostItemIndex` — starts at the bottom on load
- `overscan={5}` — renders 5 items above/below viewport for smooth scrolling
- Dynamic height measurement built-in (no manual `estimateSize`)
- `Footer` component renders `StreamingContent` (pending user message + live streaming reply)

The scroller element is marked with `data-virtuoso-scroller="true"` for external access (bottom-pinning logic in `MessageBlock`).

### Ghost Message Prevention

**Problem:** When the user sends a message, the optimistic UI appends a pending user message immediately. When the backend responds with the confirmed snapshot, it includes the persisted user message. Without deduplication, the same message appears twice.

**Solution:** `MessageList.tsx` filters the message order before rendering:

```
If activeGen.pendingUserMessageContent exists:
  Find the last user message in the order
  If its content matches pendingUserMessageContent exactly:
    Remove it from the rendered list
```

The pending message is shown via Virtuoso's `Footer` component instead, which renders `StreamingContent`. This ensures exactly one copy is visible at all times — the pending one during streaming, the confirmed one after the snapshot arrives.

---

## Message Block (`MessageBlock.tsx`)

The core chat message component. Wrapped in `React.memo` — re-renders only when `useDisplayMessage(messageId)` returns a different value.

### Component Structure

```
MessageBlock (memo)
├── Separator (between messages of same role)
├── VariantControlsOverlay (portal, desktop only)
├── Message layout
│   ├── Header (avatar, name, greeting counter)
│   ├── Content area
│   │   ├── Desktop: AnimatePresence variant slide
│   │   └── Mobile: MobileVariantCarousel (3-panel drag)
│   ├── MessageReasoning (collapsible thinking block)
│   ├── MessageMetadata (token count, model, timestamp)
│   └── Actions
│       ├── Desktop: DesktopMessageActions (hover-reveal)
│       └── Mobile: MobileMessageActions (three-dot menu)
└── Editing mode (AutoTextarea replacement)
```

### Variant System

Messages support **multiple variants** (swipes). Each variant has its own `content` and optional `reasoning`.

- `selectedVariantIndex` — which variant is currently displayed (stored in snapshot store)
- `variants[]` — all variant contents with macros resolved
- The server sets `message.content = selected variant's content` at load time
- Client-side switching only changes `selectedVariantIndex` — no server round-trip

**Swipe direction** is tracked via a ref (`directionRef`) that updates when `selectedVariantIndex` or `greetingIndex` changes. This drives the slide animation direction.

### Desktop Variant Controls — Portal Overlay

**Problem:** When switching variants, the message height changes. If the message shrinks, the variant control arrows drift away from the cursor. If it grows, Virtuoso recalculates layout and the action row jumps.

**Solution — two-part fix:**

1. **`VariantControlsOverlay` via `createPortal`** — when the user clicks a variant arrow:
   - Capture the arrow's bounding rect
   - Render a fixed-position clone of the controls at those exact coordinates via `createPortal(document.body)`
   - The original controls are hidden (`hiddenVariantControls` prop)
   - After 450ms (animation window), the portal overlay fades out and original controls reappear
   - This keeps the clickable arrows fixed under the cursor regardless of layout shifts

2. **Bottom-pinning via `requestAnimationFrame`** — `pinVirtuosoToBottomDuringVariantSwitch()`:
   - Runs a 900ms rAF loop that forces `scrollTop = scrollHeight` on the Virtuoso scroller
   - Prevents Virtuoso from adjusting scroll position during the spring animation
   - One final pin after the window expires
   - Combined with the portal overlay, keeps controls and cursor aligned

> ⚠️ **FRAGILE — DO NOT SIMPLIFY** without manually testing both directions (long→short and short→long variants) at the bottom of a chat.

### Mobile Variant Carousel (`MobileVariantCarousel`)

A **true 3-panel carousel** for switching variants on mobile via horizontal drag.

**Why a carousel (not gesture-to-slide):** A true carousel renders previous/current/next panels side-by-side. The content follows the finger during drag. This feels premium and native. Gesture-to-slide (where the current panel slides out and the next slides in after a threshold) feels cheaper because the content isn't visible during the gesture.

**Architecture:**

```
motion.div (viewport, overflow: hidden, height: locked)
└── motion.div (track, width: 300%, flex, items-start)
    ├── Panel 1: previous variant (w-1/3)
    ├── Panel 2: current variant  (w-1/3, ref for height measurement)
    └── Panel 3: next variant     (w-1/3)
```

**Key details:**

- **`items-start` on the track** — CRITICAL. Default flex stretch forces all panels to the tallest panel's height. `items-start` lets each panel be its natural height, which is needed for correct current-panel height measurement.
- **Height management:** The viewport height is locked to the current panel's measured height via `ResizeObserver`. After a swipe commits, the height smoothly transitions (`transition: height 180ms ease`) to the new panel's height.
- **Drag handling:** `drag="x"` with `dragDirectionLock` — Framer only captures the gesture once horizontal movement wins. CSS `touchAction: "pan-y"` leaves normal vertical scrolling to the browser.
- **Snap logic:** `handleDragEnd` checks threshold (22% of viewport width, min 55px, max 120px) OR velocity (>650px/s). If neither threshold is met, snaps back to center via spring animation.
- **Commit flow:** After animation completes (`.then()`), calls `onSelectVariant(targetIndex, direction)`, then instantly resets track position (`controls.set({ x: -viewportWidth })`) for the next swipe.

**Greeting carousel:** The same `MobileVariantCarousel` is reused for greeting messages, which use `greetingCarouselVariants` (array of `{ content }` objects built from `alternateGreetings`).

### Markdown Rendering

`apps/web/src/lib/markdown.tsx` renders chat content through `react-markdown`, `remark-gfm`, and a custom `rehypeQuotedText` pass.

Quoted dialogue highlighting deliberately works on the HAST tree instead of raw strings:

- The plugin starts at the `root` node so paragraphs and nested inline elements are scanned.
- It flattens text across inline children (`em`, `strong`, links, spans, etc.) and wraps only the exact matched character range in `<span class="quoted-text">`.
- It supports straight quotes (`"..."`) and curly quotes (`“...”`).
- Inline `code` and `pre` are barriers: quote marks inside code are left untouched, while quoted text before/after code can still highlight.
- Text nodes are sliced and inline elements are cloned as needed, so emphasis/bold inside quoted dialogue is preserved without over-highlighting entire paragraphs.

### Extracted Sub-Components

`MessageBlock` extracts several module-scope components to keep the main function manageable:

| Component | Purpose |
|-----------|---------|
| `GenerationDots` | Animated typing dots for streaming state |
| `MessageMetadata` | Token count, model ID, timestamp display |
| `DesktopMessageActions` | Hover-reveal action bar: copy, edit, branch, regenerate, delete, variant arrows |
| `MobileMessageActions` | Three-dot menu with action items: copy, edit, branch, resend, regenerate, variant counter |
| `MobileVariantCarousel` | 3-panel drag carousel (see above) |
| `VariantControls` | Arrow buttons for variant switching (used both inline and in the portal overlay) |
| `VariantJumpList` | Dropdown jump-list for hopping between many variants at once |
| `PendingUserMessage` / `PendingAssistantMessage` | The optimistic/streaming footer cells rendered via Virtuoso's `Footer` (`StreamingContent`) |

---

## Streaming Architecture

The streaming layer separates three concerns that used to be conflated: **which message is being streamed to** (`streamingMessageId`), **what action is pending on a message** (`messageActionId` — edit/delete/regenerate spinners), and **how fast to reveal streamed text** (`StreamingReveal`).

### Generation state is per-chat

`useChatStore` holds `generations: Record<chatId, ChatGenerationState>`, not a single global generation. This lets background generations in one chat keep streaming while the user works in another. `getOrCreateGen(chatId)` is the accessor; `useActiveGeneration()` returns the active chat's generation state (or null).

```ts
interface ChatGenerationState {
  isSending: boolean;
  streamingMessageId: string | null;   // which message the stream targets (see below)
  streamingText: string;                // full accumulated text so far
  streamingRevealedText: string;        // throttled view fed to the UI
  streamingReasoningText: string;
  generationStatus: ChatGenerationStatus;
  pendingUserMessageContent: string | null;
  pendingUserMessageAttachments: Attachment[];
  abortController: AbortController | null;
}
```

`ChatGenerationStatus` is a small state machine: `idle → preparing → streaming → (waiting_full) → idle`, with `aborting → cancelled` and `→ failed` as terminal branches. It drives the UI status badge in the input area.

### `streamingMessageId` vs `messageActionId`

These are deliberately separate so a future sequential queue can hold long-lived streaming state without it rendering as a transient action spinner:

| Field | Meaning | Read by |
|-------|---------|---------|
| `streamingMessageId` | The **existing** message the stream targets (regenerate path), or `null` for a fresh send that streams into the pending-assistant singleton | `useIsStreamingTarget(id)` → `MessageBlock` swaps in live streaming text |
| `messageActionId` | Which message has an **action spinner** pending (edit/delete/regenerate in flight) | action-row loading states |

### StreamingReveal — adaptive text reveal

Raw SSE `text-delta` chunks can arrive faster than the DOM can paint. `StreamingReveal` (`lib/streaming-reveal.ts`) is created per generation and throttles how much of `streamingText` is actually shown (`streamingRevealedText`):

- It schedules reveals on a ~16ms tick and tracks the backlog (target length − shown length).
- **Small backlog (<80 chars):** reveal immediately, char-by-char.
- **Medium (400–1200):** reveal in larger steps to catch up.
- **Large (>1200):** snap forward aggressively so the UI never lags far behind a fast stream.

When generation ends, `flush()` drains the remainder before the final snapshot is ingested, so the persisted message is never truncated to the revealed-so-far slice. `useStreamingRevealedFor(messageId)` is the selector a `MessageBlock` uses to read its revealed slice.

### Generation flow

```
User sends message
  → startGeneration() sets pendingUserMessageContent + isSending
  → StreamingContent renders in Virtuoso Footer (pending user message + streaming reply)
  → SSE stream yields text-delta / reasoning-delta chunks
  → StreamingReveal.pushDelta() → streamingRevealedText updates on each tick
  → MessageBlock for the streaming-target message renders the revealed text inline
  → Stream finishes → flush() → backend returns snapshot → ingestSnapshot()
  → Ghost message filter prevents duplicate user message
  → StreamingContent disappears (generation becomes idle)
```

### Regeneration

For regenerate, `startGeneration` is called with a `streamingMessageId` pointing at the existing assistant message. Only that one `MessageBlock` (the one where `useIsStreamingTarget(id)` is true) swaps its stored content for the live streaming text; every other message renders normally. Previously this was driven by overloading `messageActionId === messageId`, which made every assistant message show as loading during a regen — the split above is the fix.

---

## Build Mode & Panel Registry

### Dynamic Tab Registration

Build Mode uses a registry pattern instead of hardcoded tabs:

```
registerBuildPanel(descriptor) → adds to registry
useBuildPanels() → React hook via useSyncExternalStore
```

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

`BuildMode.tsx` reads panels from the registry. `Sidebar.tsx` reads the same registry for navigation. New panels can be added by any module calling `registerBuildPanel()` — no modifications to BuildMode or Sidebar needed.

### Lorebook + Script Embedding

Scripts are **not** a separate build panel. The `useScriptPanel()` hook from `ScriptEditor.tsx` is embedded inside `LorebookEditor.tsx`:

```
LorebookEditor
├── Scope selector (character / persona / chat)
├── Tab bar: [Lorebooks] [Scripts]
├── "lorebooks" → accordion list → entry list → entry editor
└── "scripts" → useScriptPanel().scriptListContent / scriptEditorPanel
```

`ScriptEditor.tsx` exports a **hook** (`useScriptPanel`), not a component. The hook manages its own state and returns JSX fragments that `LorebookEditor` wires into its layout.

---

## Generation Queue

A per-chat **sequential regeneration queue** lets the user enqueue several "generate more" jobs without waiting. The queue lives in `useGenerationQueueStore` (the ordered job list + per-job status); the runner is `use-generation-queue.ts`, registered once in the app shell.

**Invariants:**
- Exactly one in-flight generation per chat. The pump pops the next pending job only after the current one resolves.
- The queue STATE is separate from the streaming seam: it asks "what is the queue's progress?", while `useChatStore.streamingMessageId` (above) answers "which message is streaming right now?". The runner writes streaming-target identity through `startGeneration`, the same path a manual regenerate uses.
- `enqueueGenerateMore` / `cancelQueueJob` / `clearQueuePending` are plain module-level functions any component can import; `QueueManager.tsx` (rendered in `PlayMode`/the chat footer) renders the queue's progress.

---

## Media Gallery

Each character can have a media gallery (images) used as vision/attachment context and surfaced in the Build editor. The gallery is server-owned; `useGalleryStore` is purely a UI/cache layer.

**Non-negotiable invariants:**
- Optimistic create/delete/reorder roll back on error + toast.
- `describe` (vision caption) is **not** optimistic — it tracks a per-image `describing` set and reloads when it resolves, because vision describe is slow and can fail per-image.
- `load` is idempotent (no-op if already loaded); `reload` forces.

The gallery-only toggles (`includeGalleryInPrompt`, `includeAvatarInPrompt`, `avatarDescription`) are character/persona fields and flow through the snapshot store via `updateCharacter`/`updatePersona` — **not** through `useGalleryStore`.

`GalleryViewer`, `GalleryAccordion`, `GalleryGrid`, and `GalleryLightbox` (Build editor) all share the zoom/pan interaction via the `useImageZoomPan` hook (`hooks/use-image-zoom-pan.ts`), extracted from a duplicated implementation across `GalleryViewer` and `AvatarPanel`.

---

## Prompt Trace History

Prompt traces used to ship in every `SessionSnapshot` (`promptTraceHistory`). They are now **lazy-loaded and branch-scoped**: `useTraceHistoryStore` caches traces keyed by `${chatId}::${branchId}`, fetched on demand via `GET /api/chats/:chatId/traces`.

Keying by branch is what fixes two trace defects: switching branches changes the key, so the fetcher pulls the new branch's traces rather than showing the previous branch's stale set (no explicit invalidation hook needed for fork/activate/delete — they all change `activeBranchId`, which changes the key). The single **latest** trace still lives on the snapshot store (`promptTrace`) so the post-generation badge lights up immediately without a refetch.

Build Mode's prev/next trace navigation indexes the cached branch-scoped list.

---

## Play Mode

`PlayMode.tsx` is the chat-focused layout (as opposed to Build Mode's editor layout). It composes `MessageList` + `QueueManager` + `InputArea`. The active mode (chat/build/play) lives in `useNavigationStore`.

A deliberate remount detail: `MessageList` is keyed by `${chatId}|${branchId}` so Virtuoso's `initialTopMostItemIndex` re-runs and pins to the bottom natively on chat/branch switch, rather than fighting Virtuoso's measurement cache with a manual rAF pin.

---

## Dev Tooling: ThemeTuner

`ThemeTuner` (`components/dev/ThemeTuner.tsx`) is a live, WYSIWYG theme-color workbench reachable only via the `#theme-tuner` URL hash (wired in `main.tsx`). It does **not** load the real app, so it needs no backend — it renders real markup-driven components plus faithful chrome replicas on the same Tailwind tokens, so what you see is exactly what a tuned theme produces. Intended for iterating on theme palettes, not for end users.

---

## i18n

Multi-language support is **registry-driven** via `i18n/registry.ts` (the `LOCALES` array) — currently `en`, `ru`. `LocaleProvider` (`i18n/context.tsx`) loads the active locale's JSON dynamically; the `useT()` hook returns the translation function. `getT()`/`getLocale()` (`i18n/locale-helpers.ts`) expose the last-known locale to non-React code.

Adding a language is a two-step change (JSON + one registry entry) — see [Adding a new language](../guides/adding-a-language.md). The architecture and the pre-React placeholder exception are in [AD-021](./decisions.md#ad-021-locale-registry-over-scattered-type-literals-for-i18n); the layout strategy for translated text is in [AD-022](./decisions.md#ad-022-flexible-layouts-over-fixed-widths-for-translated-text).

**Key consideration:** Russian text is 20–30% longer than English. Do **not** fix-width i18n strings (no `w-[…px]`/`w-[…ch]` on translated text); let containers size to content and use `min-w` only for tap targets. Prefer generous horizontal padding (`px-4` over `px-2`) and verify at mobile width. Full guidance in AD-022.

---

## Prompt Manager Modal (`PromptManagerModal.tsx`)

The advanced prompt editing surface. Opened from the top-bar preset dropdown. Renders `PromptOrderCanvas` when `advancedMode` is true.

### Data flow

```
AppShell
  ├── bootstrapData.promptPresets → promptPresets prop
  ├── activeChat.promptPresetId  → activePresetId prop
  ├── snapshotStore.activeCharacter → characterFields prop
  │
  └── PromptManagerModal
        ├── activePreset → draft state (useEffect on preset ID change)
        ├── draft.promptOrder → PromptOrderCanvas
        ├── draft.customInjections → PromptOrderCanvas
        ├── characterFields → CharacterCanvasDraft → PromptOrderCanvas
        │
        ├── handleSave → updatePromptPresetAction → refreshPresetsInBootstrap
        └── onCharacterFieldUpdate → key mapping → saveCharacterAction (partial patch)
```

### Draft management

The modal maintains a local `DraftData` state initialized from `activePreset`. On save, the full draft is serialized (`aiAssistantPrompts` → JSON string) and sent via `updatePromptPresetAction`. The action refreshes the bootstrap store so the preset list stays current.

### Character field updates

Character edits bypass the preset entirely. The `onCharacterFieldUpdate` callback:
1. Maps canvas keys (`charSystemPrompt`, `charPostHistory`, `charDepthPrompt`, `charDepthPromptDepth`, `charDepthPromptRole`) to API field names (`systemPrompt`, `postHistoryInstructions`, `depthPrompt`, `depthPromptDepth`, `depthPromptRole`).
2. Calls `saveCharacterAction` with a partial patch.
3. The snapshot ingestion updates `activeCharacter` in the store, which flows back to the canvas reactively.

---

---

## Mobile Detection

`useIsMobile()` hook — returns `true` for viewports below the mobile breakpoint. Used throughout `MessageBlock` to branch between desktop and mobile UI:

- Desktop: hover-reveal actions, portal overlay for variant controls, AnimatePresence slide
- Mobile: three-dot menu, MobileVariantCarousel, full-bleed layout

The component calls `useIsMobile()` after all other hooks but before the early return, so it doesn't violate React's rules of hooks.

---

## Setup Wizard & First-Run Flow

### Overview

The **Setup Wizard** (`SetupWizard.tsx`) is a modal overlay that guides new users through initial configuration. It appears automatically on fresh database installs (when `bootstrapData.isFirstRun === true`) and can be dismissed or re-invoked from the placeholder page.

### Two Paths

| Path | Steps | Purpose |
|------|-------|----------|
| **A — Manual** | Provider → Persona → Character | Step-by-step setup for new users |
| **B — Migration** | ST Import → Provider | Bulk-import from SillyTavern folder |

A top-level **PathSelector** screen lets the user choose. A "Skip all" link dismisses the wizard entirely.

### Step Architecture

Each step is a self-contained function component with `onComplete` and `onSkip` callbacks. The wizard shell (`SetupWizard`) manages path/step state and renders the appropriate component:

```
SetupWizard
├── header (title + StepIndicator for Path A)
├── PathSelector (choose path)
├── ProviderStep (form + test + model select)
├── PersonaStep (name, description, pronouns, avatar crop)
├── CharacterStep (create or import card)
└── StMigrationStep (bulk ST folder import)
```

### Provider Step

Uses the shared `ProviderForm` component (same as settings modal). Key behaviors:

- **Existing profile detection:** On mount, checks `providerProfiles[0]`. If found, starts in **collapsed view** (profile card + test hi + model selector).
- **Collapsed view:** Shows a compact card with preset label, "✓ Provider active" badge, "Edit" link, and a "Test Hi" button. "Next" transitions immediately.
- **Edit mode:** Full `ProviderForm` with test connection + model fetching. "Save" collapses and calls `onComplete`.
- **Back from next step:** Returns to collapsed view, not the full form.
- Model dropdown uses `ProviderModelSelector` which portals into `#modal-portal` to stay inside the Radix focus trap.

### Persona Step

- Pre-fills from existing persona (`defaultForNewChats` or first persona in bootstrap store)
- **Pronoun selector:** Pill buttons for none/he/she/they/it/custom
- **Avatar upload:** File picker → `AvatarCropModal` (circular crop) → cropped file uploaded via `uploadAsset` on save
- Saves via `createPersona` or `updatePersona` (supports `avatarAssetId`)

### Character Step

Two modes:
1. **Manual creation:** Name + description + first message + avatar crop. Uses `handleCreateCharacter(..., avatarFile)` which accepts the cropped avatar.
2. **Card import:** "Upload Card" button parses `.png`/`.json` via `extractPngMetadata` → `parseCharacterMetadata`, shows preview (avatar, name, description, tags) before importing.

### Placeholder Page

When `hasActiveSnapshot === false` and wizard is not visible, `AppShell` renders a centered placeholder with:
- "Welcome" heading
- "Create Character" button
- "Import Character" button (file picker)
- "Setup Wizard" / "Setup Provider" utility links

### Ghost Chat Prevention

When the last character is deleted, `deleteCharacterAction` clears both `activeChatId` and the snapshot store to prevent showing a stale "ghost" chat. The sidebar persona fallback reads from `bootstrapPersonas` when snapshot is empty.

### Modal Centering & Portal Anchor

The wizard uses `Modal` (Radix Dialog). The overlay uses `flex items-center justify-center` instead of CSS transforms to avoid coordinate system corruption for `position: fixed` descendants (model dropdown, crop modal). `#modal-portal` inside `Dialog.Content` keeps portaled content within the Radix focus trap.

---

## Sidebar Persona Display

The sidebar reads persona name/avatar from `snapshot?.persona` with fallback to `bootstrapPersonas` (the personas list from the bootstrap store). This ensures the persona is always visible even when no active snapshot exists (e.g., after deleting the last character).
