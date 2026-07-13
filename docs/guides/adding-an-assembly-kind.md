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
| **One-shot — insights** | an objective check/generate or scene generate | `InsightsAssembler` | `getInsightsAssembler(kind).assemble(input)` | `InsightsKind` (`objective` \| `scene`) |

**Rule of thumb:** if the prompt replies to the user in the chat, it is a chat turn — add a `ChatModeStrategy` (see [Adding a chat mode](./adding-a-chat-mode.md)). If the prompt is a background or tool generation whose result never streams into the chat (summarize a thread, generate a lore entry, check whether a task is done, fill a scene JSON), it is a **one-shot** — add a registry peer, do **not** add a flag to `assemblePrompt`.

### Why not a flag on `assemblePrompt`?

`assemblePrompt` builds exactly one thing: an RP chat turn. Branching it with `if (mode === "summary")` or a `summary: true` selector collapses the pipeline's type inference and forces every caller to reason about every mode. The registries exist so the chat pipeline stays single-purpose. This was an explicit cleanup (`ASSEMBLY_REGISTRIES_PLAN`): a service-side `mode` chain that survived the first pass was dead weight and was removed — do not reintroduce it. If you catch yourself reaching for a flag, you want a new registry.

## Where things live

```
packages/prompt-pipeline/src/
├── assemble.ts                  assemblePrompt (chat turn) + assembleSummaryPrompt + shared buildLayers/finalizeAssembly
├── summary/
│   ├── summary-strategy.ts      SummaryStrategy interface + DefaultSummaryStrategy
│   └── summary-strategies.ts    SUMMARY_STRATEGIES registry (satisfies Record<string, SummaryStrategy>)
├── ai-assistant/
│   ├── ai-assistant-assembler.ts   AiAssistantAssembler interface + assembleAiAssistant (DefaultAiAssistantAssembler)
│   └── ai-assistant-assemblers.ts  AI_ASSISTANT_ASSEMBLERS registry (satisfies Record<AiAssistantMode, …>)
└── insights/                    ← the newest one-shot registry (INS-3c)
    ├── insights-assembler.ts    InsightsAssembler interface + assembleInsights (DefaultInsightsAssembler)
    └── insights-assemblers.ts   INSIGHTS_ASSEMBLERS registry (satisfies Record<InsightsKind, …>)
```

All four are **pure**: prompt in, `PromptAssemblyResult` out. LLM invocation, storage, provider resolution, and instruction-text loading stay with the caller — never in the pipeline package.

## The reference implementation

The **insights** registry (`packages/prompt-pipeline/src/insights/`) is the simplest worked example — it was added specifically as the minimal one-shot registry. It mirrors the AI-assistant registry in shape but with a bespoke input type (the insight prompt has no RP stack, so it does not reuse `PromptAssemblyContext`). When a step says "mirror insights", read those two files plus the loader at `services/api/src/domain/insights/insights-prompts.ts`.

## Step 1 — The kind type + assembly input

Decide the discriminator (the `InsightsKind` analog) and the assembler's input. If the one-shot reuses the full RP context (like summary/AI-assistant), it takes a `PromptAssemblyContext` and reads a dedicated field (`context.aiAssistant!`, `context.objectiveTask`, …). If it is structurally unlike a chat turn (like insights — recent window + instruction, no character/lore), give it a **bespoke input type** so the "no RP stack" constraint is structural: the assembler physically cannot reference character data it was never handed.

```ts
// packages/prompt-pipeline/src/insights/insights-assembler.ts
export type InsightsKind = "objective" | "scene";

export interface InsightsAssemblyInput {
  kind: InsightsKind;
  recentMessages: ReadonlyArray<InsightsRecentMessage>;
  instruction: string;
}

export interface InsightsAssembler {
  assemble(input: InsightsAssemblyInput): PromptAssemblyResult;
}
```

## Step 2 — The pure assembler

Implement `assemble`: build the layer set, then `finalPayload.messages` (the array the executor sends to the model). Return the standard `PromptAssemblyResult` (`layers`, `totalTokenEstimate`, `activatedLoreEntries`, `usedMemoryBlocks`, `droppedLayers`, `finalPayload`, `prefill`, `compactionSummary`). Use `makeLayer` + `sortLayers` from `assemble.ts`; add any layer ids / source types / priorities you need to `prompt-layer-constants.ts` (peers of the `aiAssistant*` entries).

```ts
export function assembleInsights(input: InsightsAssemblyInput): PromptAssemblyResult {
  // … build layers (trace) + finalPayload.messages (what the model sees) …
}

export const DefaultInsightsAssembler: InsightsAssembler = { assemble: assembleInsights };
```

## Step 3 — The registry (the compile-time guard)

Register the assembler for every key of the discriminator. The `as const satisfies Record<Kind, Assembler>` is the whole point: adding a new kind without registering an assembler is a **compile error**, not a silent hole. A kind that later needs a divergent layer set gets its own entry here — the chat pipeline is never involved.

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

## Step 5 — The caller: assemble, map, execute

The caller (the feature service, e.g. `ObjectiveService`) calls the registry, maps the `PromptAssemblyResult` to the `AssemblePromptResponse` DTO the executor consumes, and runs it through `nonstreamingProviderExecute` (background one-shots) or the streaming path (assistant). Inject the executor and the prompt resolver so the full path is unit-testable via DI (per [AGENTS.md §1.4](../../AGENTS.md)) — do not mock them globally.

```ts
const assembly = getInsightsAssembler("objective").assemble({ kind: "objective", recentMessages, instruction });
const prompt = insightsAssemblyToPromptResponse(assembly);   // layers + finalPayload → AssemblePromptResponse
const result = await this.execute({ profile, model, prompt, signal });
```

## Step 6 — Test the manifest + the boundary

Two test layers, both in the pipeline package (`packages/prompt-pipeline/test/`):

1. **Manifest** — every key of the discriminator resolves, and the registry's key set matches it (the `satisfies` guard made visible).
2. **Behavior** — the assembler builds the expected `finalPayload.messages` and never includes layers it should not (for insights: no character / lore / authorsNote / insight layers — the "no RP stack" contract).

If a refactor later relocates a boundary (e.g. the objective service used to reshape the final user message itself, then the assembler took over), re-pin the boundary at its new owner — do not just delete the old test. See the insights assembler test for the relocated `instruction-as-final-user-message` boundary.
