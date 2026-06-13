# Frontend Architecture

> **apps/web** — React 19 SPA. Communicates exclusively via HTTP API. No server state in the browser.

---

## Data Layer

### Store Architecture

The frontend uses **Zustand as single source of truth**. No React Query, no SWR, no Apollo. The backend sends monolithic snapshots; the frontend normalizes them into Zustand stores via `ingestSnapshot()`.

> **Note:** `ingestSnapshot()` uses Immer's structural sharing — it only replaces object references for fields that actually changed. Components subscribe to focused slices via selectors and only re-render when their specific data changes.
>
> **Partial-response caveat:** Most scalar/array fields (`chats`, `branches`, `summaries`, `character`, `persona`, `contextPreview`, etc.) are left untouched when absent from the response — they use `if (Array.isArray(...))` / `?? null` guards. **`messages` is the exception:** an absent `messages` field triggers a wipe (`messagesById = {}`, `messageOrder = []`). This is load-bearing for chat switching (since `clearMessages()` is never called explicitly). When migrating to endpoint-scoped responses (Phase 3.4), every chat-scoped response that omits `messages` must be updated to either include it or call `clearMessages()` explicitly.

| Store | File | Responsibility |
|-------|------|----------------|
| `useSnapshotStore` | `stores/snapshot-store.ts` | **Canonical backend-confirmed state.** Chats by ID, messages by ID, message order, active chat/character/persona/branch, summaries, prompt traces. This is the "database" of the frontend. |
| `useChatStore` | `stores/chat-store.ts` | UI/runtime state: active chat ID, selected character, draft text, editing state, selected trace ID, per-chat generation state (`messageActionId`). |
| `useBootstrapStore` | `stores/api-actions/bootstrap-actions.ts` | Reference data: prompt presets, personas, first-run/loading state. |
| `useProviderDataStore` | `stores/provider-data-store.ts` | Provider profiles, favorite models per profile. |
| `useCharacterStore` | `stores/character-store.ts` | Build-mode UI state, rename/confirm-destroy dialogs. |
| `useNavigationStore` | `stores/navigation-store.ts` | Theme, mode, sidebar/rail state. |
| `useProviderStore` | `stores/provider-store.ts` | Connection test UI state. |
| `useModalStore` | `stores/modal-store.ts` | Modal open/close state. |

**Key pattern:** `useSnapshotStore.ingestSnapshot(snapshot)` is the single entry point for backend data. API actions call the backend, receive a snapshot (or partial response), and write it through this method. No individual `setState` calls for server data.

`ingestSnapshot` guards most fields with presence checks, so absent fields are preserved. The one exception is `messages`: when the `messages` array is absent, the store wipes existing messages (this drives chat-switching, since `clearMessages()` is never called directly). Endpoint-scoped responses that omit `messages` must account for this.

### Selectors

Components subscribe to **focused slices**, never the entire snapshot:

- `stores/snapshot-store.ts` — canonical selectors: `useChatList()`, `useOrderedMessages()`, `useActiveCharacter()`, `useActivePersona()`, `useDisplayMessage()`, `useMessage()`, `useBranches()`.
- `stores/chat-selectors.ts` — **deprecated** selectors, being migrated to `snapshot-store.ts`. Currently contains `useDisplayMessage(id)`, `useMessageOrder()`, `useMacroContext()`, `useActiveTrace(traceId)` with `@deprecated` JSDoc tags pointing to the canonical versions in snapshot-store.

**`useDisplayMessage(messageId)`** is the most important selector. It computes the full display-ready message object from raw store data — including resolved macro content, variant data, and streaming state. `MessageBlock` uses this to re-render only when its specific message changes.

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
| `VariantControls` | Arrow buttons for variant switching (used both inline and in portal overlay) |

---

## Streaming Architecture

### Generation Flow

```
User sends message
  → pendingUserMessageContent set in activeGen
  → StreamingContent renders in Virtuoso Footer (pending user message + streaming reply)
  → SSE stream yields text-delta / reasoning-delta chunks
  → activeGen.streamingText / streamingReasoningText update on each chunk
  → MessageBlock for last assistant message renders streaming text inline
  → Stream finishes → backend returns snapshot → ingestSnapshot()
  → Ghost message filter prevents duplicate user message
  → StreamingContent disappears (no more activeGen)
```

### Regeneration Streaming

**Problem:** Previously, `isBusy` was global (`isSending`), causing ALL assistant messages to show loading during regeneration.

**Solution:** `MessageBlock` checks `messageActionId === messageId` — only the specific message being regenerated shows streaming state. When active, the block replaces its content with live streaming text + reasoning, instead of appending a separate `StreamingContent` block.

### Active Generation State

`useActiveGeneration()` returns the current generation state:

```ts
{
  streamingText: string;
  streamingReasoningText: string;
  pendingUserMessageContent: string | null;
  messageActionId: string | null;  // which message is being regenerated
}
```

This is stored in `useChatStore` and updated by the SSE stream handler.

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

## i18n

Multi-language support (en, ru) via `i18n/context.tsx` — `useT()` hook returns translation function.

**Key consideration:** Russian text is 20-30% longer than English. UI components must use `whitespace-nowrap` on buttons with Russian text, and prefer generous horizontal padding (`px-4` over `px-2`).

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
