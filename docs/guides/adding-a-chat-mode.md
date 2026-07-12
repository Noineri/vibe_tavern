# Adding a new chat mode

> Companion to [Frontend Architecture → Shell Dispatch & Chat Modes](../architecture/frontend.md#shell-dispatch--chat-modes).
> Read this before adding a chat mode — both halves are registry-driven, so most of the work is one entry in each of two registries.

A chat mode is how a chat's prompt is assembled **and** which shell surface renders it. These are **two independent halves** that share exactly one thing: the `ChatMode` type. You wire them separately, and a mode that exists on only one half is half-broken (a strategy with no surface renders the RP shell; a surface with no strategy throws at generation). Pick both rows:

| Half | What it owns | Registry | Example |
|------|-------------|----------|---------|
| **Backend — prompt strategy** | How a turn is assembled + post-turn hooks | `services/api/src/domain/chat/chat-mode-strategy.ts` (`strategies` Map) | `RpModeStrategy`, `CoauthorModeStrategy` |
| **Frontend — shell surface** | Which central panel / left chrome / top bar render | `apps/web/src/lib/chat-mode-registry.ts` (`CHAT_MODE_PACKAGES`) + `surface-parts.tsx` catalog | `rp` package, `coauthor` package |

> **Rule of thumb:** if your mode only changes *how the prompt is built* (same chat UI), you still need a shell package — point its `play` surface at the existing `PlayMode` + default chrome and omit `build`. If your mode only changes *the UI* (same prompt), you still need a strategy — copy `RpModeStrategy` and delegate `assemble` to `promptService.assembleForChat`. There is no "strategy-only" or "surface-only" mode.

---

## Where things live (orientation)

```
packages/domain/src/
└── platform-constants.ts        CHAT_MODE — the canonical ChatMode union (shared)

services/api/src/domain/chat/
├── chat-mode-strategy.ts        ChatModeStrategy interface + RpModeStrategy + CoauthorModeStrategy
│                                + the `strategies` Map<ChatMode, () => ChatModeStrategy>  ← backend registry
└── coauthor-prompt.ts           co-author's assemble implementation (reference for a non-RP strategy)

apps/web/src/
├── lib/
│   ├── chat-mode-registry.ts    CHAT_MODE_PACKAGES — pure descriptors (parts by NAME)  ← frontend registry
│   │                            getChatModePackage / hasBuildSurface / getShellRoutes
│   └── surface-parts.tsx        SURFACE_SURFACES / SURFACE_LEFT_CHROME / SURFACE_TOP_BARS
│                                — the name → component catalog (the ONLY file importing the components)
├── hooks/
│   └── use-shell-surface.tsx    useShellSurface() — joins (chatMode × play/build × platform) → elements
├── components/layout/AppShell.tsx   consumes useShellSurface(); no per-mode ternaries here
└── components/<mode>/           the concrete surface components (play/, build/, coauthor/)
```

Dependency direction: the domain `ChatMode` is the leaf; both registries import it and nothing else from each other. The frontend registry references parts **by name string**, never by component import — `surface-parts.tsx` is the single seam between names and components.

---

## The reference implementation

The `coauthor` mode is the worked example for every step below — it has a non-RP strategy (`CoauthorModeStrategy` → `assembleCoauthorPrompt`), a custom shell package (`CoauthorMode` + `CoauthorSidebar`/`CoauthorRail` + `CoauthorTopBar`), no build slot, and its own route (`/coauthor`). When a step below says "mirror coauthor", read those files.

---

## Step 1 — The shared domain type

Add the mode to `CHAT_MODE` in `packages/domain/src/platform-constants.ts`:

```ts
export const CHAT_MODE = {
  rp: "rp",
  coauthor: "coauthor",
  novel: "novel",   // ← new
  group: "group",
} as const;
```

`ChatMode` (the derived union) expands automatically. Note the key and value match (`novel` / `"novel"`). This is the **only** shared touchpoint between the two halves — every other edit is confined to one half.

> The `novel`/`group` values already exist in `CHAT_MODE` as reserved-but-unimplemented. Adding a real `novel` mode means wiring the two halves below — the type itself is already there.

---

## Step 2 — Backend: the prompt strategy

Implement `ChatModeStrategy` and register it. This defines how a turn of this mode is assembled.

`ChatModeStrategy` (in `chat-mode-strategy.ts`) is three hooks; the orchestrator still owns the execution loop (streaming, abort, SSE, error handling), so the strategy stays small:

| Hook | What it does | RP | Co-Author |
|------|-------------|----|-----------|
| `resolveProvider({ chatId, profile, model })` | Pick the provider profile + model for this chat (group mode may select per character) | pass-through | pass-through |
| `assemble(input)` | **The load-bearing seam.** Build the prompt for a turn; return the standard assembled-prompt shape (+ optional `tools`/`maxSteps` for tool-calling modes) | delegate to `promptService.assembleForChat` | build an editor prompt via `assembleCoauthorPrompt` |
| `onMessageAppended({ chatId, messageId, events })` | Background work after a reply lands (runs in parallel with the user's next action) | no-op (EventBus subscribers handle auto-summary) | no-op |

Returning the **standard assembled-prompt shape** from `assemble` is what makes streaming / abort / reasoning / `drainStream` work for every mode with no mode-specific branches in the executor. Do not invent a parallel return type.

> A chat-mode strategy's `assemble` goes through `assembleForChat` → `assemblePrompt`, which builds exactly one thing: an RP-style chat turn (the [resolver seam](../architecture/prompt-pipeline.md#the-positionresolver-seam) picks simple vs canvas). **Chat-summary generation and the Build AI-assistant are not chat turns** — they live in their own registries (`SummaryStrategy`, `AiAssistantAssembler` in `packages/prompt-pipeline`) and never enter `ChatModeStrategy`. A new chat mode does not touch them.

Create the strategy class in `chat-mode-strategy.ts` (or a sibling module it imports — co-author keeps its `assemble` body in `coauthor-prompt.ts`), then add one line to the `strategies` Map:

```ts
const strategies = new Map<ChatMode, () => ChatModeStrategy>([
  ["rp", () => new RpModeStrategy()],
  ["coauthor", () => new CoauthorModeStrategy()],
  ["novel", () => new NovelModeStrategy()],   // ← new
]);
```

`getChatModeStrategy(mode)` **throws** for an unregistered mode — this is intentional (fail loud, not silently fall back to RP). If `bun run test` for `chat-mode-strategy.test.ts` fails with "Unsupported chat mode", you forgot this line.

---

## Step 3 — Frontend: the shell package

Add a `ChatModePackage` to `CHAT_MODE_PACKAGES` in `apps/web/src/lib/chat-mode-registry.ts`. Parts are referenced by **name** (a key into the `surface-parts.tsx` catalog), never by component import — this keeps the registry pure and unit-testable.

A mode with a build editor (like `rp`):

```ts
{
  chatMode: "novel",
  play:  { surface: "NovelMode",  leftChrome: "default", topBar: "default" },
  build: { surface: "NovelBuild", leftChrome: "default", topBar: "default" },
  routes: { play: "/novel", build: "/novel/build" },
},
```

A play-only mode (like `coauthor`) — omit `build`:

```ts
{
  chatMode: "novel",
  play: { surface: "NovelMode", leftChrome: "novel", topBar: "novel" },
  routes: { play: "/novel" },
},
```

`getShellRoutes()` automatically picks up the new package's routes (one `play` row, plus a `build` row only when `build` is declared) — no extra wiring for the wouter hand-off. A stale `build` toggle on a build-less mode is clamped to `play` at render time, so the toggle is preserved as user intent but never renders an impossible build screen.

### `ChatModePackage` field reference

| Field | What it is |
|-------|-----------|
| `chatMode` | The `ChatMode` this package handles. Must match a `CHAT_MODE` value. |
| `play` | **Required.** `ShellSlotNames` for the play (interact) surface. Every mode has a play screen. |
| `build` | **Optional.** `ShellSlotNames` for the build (edit) surface. Omit for modes with no editor; the shell clamps a stale `build` toggle to `play`. |
| `routes.play` / `routes.build` | The wouter paths for this mode. `build` only when `build` is declared. |

### `ShellSlotNames` field reference

Each of the three slots is a **name string** (a key into the matching map in `surface-parts.tsx`):

| Slot | Catalog map | Component shape |
|------|------------|-----------------|
| `surface` | `SURFACE_SURFACES` | No-arg component (`PlayMode` / `BuildMode` / `CoauthorMode`) |
| `leftChrome` | `SURFACE_LEFT_CHROME` | Platform pair `{ desktop, mobile }` — desktop no-arg, mobile takes `{ hidden? }` |
| `topBar` | `SURFACE_TOP_BARS` | Takes `{ railHidden?, onShowRail?, update? }` (CoauthorTopBar ignores `update`) |

Reusing the `"default"` name for `leftChrome`/`topBar` means "the RP chrome" (`Sidebar`/`Rail`/`TopBar`) — use it when your mode shares the RP shell chrome, as `rp` build does. Give your mode its own name (e.g. `"novel"`) only when it ships dedicated chrome.

---

## Step 4 — Frontend: the catalog + components

Add the named parts to the matching map(s) in `apps/web/src/lib/surface-parts.tsx`, and create the component files they reference. This is the **only** file that imports the concrete shell components — the registry stays pure.

```ts
// surface-parts.tsx
import { NovelMode } from "../components/novel/NovelMode.js";
import { NovelBuild } from "../components/novel/NovelBuild.js";

export const SURFACE_SURFACES: Record<string, ComponentType> = {
  PlayMode,
  BuildMode,
  CoauthorMode,
  NovelMode,    // ← new
  NovelBuild,   // ← new
};
```

If your mode has dedicated chrome, add entries to `SURFACE_LEFT_CHROME` (a `{ desktop, mobile }` pair) and/or `SURFACE_TOP_BARS` as needed. If it reuses the RP chrome, add nothing here — `"default"` already resolves.

Then write the components themselves. If your mode's central surface is structurally just the RP chat shell (as `CoauthorMode` is — `MessageList` + `InputArea` reused verbatim), **compose** the shared components; do not fork them. Coauthor forks only its chrome (`CoauthorSidebar`, `CoauthorTopBar`) and adds its right-panel editor — the chat half is shared. See `CoauthorMode.tsx` for the composition pattern.

> The catalog maps are `Record<string, …>`, so a missing name resolves to `undefined` at runtime, not a type error. The colocated `surface-parts.test.tsx` COMPLETENESS test asserts that every name used by `CHAT_MODE_PACKAGES` resolves in the catalog — run it; it catches a typo'd name that typecheck will not.

---

## The reserved-but-unimplemented fallback

`getChatModePackage(chatMode)` falls back to the **rp package** for a mode with no `CHAT_MODE_PACKAGES` entry. This is deliberate: `novel`/`group` are in `CHAT_MODE` already, and before they get a real surface they render the RP shell (sane default) rather than crashing. So:

- Adding a `CHAT_MODE` value with **no package and no strategy** → the chat renders the RP shell and throws at generation (strategy lookup). Safe to look at, broken to talk to.
- Adding a **package with no strategy** → renders your surface, throws at generation.
- Adding a **strategy with no package** → generates fine, but renders the RP shell.

Wire both halves before shipping.

---

## Getting chats *into* the new mode

The registries define how a mode *behaves and renders*, not how a chat *enters* it. The `mode` field lives on the chat row (`chats.mode`, default `"rp"`). How the user creates a chat of your mode is mode-specific and out of scope here: co-author has its own entry point and a `switchModeAction` path in `chat-actions.ts`. For a new mode, add whatever creation affordance fits (a sidebar action, a first-time-setup path, etc.) and set `mode` on the created chat — the registries take it from there.

---

## Testing checklist

- [ ] `bun run typecheck` clean.
- [ ] **Backend:** a `chat-mode-strategy.test.ts` case for the new strategy's `assemble` (mirror the existing RP/co-author cases). `getChatModeStrategy("novel")` returns your strategy; an unregistered mode throws.
- [ ] **Frontend:** the `chat-mode-registry.test.ts` manifest-integrity test picks up the new package (it iterates `CHAT_MODE_PACKAGES`); add an assertion for `getChatModePackage("novel")` → your package and `hasBuildSurface("novel")` matching your `build` declaration.
- [ ] **Frontend:** `surface-parts.test.tsx` COMPLETENESS passes — every name your package uses resolves in the catalog (catches a typo'd name).
- [ ] UI: a chat with `mode: "novel"` renders your surface (not the RP fallback); sending a message uses your strategy's assembled prompt (check via the prompt tracer).

---

## Common mistakes

- **Wiring only one half.** A strategy without a surface renders RP; a surface without a strategy throws at generation. Both halves are required for a working mode (see [§ The reserved-but-unimplemented fallback](#the-reserved-but-unimplemented-fallback)).
- **Importing components into `chat-mode-registry.ts`.** The registry holds names only — `surface-parts.tsx` is the single import seam. Inlining a component breaks the purity that lets the registry unit-test without rendering anything.
- **Adding a `build` slot to a build-less mode "for later".** Omit `build` until the editor exists. A declared `build` whose surface name is missing resolves to `undefined` and crashes when the user flips to build; an omitted `build` clamps the toggle to `play` gracefully.
- **Reusing a name across slots expecting the same component.** `"default"` means *different* components in different slots (`Sidebar` for leftChrome, `TopBar` for topBar) — that is intended. Within one slot, each name maps to exactly one component; a collision silently overwrites.
- **Forking the RP chat shell when your mode only adds a panel.** `CoauthorMode` composes the shared `MessageList`/`InputArea` and adds its editor alongside; it does not duplicate the chat half. Fork chrome only when the chrome genuinely differs.
- **Inventing a non-standard `assemble` return type.** Returning the standard assembled-prompt shape is what keeps streaming/abort/reasoning mode-agnostic. Put mode-specific extras in the documented extension fields (`tools`, `maxSteps`, `coauthorModuleId`/`coauthorSkillId`-style badges), not a new shape.
