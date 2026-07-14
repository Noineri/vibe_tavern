# Adding a new prompt-assembly kind

> Companion to [Prompt Pipeline → Registries](../architecture/prompt-pipeline.md#registries-what-builds-a-prompt).
> Read this before adding a one-shot prompt shape (a background LLM call, a Build assistant, an insight tracker) — the framework already has a registry for it, so the work is one entry, not a branch in `assemblePrompt`.

## The decision: chat turn, or one-shot?

Every prompt the app sends to a model is built by exactly one of four pure registries, chosen by **kind of generation**, not by a runtime flag. The first question is always: is this a *chat turn* or a *one-shot*?

| Kind | Builds | Registry | Entry point | Selected by |
|------|--------|----------|-------------|-------------|
| **Chat turn** | an RP turn streamed to the user | `ChatModeStrategy` (umbrella) + `PositionResolver` (nested) | `assemblePrompt(context)` | `preset.advancedMode` → simple \| canvas |
| **One-shot — summary** | a chat-summary prompt | `SummaryStrategy` | `getSummaryStrategy().assemble(ctx)` | `SUMMARY_STRATEGIES.default` |
| **One-shot — AI assistant** | a Build lightbulb request | `AiAssistantAssembler` | `getAiAssistantAssembler(mode).assemble(ctx)` | `AiAssistantMode` (6 keys) |
| **One-shot — insights** | an objective check/generate or scene generate | `InsightsAssembler` | `getInsightsAssembler(kind).assemble(ctx, instruction)` | `InsightsKind` (`objective` \| `scene`) |

**Rule of thumb:** if the prompt replies to the user in the chat, it is a chat turn — add a `ChatModeStrategy` (see [Adding a chat mode](./adding-a-chat-mode.md)). If the prompt is a background or tool generation whose result never streams into the chat (summarize a thread, generate a lore entry, check whether a task is done, fill a scene JSON), it is a **one-shot** — add a registry peer, do **not** add a flag to `assemblePrompt`.

### Why not a flag on `assemblePrompt`?

`assemblePrompt` builds exactly one thing: an RP chat turn. Branching it with `if (mode === "summary")` or a `summary: true` selector collapses the pipeline's type inference and forces every caller to reason about every mode. The registries exist so the chat pipeline stays single-purpose. This was an explicit cleanup (`ASSEMBLY_REGISTRIES_PLAN`): a service-side `mode` chain that survived the first pass was dead weight and was removed — do not reintroduce it. If you catch yourself reaching for a flag, you want a new registry.

## Two one-shot shapes

Both reuse the same pure building blocks (`buildLayers` + `finalizeAssembly` in `assemble.ts`); they differ in **how much of the RP world** the one-shot model needs:

- **Full RP context (summary, insights).** The model evaluates the conversation and needs the world it takes place in — character, persona, activated lorebook, script injections, recent window. The assembler takes a `PromptAssemblyContext` (the same type a chat turn takes), reuses `buildLayers`, then applies a **filter** (a visibility set) and/or seeds endpoint-owned layers before compaction. Everything follows the chat's own preset toggles — no one-shot-specific visibility policy.
- **Minimal context (AI assistant).** The model performs a tool task (rewrite a field, generate a script) and needs only a system prompt + a few optional context layers + the instruction. `AiAssistantAssembler` builds its own minimal layer set from `context.aiAssistant.enabledLayers` rather than reusing the chat pipeline.

Pick by content, not by taste: if the one-shot's quality depends on the character/world (summarizing, judging task completion, extracting scene state), it needs the full RP context → reuse `buildLayers`. If it is a pure tool prompt, the minimal shape is enough.

## Where things live

```
packages/prompt-pipeline/src/
├── assemble.ts                  assemblePrompt (chat turn)
│                                + assembleSummaryPrompt (filter to SUMMARY_LAYER_IDS)
│                                + assembleInsightsPrompt (seed instruction + strip self-injection layers)
│                                + shared buildLayers / finalizeAssembly (internal)
├── summary/
│   ├── summary-strategy.ts      SummaryStrategy interface + DefaultSummaryStrategy
│   └── summary-strategies.ts    SUMMARY_STRATEGIES registry (satisfies Record<string, SummaryStrategy>)
├── ai-assistant/
│   ├── ai-assistant-assembler.ts   AiAssistantAssembler interface + assembleAiAssistant
│   └── ai-assistant-assemblers.ts  AI_ASSISTANT_ASSEMBLERS (satisfies Record<AiAssistantMode, …>)
└── insights/
    ├── insights-assembler.ts    InsightsAssembler interface + assembleInsights (→ assembleInsightsPrompt)
    └── insights-assemblers.ts   INSIGHTS_ASSEMBLERS (satisfies Record<InsightsKind, …>)
```

All four are **pure**: prompt in, `PromptAssemblyResult` out. LLM invocation, storage, provider resolution, and instruction-text loading stay with the caller — never in the pipeline package.

## The reference implementation

For the **full-RP-context** shape (the common case), the **insights** assembler is the worked example: `assembleInsightsPrompt` in `assemble.ts` seeds its instruction as a real user-role depth-0 layer before `buildLayers` plans compaction, then strips only the insight self-injection layers. Mirror it. For the **minimal** shape, mirror `AiAssistantAssembler`.

## Step 1 — The kind type + the interface

Add the discriminator and the assembler interface. A full-RP-context one-shot takes `PromptAssemblyContext` (like summary):

```ts
// packages/prompt-pipeline/src/insights/insights-assembler.ts
export type InsightsKind = "objective" | "scene";

export interface InsightsAssembler {
  assemble(context: PromptAssemblyContext, instruction: string): PromptAssemblyResult;
}
```

If the one-shot carries an extra parameter (insights carries a resolved `instruction` string), add it to `assemble`'s signature — the caller resolves it and passes it in.

## Step 2 — The pure assembly function (in `assemble.ts`)

For a full-RP-context one-shot, add an `assembleXxxPrompt` function **inside `assemble.ts`** (next to `assembleSummaryPrompt`), because `buildLayers` / `finalizeAssembly` are internal there. Run `applyMacrosToContext` + `createResolver`, create any endpoint-owned layers, pass them to `buildLayers` before compaction, apply your filter, then call `finalizeAssembly`.

```ts
// packages/prompt-pipeline/src/assemble.ts
export function assembleInsightsPrompt(rawContext: PromptAssemblyContext, instruction: string): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const resolver = createResolver(context.preset);
  const trimmedInstruction = instruction.trim();
  const instructionLayer = trimmedInstruction ? makeLayer({
    id: PROMPT_LAYER_ID.insightsInstruction,
    sourceType: PROMPT_LAYER_SOURCE_TYPE.insightsInstruction,
    sourceId: context.identity.chatId,
    position: "in_chat",
    priority: PROMPT_LAYER_PRIORITY.insightsInstruction,
    role: "user",
    text: trimmedInstruction,
  }) : null;
  if (instructionLayer) instructionLayer.injectionDepth = 0;

  // Seed endpoint-owned layers before buildLayers plans history compaction.
  const built = buildLayers(context, resolver, instructionLayer ? [instructionLayer] : []);
  const layers = built.layers.filter(
    (layer) => layer.id !== PROMPT_LAYER_ID.objectiveTask && layer.id !== PROMPT_LAYER_ID.sceneState,
  );
  return finalizeAssembly(context, { ...built, layers }, resolver);
}
```

Endpoint-owned text that must reach the model belongs in a real `PromptLayer` before `buildLayers` plans compaction; never append an uncounted message after `finalizeAssembly`. The filter is the only place a one-shot imposes its own visibility. **Do not invent a new toggle policy** — `mes_example`, lore activation, authorsNote all follow the chat's preset toggles via the resolver. Strip only the layers that are genuinely redundant or harmful for your one-shot (for insights: the objective/scene injection layers, which would duplicate the instruction).

The thin `DefaultXxxAssembler` in the registry package delegates to this function:

```ts
export function assembleInsights(context: PromptAssemblyContext, instruction: string): PromptAssemblyResult {
  return assembleInsightsPrompt(context, instruction);
}
export const DefaultInsightsAssembler: InsightsAssembler = { assemble: assembleInsights };
```

## Step 3 — The registry (the compile-time guard)

Register the assembler for every key of the discriminator. The `as const satisfies Record<Kind, Assembler>` is the whole point: adding a new kind without registering an assembler is a **compile error**, not a silent hole. A kind that later needs a divergent shape gets its own entry here — the chat pipeline is never involved.

```ts
// packages/prompt-pipeline/src/insights/insights-assemblers.ts
export const INSIGHTS_ASSEMBLERS = {
  objective: DefaultInsightsAssembler,
  scene: DefaultInsightsAssembler,
} as const satisfies Record<InsightsKind, InsightsAssembler>;

export function getInsightsAssembler(kind: InsightsKind): InsightsAssembler {
  return INSIGHTS_ASSEMBLERS[kind];
}
```

Re-export `getInsightsAssembler` + the types from `packages/prompt-pipeline/src/index.ts`, next to the existing `getAiAssistantAssembler` / `getSummaryStrategy` lines.

## Step 4 — Default instruction in a `.md` asset, overridable per-chat

One-shot prompts almost always have default instruction text. Put it in a `.md` file under `services/api/assets/` (a peer of `script-ai-prompt.md`, `lore-entry-ai-prompt.md`, …), **not** a hardcoded string. Load it through the shared `shared/prompt-asset-loader.ts` ladder, and resolve it override-or-default from a service module that mirrors `ai-assistant-prompts.ts`:

```ts
// services/api/src/domain/insights/insights-prompts.ts
export async function resolveInsightsPrompt(key: InsightsPromptKey, override: string | null | undefined): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;                 // per-chat override wins
  return (await loadPromptAsset(INSIGHTS_PROMPT_FILES[key])).trim();  // otherwise the .md default
}
```

The service composes the dynamic context (objective description / active task / scene schema) onto the resolved base and passes the final string to the assembler. The assembler stays pure — no I/O in the pipeline package.

## Step 5 — The caller: build context, assemble, map, execute

The caller (the feature service, e.g. `ObjectiveService`) builds the `PromptAssemblyContext` the same way a chat turn does (character / persona / activated lorebook / script injections / recent window sliced per `contextWindow`), **omitting** any context fields whose layers it will itself strip — then calls the registry, maps the `PromptAssemblyResult` to the `AssemblePromptResponse` DTO the executor consumes, and runs it through `nonstreamingProviderExecute`. Inject the executor and the prompt resolver so the full path is unit-testable via DI (per [AGENTS.md §1.4](../../AGENTS.md)) — do not mock them globally.

```ts
const assembly = getInsightsAssembler("objective").assemble(context, instruction);
const prompt = insightsAssemblyToPromptResponse(assembly);   // layers + finalPayload → AssemblePromptResponse
const result = await this.execute({ profile, model, prompt, signal });
```

## Step 6 — Test the manifest + the boundary

Two test layers, both in the pipeline package (`packages/prompt-pipeline/test/`):

1. **Manifest** — every key of the discriminator resolves, and the registry's key set matches it (the `satisfies` guard made visible).
2. **Behavior** — the assembler builds the expected `finalPayload.messages` with the RP context the one-shot needs, applies its filter correctly (for insights: character/persona/lore present; `objectiveTask`/`sceneState` stripped even when the context carries them; the instruction is a real budgeted layer and the final user message), and inherits the chat's toggles (e.g. `mes_example` follows `mesExampleMode`). Include a constrained-budget case proving a longer endpoint instruction forces additional history compaction without exceeding `contextBudget`.

If a refactor later relocates a boundary (e.g. the objective service used to reshape the final user message itself, then the assembler took over), re-pin the boundary at its new owner — do not just delete the old test.
