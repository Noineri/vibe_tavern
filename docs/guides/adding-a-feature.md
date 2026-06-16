# Adding a new feature

> Companion to [Backend Architecture](../architecture/backend.md) and [Prompt Pipeline](../architecture/prompt-pipeline.md).
> Read this before adding any LLM-backed capability — the two feature kinds look similar but wire up very differently.

The server has a **feature module** system (`FeatureModule` + `FeatureRegistry`) that lets a capability register routes, subscribe to chat events, and own background work as a self-contained unit. But "add a feature" is ambiguous: there are two genuinely different shapes, and picking the wrong one is the #1 way to over-engineer. Decide first:

| Case | What it is | Example | Effort |
|------|-----------|---------|--------|
| **A. Stateless AI-assistant mode** | User clicks → server calls LLM → streams text back to the caller. No persistence, no event subscription, result does not feed back into future prompts. | Lore-keys extractor, markdown importer, vision-describe, chat impersonate | **1 service registration** |
| **B. Stateful background LLM feature** | Subscribes to a chat event (or runs on a schedule), calls an LLM fire-and-forget, **persists a domain entity**, and injects a prompt layer that changes future generations. | Chat summary, objective tracker, scene tracker, summary badges, dream, auto-memory | **1 feature module + 1 service + (often) 1 store + 1 prompt layer** |

> **Rule of thumb:** if the result must be *stored* or must *affect future prompts*, it is Case B. If the result goes straight to the user (who pastes it somewhere themselves), it is Case A.

---

## The two registries — do not confuse them

There are **two** registration surfaces on the backend. They are not interchangeable.

| Registry | Purpose | Lifetime | Example members |
|----------|---------|----------|-----------------|
| **AI-assistant registry** (`services/api/src/domain/ai-assistant/`) | Stateless text-transform modes. Caller owns the result. | Per-request | `lore`, `md_import`, `script`, `vision_describe` |
| **Feature registry** (`FeatureModule` → `FeatureRegistry`) | Self-contained features: routes, event subscriptions, background tasks. Owns its persisted state. | App-lifetime (server start → stop) | `chat-summary`, `ai-assistant` (the *route*), future `objective`, `tracker`, `dream` |

**Case A features register in the AI-assistant registry.** **Case B features register in the Feature registry.** Never put a stateful background task in the AI-assistant registry — it has no hook for events, persistence, or prompt-layer injection.

> Note: `ai-assistant` is itself a `FeatureModule`, but only because it mounts the single `/api/ai-assistant` SSE route. The *modes* it dispatches to are registered separately in the AI-assistant registry. This is a wiring detail, not a pattern to copy for Case B.

---

## Where things live (orientation)

```
services/api/src/
├── shared/
│   ├── feature-module.ts        FeatureModule / FeatureDeps interfaces
│   ├── feature-registry.ts      FeatureRegistry — lifecycle (register/activate/deactivate)
│   └── background-task-locks.ts BackgroundTaskLocks — dedup mutex for background tasks (Case B)
├── domain/
│   ├── chat/
│   │   ├── chat-summary-feature.ts      Case B example #1: event subscriber + background task
│   │   ├── chat-summary-service.ts      Case B example: the service holding the task logic
│   │   └── chat-mode-strategy.ts        per-mode hooks (resolveProvider, onMessageAppended)
│   └── ai-assistant/
│       ├── ai-assistant-feature.ts      mounts the /api/ai-assistant SSE route
│       ├── ai-assistant-registry.ts     Case A: the mode registry
│       └── ai-assistant-prompts.ts      prompt loaders per mode
├── server/
│   └── server-runtime.ts        ← where FeatureRegistry.register() is called for each feature
└── infrastructure/ai/
    └── nonstreaming-provider-executor.ts  nonstreamingProviderExecute — the LLM call primitive

packages/
├── prompt-pipeline/src/
│   ├── assemble.ts                pure prompt assembly (where your new prompt layer is applied)
│   └── prompt-layer-constants.ts  PROMPT_LAYER_IDS — register a new layer id here
└── db/src/
    ├── db-schema.ts               add a table here (then `bun run db:generate`)
    └── stores/                    one store per entity
```

Dependency direction is strict: features depend on stores + services + infrastructure, never the reverse. `BackgroundTaskLocks` is in `shared/` because it has no domain knowledge.

---

## Case A — Stateless AI-assistant mode

The result is text (or tokens) returned to the caller. Nothing is persisted; no prompt layer is injected. This is the simplest addition in the codebase.

### Step 1 — Register the mode

Add an entry to the AI-assistant registry (`services/api/src/domain/ai-assistant/ai-assistant-registry.ts`). A mode provides:
- `systemPrompt` — loaded from `services/api/assets/*.md` (see `ai-assistant-prompts.ts` for the path-resolution pattern).
- `outputFormat` — `text` | `json` (drives how the frontend parses the stream).
- `userMessageBuilder` — turns the request body into the final user message.
- `contextResolver` — what chat context (if any) to assemble.

Copy the closest existing mode (e.g. `vision_describe` for backend-only modes, `lore` for chat-context modes) and adapt. The registry dispatch is one switch arm.

### Step 2 — Frontend caller

Call `POST /api/ai-assistant` with `{ mode, chatId, ...payload }`. The frontend already has a generic streaming hook for this. If the mode needs a dedicated UI affordance (a button, a modal), wire it to that endpoint.

### Done

Verify with `bun run check`, then smoke-test: trigger the mode from the UI and confirm the streamed text/JSON arrives.

> **Do not** reach for Case B if your feature "calls an LLM". Calling an LLM is the least interesting part of a Case B feature. The interesting parts — when to trigger, what to persist, how to inject — are what make it Case B.

---

## Case B — Stateful background LLM feature

This is the shape for chat-summary-style features. The LLM call is one line; the rest is trigger logic, persistence, and prompt-layer injection.

### What is shared vs. what is feature-specific

Before writing code, know which parts to reuse and which to write fresh:

| Concern | Shared (reuse) | Where |
|---------|----------------|-------|
| App-lifetime wiring (routes, event subs, cleanup) | ✅ | `FeatureModule` interface |
| Dedup + error boundary for the background task | ✅ | `BackgroundTaskLocks.runExclusive` |
| The LLM call itself | ✅ | `nonstreamingProviderExecute` |
| Provider/model resolution | ✅ (pattern) | copy the `useChatModel` vs. explicit-profile branch from `chat-summary-service.ts` |

| Concern | Feature-specific (write your own) | Why |
|---------|-----------------------------------|-----|
| Trigger condition | ❌ | summary: `everyN` messages past last covered; objective: check-counter; tracker: every assistant msg; dream: manual/scheduled |
| Persist target | ❌ | summary: `chatSummaries` table; objective: `chats.insightsObjectiveStateJson`; tracker: `message.extra.sceneTracker` |
| Output shape | ❌ | text vs. task tree vs. recursive JSON vs. short badge text |
| Prompt-layer injection | ❌ | each layer has its own `PROMPT_LAYER_IDS` entry and its own assembler arm |

Unifying the feature-specific parts produces a God-interface every feature has to fight. Unifying the shared parts removes real boilerplate. Keep this line bright.

### Step 1 — Data model

Decide where the feature's output lives:
- **New table** (e.g. summaries, dream memories) → add to `packages/db/src/db-schema.ts`, add a store in `packages/db/src/stores/`, run `bun run db:generate`. **Never edit existing migration files.**
- **JSON column on an existing entity** (e.g. `chats.insightsObjectiveStateJson`, `message.extra.sceneTracker`) → add the column via migration, type the accessor.

See [Database Migrations](../DATABASE_MIGRATIONS.md).

### Step 2 — Prompt layer (if the feature injects into future prompts)

If the feature's output must appear in future generations (summary does; an inline-rendered objective badge does not):

1. Add a layer id to `PROMPT_LAYER_IDS` (`packages/prompt-pipeline/src/prompt-layer-constants.ts`).
2. Add the assembler arm that populates that layer from your store in `assemble.ts` (or the chat-lifecycle assembler that calls it). Follow the `prompt_preset_summary` arm as the template.
3. Add the layer id to `withSummaryPromptAsFinalUserMessage`-style post-processing **only if** your layer needs to become a final user message rather than a system layer (summary does this; most features do not).

If the feature only renders inline in the UI (objective route, scene tracker, badge), skip this step entirely — the output is read by the frontend, not injected into prompts.

### Step 3 — Service

Create `services/api/src/domain/<area>/<feature>-service.ts`. Hold one `BackgroundTaskLocks` instance per service (features are independent — an objective run and a summary run on the same chat may proceed in parallel).

The trigger method shape, copied from `chat-summary-service.ts`:

```ts
export class MyFeatureService {
  private readonly locks = new BackgroundTaskLocks();

  constructor(
    private readonly stores: StoreContainer,
    private readonly sessionRuntime: SessionRuntime,
    private readonly providerProfiles: ProviderProfileService,
  ) {}

  async trigger(input: { chatId: string; /* ...event payload */ }): Promise<void> {
    // 1. Cheap guards first (feature enabled? chat exists?) — before acquiring the lock.
    // 2. runExclusive takes it from here: dedup + error boundary + lock release.
    await this.locks.runExclusive(
      `${input.chatId}:${branchId}`,
      async () => {
        // 3. Trigger condition (feature-specific) — maybe return early.
        // 4. Resolve provider+model (copy the useChatModel / explicit-profile branch).
        // 5. Call nonstreamingProviderExecute with your assembled prompt.
        // 6. Persist the result to your store / JSON column.
      },
      (err) => logSendDebug("myfeature.auto.error", {
        chatId: input.chatId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
```

The error callback is where your `logSendDebug` goes. `runExclusive` swallows the error so the event-bus caller never crashes.

### Step 4 — Feature module

Create `services/api/src/domain/<area>/<feature>-feature.ts`. This is the glue: instantiate the service, subscribe to the event, expose routes.

```ts
export function createMyFeatureFeature(deps: {
  stores: StoreContainer;
  sessionRuntime: SessionRuntime;
  providerProfileService: ProviderProfileService;
}): FeatureModule {
  const service = new MyFeatureService(deps.stores, deps.sessionRuntime, deps.providerProfileService);
  let unsubscribe: (() => void) | null = null;

  return {
    id: "my-feature",

    activate({ events, router }: FeatureDeps): void {
      // Background trigger: subscribe to the event that should fire the task.
      unsubscribe = events.on("message.appended", ({ chatId }) => {
        void service.trigger({ chatId });
      });

      // Optional: manual/CRUD routes for the frontend.
      router.get("/api/chats/:chatId/my-feature", async (c) => {
        // ...read from your store, return JSON
      });
      router.patch("/api/chats/:chatId/my-feature", async (c) => {
        // ...manual edit path (does NOT need the lock — it's user-driven, not background)
      });
    },

    deactivate(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
```

### Step 5 — Register in the server runtime

Add a `features.register(createMyFeatureFeature({...}))` line in `services/api/src/server/server-runtime.ts`, next to the existing `createChatSummaryFeature` call.

### Step 6 — Frontend types + UI

- Add the new fields (e.g. `insightsObjectiveStateJson`) to the relevant snapshot DTO / `AppCharacter`-style types if they are not already present.
- Wire the UI affordance: either an inline render (objective route, scene tracker, badge — see `maket_app/src/sections/message/`) or a settings panel (see `maket_app/src/sections/build/InsightsPanel.tsx`).

### Done

Verify with `bun run check`, then smoke-test against `dev:web` using the Playwright MCP server.

---

## Background task contract (reference)

`BackgroundTaskLocks.runExclusive(key, task, onError)`:

| Property | Guarantee |
|----------|-----------|
| Dedup | If `key` is already in flight, the call returns `false` immediately. The caller does **not** wait on the in-flight run. |
| Atomicity | The `has()` check and the `add()` happen with no `await` between them — concurrent triggers cannot both pass the check. |
| Error handling | `task` errors are swallowed (the event-bus caller must never crash) and forwarded to `onError` for `logSendDebug`/metrics. |
| Lock release | Always released in `finally`, even on error. |
| Return value | `true` if `task` ran (success or failure); `false` if skipped. |
| Per-instance scoping | Each service owns its own `BackgroundTaskLocks`. Different features on the same chat run in parallel. |

---

## Event hooks (reference)

The chat orchestrator emits domain events on the `EventBus`. The primary background-trigger hook is:

| Event | Emitted from | Payload | Typical use |
|-------|--------------|---------|-------------|
| `message.appended` | `live-chat-orchestrator.ts` (after an assistant message is appended) | `{ chatId, messageId, role }` | Fire-and-forget background tasks (summary, objective check, tracker, badge) |
| `message.created` | `live-chat-orchestrator.ts` (on message creation) | `{ ... }` | Less common — use only if you need to act before append |

> **`ChatModeStrategy.onMessageAppended` is a separate, narrower hook** for mode-specific behaviour (group/coauthor routing). Do **not** use it for background LLM tasks — those go through the `EventBus` + `FeatureModule` path. The two are deliberately separate; mixing them creates double-trigger bugs.

---

## Testing checklist

### Case A
- [ ] `bun run check` clean.
- [ ] Trigger the mode from the UI; confirm the stream arrives and parses per `outputFormat`.

### Case B
- [ ] `bun run check` clean.
- [ ] If you added a table/column: migration generated via `bun run db:generate`; store has a characterization test if it carries logic.
- [ ] If you added a prompt layer: confirm the layer id appears in `prompt.layers` for relevant chats (check via a prompt-assembly test or the debug log).
- [ ] Trigger the feature (event-driven and/or manual route); confirm the persisted entity matches expectations.
- [ ] Fire the trigger twice rapidly; confirm only one background run executes (dedup).
- [ ] Force the LLM call to fail; confirm the error is logged via `onError` and the lock is released (next trigger still runs).
- [ ] If a prompt layer is injected: confirm future generations include it; confirm `excludeSummarized`-style flags (if any) are honoured.

---

## Common mistakes

- **Putting a stateful background task in the AI-assistant registry.** That registry has no event hook, no persistence, and no prompt-layer injection. If the result is stored or affects future prompts, it is Case B — use `FeatureModule`.
- **Unifying the feature-specific parts.** Trigger condition, persist target, output shape, and injection are *meant* to differ between features. A shared interface for them becomes a God-interface every feature fights. Share `BackgroundTaskLocks` + `nonstreamingProviderExecute` + the provider-resolution pattern; leave the rest feature-local.
- **Using `ChatModeStrategy.onMessageAppended` for background LLM tasks.** It is a mode-routing hook, not a task trigger. Subscribe to `message.appended` on the `EventBus` from your `FeatureModule` instead.
- **Skipping the lock "because it's just one call."** Overlapping `message.appended` events are normal (rapid messages, retries). Without `runExclusive` you will double-run and corrupt state.
- **Acquiring the lock before the cheap guards.** Feature-enabled / chat-exists checks should run *before* `runExclusive`, so a disabled feature does not hold a lock pointlessly. The original `has()`-then-`add()` race was fixed by `runExclusive`'s atomic check-and-acquire — don't reintroduce a gap.
- **Editing an existing migration file.** Add a new one via `bun run db:generate`. Existing migrations are immutable history.
- **Forgetting the prompt-layer id.** A new assembler arm without a `PROMPT_LAYER_IDS` entry will not round-trip through compaction correctly (the compaction boundary algorithm preserves tool-call/result pairs and layer identity — see its doc comment).
