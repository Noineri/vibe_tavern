# Prompt Pipeline

> **`@vibe-tavern/prompt-pipeline`** — Pure function, zero I/O, zero database. Takes a context object, returns an assembled prompt ready for an LLM.

---

## Overview

The pipeline transforms raw character/persona/preset/lore/memory data into an ordered list of **layers** and a final `messages` array suitable for any OpenAI-compatible LLM API.

```
PromptAssemblyContext
  │
  ├─ 0. Mode resolution        ← resolvers/ (SimpleResolver | AdvancedResolver)
  ├─ 1. Macro resolution        ← macro-registry.ts (AST parser + evaluator)
  ├─ 2. Layer creation          ← buildLayers() — the SINGLE mode-sensitive stage
  │     • asks the resolver: enabled? rank? position? include custom injections?
  ├─ 3. Compaction              ← compaction.ts (if contextBudget exceeded)
  ├─ 4. Mode filtering          ← drop layers not active for current AssemblyMode
  ├─ 5. Sorting                 ← position → subPosition → insertionOrder → priority
  └─ 6. Final assembly          ← finalizeAssembly() — interleave in_chat layers into history
  │
  ▼
PromptAssemblyResult (layers + messages + metadata)
```

Stages 1 and 3–6 are **mode-agnostic** — identical in Simple and Advanced modes.
Only stage 2 (layer creation) consults the [mode resolver](#simple-vs-advanced-mode),
and even there only for three policy questions (is this slot enabled? what rank
sorts it? what zone/depth does it land in?). See [Mode-aware assembly](#simple-vs-advanced-mode).

---

## Entry Point: `assemblePrompt(context)`

**File:** `packages/prompt-pipeline/src/assemble.ts`

The entry point is a thin dispatcher. It resolves macros, picks the [mode
resolver](#simple-vs-advanced-mode) once, and delegates to two stages:

```ts
export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  if (effectiveMode === "ai_assistant") return assembleAiAssistant(context);

  const resolver = createResolver(context.preset);   // ← the single mode decision
  return finalizeAssembly(context, buildLayers(context, resolver), resolver);
}
```

- **`buildLayers(context, resolver)`** — stage 2. The only mode-sensitive stage.
  Creates a `PromptLayer` per non-empty content source, asking the resolver
  three questions per slot: `enabled(id)`, `rank(id)`, `position(layer, id)`.
  Also runs compaction (it needs non-history layer token counts).
- **`finalizeAssembly(context, built, resolver)`** — stages 3–6. Mode-agnostic:
  assigns `LAYER_MODES`, filters by `AssemblyMode`, sorts, interleaves in_chat
  layers into history, and builds `finalPayload`.

Both stages share the same resolver instance, so the mode is decided exactly
once and never re-derived downstream.

```ts
import { assemblePrompt } from "@vibe-tavern/prompt-pipeline";

const result = assemblePrompt({
  identity: { chatId: "chat_abc" },
  character: { id: "char_1", name: "Aria", description: "A fire mage." },
  persona:   { id: "pers_1", name: "Olya", description: "A scholar." },
  preset:    { id: "p1", text: "You are {{char}}. Roleplay with {{user}}." },
  chat:      { recentMessages: [...] },
  lore:      [...],
  memory:    { summary: [...], retrieval: [...] },
  config:    { contextBudget: 8000 },
});

result.layers            // PromptLayer[] — ordered, debuggable
result.totalTokenEstimate // number
result.finalPayload       // { messages: [...] }
result.prefill            // string | null — assistant prefill from preset
```

### Input: `PromptAssemblyContext`

| Field | Type | Description |
|-------|------|-------------|
| `identity` | `{ chatId }` | Chat identifier for traceability |
| `character` | `object` | Name, description, scenario, personality, systemPrompt, mesExample, postHistoryInstructions |
| `persona` | `object \| null` | Name, description, pronouns |
| `preset` | `object \| null` | System prompt (`text`), jailbreak, summary prompt, tools prompt, prefill, author's note, custom injections, `promptOrder`, `advancedMode` |
| `mode` | `AssemblyMode` | `"chat"` \| `"continue"` \| `"regenerate"` \| `"summary"` \| `"tool_call"` \| `"ai_assistant"` |
| `lore` | `array` | Activated lore entries (title, content, priority, position, depth, role) |
| `memory` | `object` | `{ summary: [...], retrieval: [...] }` |
| `chat` | `object` | `recentMessages`, `scriptInjections` |
| `instructions` | `object` | `toolInstructions` text |
| `config` | `object` | `contextBudget`, `responseReserve`, `model` |

### Output: `PromptAssemblyResult`

| Field | Type | Description |
|-------|------|-------------|
| `layers` | `PromptLayer[]` | Ordered layers with token counts and metadata |
| `totalTokenEstimate` | `number` | Sum of all layer token counts |
| `activatedLoreEntries` | `string[]` | IDs of lore entries that were included |
| `usedMemoryBlocks` | `string[]` | IDs of memory blocks that were included |
| `droppedLayers` | `{ id, reason }[]` | Layers discarded (empty content, wrong mode, etc.) |
| `finalPayload` | `{ messages }` | Final `messages` array ready for LLM API |
| `prefill` | `string \| null` | Assistant prefill text |

---

## Layer System

### What is a Layer?

Every piece of text in the prompt is a **layer** — a structured record with metadata explaining where it goes and why it's there.

```ts
interface PromptLayer {
  id: string;            // Unique layer ID (e.g. "character_base", "lore_entry_42")
  sourceType: string;    // Where it came from (character, lore_entry, prompt_preset, etc.)
  sourceId: string;      // Entity ID for traceability
  sourceName: string;    // Human-readable label for debug UI
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;      // Higher = earlier within position
  subPosition?: number;  // Fine-grained ordering within in_prompt (WI Anchors)
  injectionDepth?: number; // For in_chat: insert N messages from end
  role?: "system" | "user" | "assistant"; // Message role for in_chat injections
  text: string;          // Actual content
  tokenCount: number;    // Estimated token count
  modes?: AssemblyMode[]; // Which modes this layer is active in
  reason: string;        // Why it was included/dropped
  enabled: boolean;
}
```

### Positions

Layers are placed into four positions, rendered in this order:

| Position | Rank | Purpose |
|----------|------|---------|
| `before_prompt` | 0 | Prepended before everything (rare) |
| `in_prompt` | 1 | Main system prompt block — merged into a single system message |
| `in_chat` | 2 | Interleaved into chat history at a specific depth |
| `hidden_system` | 3 | System-level instructions, not shown in prompt traces |

### Priority Stack (default)

> **Note:** `priority` is the **last-resort tiebreaker** in `sortLayers`. The
> effective sort key chain is `position → subPosition → insertionOrder →
> priority` (descending). Custom injections and canvas-driven slots always
> carry a `subPosition`, so they never reach the `priority` tier — these
> defaults matter only for legacy/built-in layers without a `subPosition`.

```
1000  prompt_preset_system          ← Preset's main system prompt
 990  prompt_preset_jailbreak       ← Jailbreak / anti-censorship
 950  character_system_prompt       ← Character's own system prompt
 900  character_base                ← "Character: {name}\n{description}\nScenario: ..."
 890  character_personality         ← Personality traits
 850  persona                       ← "User persona ({name}): {description}"
 500  summary_memory                ← Chat summaries
 400  retrieval_memory              ← RAG hits
 350  prompt_preset_summary         ← Summary instructions
 300  tool_instructions             ← Tool use instructions
 170  prompt_preset_authors_note    ← Author's Note (also injected at depth)
 160  post_history_instructions     ← Post-history character instructions
 150  mes_example                   ← Example messages (always/once/depth mode)
 100  recent_history                ← Chat messages (ASSISTANT: / USER: format)
  50  preflight_compaction          ← Compaction diagnostic info
```

### Sub-Positions (WI Anchors)

Within `in_prompt`, layers are further ordered by `subPosition`. This maps to SillyTavern's World Info Anchor positions:

| subPosition | Anchor | What goes here |
|-------------|--------|---------------|
| 0 | `charDesc` | Character description, personality, persona |
| 10 | `afterChar` | Lore entries with position `after_char` |
| 15 | `beforeAuthorNote` | Lore entries with position `top_an` |
| 20 | `authorNote` | Author's Note itself |
| 25 | `afterAuthorNote` | Lore entries with position `bottom_an` |
| 30 | `beforeExamples` | Lore entries with position `before_examples` |
| 40 | `exampleMessages` | Example messages block |
| 50 | `afterExamples` | Lore entries with position `after_examples` |
| 60 | `postHistoryInstructions` | Post-history instructions |

Lore entries without a recognized anchor position default to `in_prompt` without a subPosition — they sort after all subPositioned layers, by priority descending.

### Injection Depth

`in_chat` layers can specify `injectionDepth` — the number of messages from the **end** of the history where the layer should be inserted.

Example: `injectionDepth: 4` with 10 messages → inserted between message 6 and 7 (counting from end).

```
messages[0..5]  ← older messages
[injected layer]  ← injectionDepth=4
messages[6..9]  ← 4 most recent messages
```

**Depth insertion is processed deepest-first** to preserve insertion indices when multiple layers inject at different depths.

### Lore Entry Position Mapping

Lore entries use SillyTavern position strings that map to pipeline positions:

| ST Position | Pipeline Position | SubPosition |
|-------------|-------------------|-------------|
| `before_char` | `in_prompt` | — (maps onto `worldInfoBefore` marker) |
| `after_char` | `in_prompt` | 10 |
| `before_examples` | `in_prompt` | 30 |
| `after_examples` | `in_prompt` | 50 |
| `top_an` | `in_prompt` | 15 |
| `bottom_an` | `in_prompt` | 25 |
| `at_depth` | `in_chat` | — (uses `depth` field) |
| `outlet` | `hidden_system` | — |

> For the full lorebook system — activation engine, budget & priority semantics, ST parity audit, and trace integration — see [Lorebooks](lorebooks.md).
>
> For the script system — `node:vm` sandbox, the `context` API, engine invariants, and the template registry — see [Scripts](scripts.md).

### Media / appearance layers (A7)

Three built-in layers inject **vision-generated appearance text** — image descriptions produced by the avatar/gallery describe pipelines, emitted as plain text so they work with any model:

| Layer | Source | Gate | Output text |
|-------|--------|------|-------------|
| Character avatar | `character.avatarDescription` | `character.includeAvatarInPrompt` + non-empty + canvas slot `characterAvatar` enabled | `[Character appearance: <desc>]` |
| Character gallery | `character.gallery[]` | non-empty gallery + canvas slot `characterGallery` enabled | `[Character references:\n<each described item>]` |
| Persona avatar | `persona.avatarDescription` | `persona.includeAvatarInPrompt` + non-empty + canvas slot `personaAvatar` enabled | `[Persona appearance: <desc>]` |

All three route through `resolver.position()` with a `DEFAULT_PROMPT_ORDER` rank `< 100` (before-chat zone), so they behave like every other built-in slot: **canvas-toggleable in advanced mode, always-on in simple mode**, ordered adjacent to the character/persona block. Gating is two-level: the per-entity `includeXInPrompt` toggle + non-empty content, **and** `resolver.enabled(identifier)` (the canvas slot).

---

## Simple vs Advanced Mode

A preset operates in one of two modes, selected by `preset.advancedMode`. The
mode decides **three policy questions** per slot during `buildLayers` and nothing
else — content construction, macro resolution, compaction, sorting, and final
assembly are identical in both modes.

| Policy question | Simple | Advanced |
|---|---|---|
| Is a built-in slot enabled? | **always** (no canvas toggles) | canvas `promptOrder[id].enabled` |
| What rank does it sort at? | `DEFAULT_PROMPT_ORDER[id]` | canvas `promptOrder[id].order` |
| What zone/depth does it land in? | inferred from default order vs `chatHistory`(100) | canvas `promptOrder[id].zone`/`.depth` |
| Are custom injections assembled? | **no** (stored only) | yes |

### The `PositionResolver` seam

The mode decision is encapsulated in a `PositionResolver`
(`packages/prompt-pipeline/src/resolvers/`) so `buildLayers` is mode-blind:

```
resolvers/
├── position-resolver.ts   interface + createResolver(preset) factory
├── simple-resolver.ts     built-in always-on, DEFAULT_PROMPT_ORDER, no custom injections
└── advanced-resolver.ts   canvas (promptOrder) is the single source of truth
```

```ts
interface PositionResolver {
  enabled(id): boolean;                  // built-in slot participation
  rank(id, fallback?): number;           // sort rank
  position(layer, id): PromptLayer;      // apply zone/order/depth
  readonly includeCustomInjections: boolean;
  worldInfoEntry(id): entry | undefined; // canvas WI slot (advanced only)
}
```

`assemblePrompt` creates the resolver once and threads it through both stages:
`buildLayers(context, resolver)` and `finalizeAssembly(context, built, resolver)`.
The mode is never re-derived downstream — there is no `isSimpleMode()` check in
the body of `buildLayers` or `finalizeAssembly`.

### Shared-field model (2-in-1 preset)

Simple and Advanced modes share the **same underlying preset data** for the four
core fields — `system` (`text`), `jailbreak`, `prefill`, `authorsNote`. This is
intentional: a preset is a 2-in-1 container, and switching modes must not lose
the user's authored content.

- **Simple → Advanced:** the basic fields are preserved; the canvas renders them
  as built-in slots. Custom injections are retained on the preset (not
  assembled in Simple, but available the moment the user switches to Advanced).
- **Advanced → Simple:** the canvas state is retained on the preset but ignored
  at assembly; the basic fields still drive the four core slots.

### Author's Note — flat fields are authoritative

The Author's Note is special: it owns **flat position fields**
(`authorsNotePosition` / `authorsNoteDepth` / `authorsNoteRole`) that are
**authoritative in both modes**. The resolver contributes only `subPosition`
(sort rank) for the note — it never relocates it. The three placements:

| `authorsNotePosition` | layer position | `injectionDepth` |
|---|---|---|
| `in_prompt` | `in_prompt` | — (none) |
| `in_chat` (default) | `in_chat` | `authorsNoteDepth` (default 4) |
| `after_chat` | `in_chat` | `0` |

`after_chat` is semantically identical to `in_chat` at depth 0 — symmetry is
expressed via the depth value, not a new `PromptLayer.position` enum value.

### Invariant: chatHistory can never be disabled

`chatHistory` carries container markup used for **precise inject-depth
placement** (in_chat layers splice into history by depth). Disabling it would
break depth math, so both resolvers force-enable it regardless of any canvas
toggle. This intentionally diverges from SillyTavern, which lets users drop
history — we reject that because our depth-injection model depends on the
history layer always being present.

### No-synthesis rule

The backend **never derives `zone` from `order`**. In Advanced mode the canvas
is expected to write `zone`/`depth` explicitly on each `promptOrder` entry;
when an entry lacks `zone`, it is *inferred* via `inferSlot({ defaultOrder })`
(SillyTavern's default-order-relative heuristic), not synthesized from the
entry's position in the array. Tests that feed only `order` and expect a
derived `zone` are synthetic and invalid — the canvas contract requires
explicit `zone`.

---

## Assembly Modes

Layers are filtered by the current `AssemblyMode`. Not all layers belong in every scenario:

| Layer | chat | continue | regenerate | summary | tool_call |
|-------|------|----------|------------|---------|-----------|
| System prompt | ✓ | ✓ | ✓ | — | — |
| Jailbreak | ✓ | ✓ | ✓ | — | — |
| Character base | ✓ | ✓ | ✓ | ✓ | — |
| Persona | ✓ | ✓ | ✓ | ✓ | — |
| Lore entries | ✓ | ✓ | ✓ | — | — |
| Summary memory | ✓ | ✓ | ✓ | — | — |
| Tool instructions | ✓ | ✓ | ✓ | — | ✓ |
| Author's Note | ✓ | ✓ | ✓ | — | — |
| Example messages | ✓ | ✓ | ✓ | ✓ | — |
| Recent history | ✓ | ✓ | ✓ | — | — |
| Summary preset | — | — | — | ✓ | — |

### `ai_assistant` mode

`ai_assistant` uses a simplified assembly path (`assembleAiAssistant`) instead of the normal chat/layer filtering flow. It builds layers from:

- AI assistant system prompt
- Character context (if enabled)
- Persona context (if enabled)
- Lore entries (if enabled)
- Existing content
- Chat history for `chat_impersonate` mode
- User instruction (emitted as the final user message)

---

## Context Compaction

When `contextBudget` is set and the prompt exceeds it, older messages are trimmed.

### Algorithm

```
1. Calculate nonHistoryTokens = sum of all non-history layers
2. Reserve tokens for model response (responseReserve)
3. historyBudget = contextBudget - nonHistoryTokens - responseReserve
4. Walk messages from END to START, accumulating tokens
5. Stop when accumulated tokens > historyBudget (but keep ≥ 2 messages)
6. Apply findSafeCompactionBoundary() — never split assistant→tool pairs
7. Discard messages before the boundary
8. Add a diagnostic layer explaining what was compacted
```

### Token Counting

Token counting is injected at startup via `setTokenCountFn()`. The server provides a real tokenizer (tiktoken for OpenAI, web-tokenizers for Claude/Llama, byte fallback as last resort).

```ts
import { setTokenCountFn, setModelHint } from "@vibe-tavern/prompt-pipeline";

// At server startup:
setTokenCountFn((text, model) => countTokens(text, model));
// Before each assembly:
setModelHint("claude-3-opus");
```

---

## Macro Engine

**File:** `packages/prompt-pipeline/src/macro-registry.ts`

The macro engine resolves `{{...}}` placeholders in all text fields before layer construction.

### Architecture

```
Input text
  → Tokenizer (character-by-character, handles nested {{}})
    → Tokens: text | macro | ifOpen | else | ifClose
      → Recursive Descent Parser
        → AST: TextNode | MacroNode | IfNode
          → Evaluator (resolves macros, evaluates conditions)
            → Output text
```

The tokenizer counts `{{`/`}}` depth, so nested macros like `{{if {{getvar::x}}}}...{{/if}}` are correctly parsed as a single if-block.

### Variable State

Variables (`setvar`/`getvar`) persist across all `resolve()` calls on the same engine instance within one assembly pass. The engine calls `resetVariables()` at the start of each `assemblePrompt()` call.

### Two-Pass Resolution (ST field macros in custom injections)

Character/persona fields (`{{description}}`, `{{personality}}`, `{{scenario}}`, `{{persona}}`, etc.) are resolved **first**, then a second variable context is built from those resolved fields. This lets `{{scenario}}` and `{{personality}}` resolve correctly inside custom injection content (ST parity).

Before the fix, `{{scenario}}` inside a custom injection would return empty because custom injections were resolved against the **pre-resolution** variable context. After the fix, the order is:

1. Build variable context from raw character/persona fields.
2. Resolve all character/persona **fields** (description, personality, scenario, etc.).
3. Build a fresh variable context using the resolved fields.
4. Resolve all remaining text (custom injections, author's note, etc.) with this enriched context.

### Supported Macros

#### Identity

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{user}}` | `{{USER}}` | User's persona name |
| `{{char}}` | `{{CHAR}}`, `<BOT>`, `<CHAR>` | Character name |
| `{{persona}}` | — | Persona description text |
| `{{group}}` | — | Group name (group chats) |
| `{{charIfNotGroup}}` | — | Character name if not in a group |

#### Character Fields

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{description}}` | `{{charDescription}}` | Character description |
| `{{personality}}` | `{{charPersonality}}` | Personality traits |
| `{{scenario}}` | `{{charScenario}}` | Scenario text |
| `{{mesExamplesRaw}}` | `{{mesExamples}}` | Raw example messages |
| `{{charFirstMessage}}` | `{{greeting}}` | First message / greeting |
| `{{charCreatorNotes}}` | `{{creatorNotes}}` | Creator notes |
| `{{charVersion}}` | `{{version}}`, `{{char_version}}` | Character version title |
| `{{charDepthPrompt}}` | — | Character's depth-prompt text (ST `depth_prompt`); injection depth/role come from the character's `depthPromptDepth` / `depthPromptRole` fields |

#### Chat Context

| Macro | Returns |
|-------|---------|
| `{{lastChatMessage}}` | Last message content (any role) |
| `{{lastUserMessage}}` | Last user message content |
| `{{lastCharMessage}}` | Last assistant message content |
| `{{summary}}` | Summary prompt text from preset |

#### Runtime

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{model}}` | — | Active model ID |
| `{{maxPrompt}}` | `{{maxPromptTokens}}` | Max prompt token limit |
| `{{maxContext}}` | `{{maxContextTokens}}` | Context budget |
| `{{maxResponse}}` | `{{maxResponseTokens}}` | Max response tokens |

#### Time

| Macro | Returns |
|-------|---------|
| `{{time}}` | `HH:MM` (24h) |
| `{{date}}` | `YYYY-MM-DD` |
| `{{weekday}}` | Full weekday name (e.g. "Thursday") |
| `{{isotime}}` | `HH:MM` |
| `{{isodate}}` | `YYYY-MM-DD` |

#### Variables (local, per-assembly)

| Macro | Syntax | Effect |
|-------|--------|--------|
| `{{setvar::name::value}}` | Set variable | Sets `name` to `value`, returns empty |
| `{{getvar::name}}` | Get variable | Returns value or empty string |
| `{{getvar::name::fallback}}` | Get with fallback | Returns value or `fallback` |
| `{{addvar::name::value}}` | Append/add | Numeric addition if both numbers, string concat otherwise |
| `{{incvar::name}}` | Increment | `+1`, returns new value |
| `{{decvar::name}}` | Decrement | `-1`, returns new value |
| `{{hasvar::name}}` | Check existence | `"true"` or `"false"` |
| `{{deletevar::name}}` | Delete | Removes variable, returns empty |

#### Random & Dice

| Macro | Syntax | Returns |
|-------|--------|---------|
| `{{random::a::b::c}}` | Random choice | One of `a`, `b`, `c` |
| `{{random:a,b,c}}` | Legacy comma format | One of `a`, `b`, `c` |
| `{{roll::1d20}}` | Dice roll | Total as string |
| `{{roll::3d6+2}}` | With modifier | Total as string |
| `{{roll::d6}}` | Shorthand (1 die) | Total as string |

**Dice caveats:**

- Only `[N]dK[+/-M]` syntax — no `kh`/`kl`/`!` keep/explode.
- The roll is re-evaluated on **every prompt assembly**, including regenerations. For stable per-message dice (same number on regen), use a `/roll` script template instead — see `apps/web/src/components/build/editors/scriptTemplates.ts` (`dice` template), which caches results in `context.state` keyed by message content.
- For D&D advantage/disadvantage and `d%` percentile notation, use the script template — `{{roll}}` doesn't support them.

#### Conditionals

```
{{if condition}}then-text{{/if}}
{{if condition}}then-text{{else}}else-text{{/if}}
```

- Condition is resolved (nested macros expanded) before evaluation
- Truthy: non-empty string, not `"false"`, `"0"`, `"off"`, `"no"`
- Negation: prefix condition with `!` to invert
- Nesting: `{{if}}` blocks can be nested

Examples:
```
{{if {{char}}}}Character is set{{/if}}
{{if !{{getvar::x}}}}x is empty{{else}}x = {{getvar::x}}{{/if}}
{{setvar::a::1}}{{if {{getvar::a}}}}{{if {{getvar::b}}}}both{{/if}}{{/if}}
```

#### Utility

| Macro | Returns |
|-------|---------|
| `{{newline}}` | `\n` |
| `{{space::N}}` | N spaces |
| `{{noop}}` | Empty string (no-op) |
| `{{original}}` | Original preset text (first call only, then empty) |
| `{{// comment text}}` | Empty (comment stripped) |

#### Banned Words

`{{banned::"word"}}` — registers a word for logit bias (collected during assembly, not emitted into prompt).

Runtime note: banned-word macros produce candidate bias entries only. Before generation, the API applies the same model-aware logit-bias gate as the provider UI: the provider must support bias, the model must resolve to a known tokenizer, and the saved token IDs must match the active model. Unknown/router/mixed-provider cases are disabled rather than using an approximate fallback tokenizer.

---

## Pipeline Walkthrough

Given this input:

```ts
assemblePrompt({
  identity: { chatId: "chat_1" },
  character: {
    id: "char_1", name: "Aria",
    description: "{{char}} is a fire mage.",
    scenario: "{{user}} enters the tower.",
    personality: "Bold, curious",
    mesExample: "<START>\n{{char}}: *casts fireball*",
    mesExampleMode: "always",
  },
  persona: { id: "pers_1", name: "Olya", description: "A scholar." },
  preset: {
    id: "p1",
    text: "You are {{char}}. Roleplay with {{user}}.",
    jailbreak: "[System: continue the story]",
    authorsNote: "Focus on Aria's magic",
    authorsNoteDepth: 4,
  },
  lore: [
    { id: "lore_1", title: "The Tower", content: "An ancient spire...", priority: 800, position: "after_char" },
    { id: "lore_2", title: "Fire Magic", content: "Aria wields blue flames...", priority: 700, position: "at_depth", depth: 2 },
  ],
  chat: {
    recentMessages: [
      { id: "m1", role: "assistant", content: "Welcome to the tower, {{user}}." },
      { id: "m2", role: "user", content: "I step inside." },
    ],
  },
  config: { contextBudget: 8000 },
});
```

The pipeline produces:

1. **Macros resolved** — `{{char}}` → "Aria", `{{user}}` → "Olya" in all fields
2. **Layers created** (in sort order):

| Layer | Priority | Content |
|-------|----------|---------|
| `prompt_preset_system` | 1000 | "You are Aria. Roleplay with Olya." |
| `prompt_preset_jailbreak` | 990 | "[System: continue the story]" |
| `character_base` | 900 | "Character: Aria\nAria is a fire mage.\nScenario: Olya enters the tower." |
| `character_personality` | 890 | "Bold, curious" |
| `lore_1` (subPos=10) | 800 | "Lore: The Tower\nAn ancient spire..." |
| `persona` | 850 | "User persona (Olya): A scholar." |
| `prompt_preset_authors_note` | 170 | "Focus on Aria's magic" |
| `mes_example` | 150 | "[Example messages]\n..." |
| `recent_history` | 100 | "ASSISTANT: Welcome to the tower, Olya.\n\nUSER: I step inside." |
| `prompt_preset_authors_note_depth` | 170 | (injected 4 messages from end in history) |
| `lore_2` (in_chat, depth=2) | 700 | "Lore: Fire Magic\nAria wields blue flames..." |

3. **Final messages** (simplified):
```
[system] You are Aria. Roleplay with Olya.
[system] [System: continue the story]
[system] Character: Aria
         Aria is a fire mage.
         Scenario: Olya enters the tower.
[system] Bold, curious
[system] Lore: The Tower
         An ancient spire...
[system] User persona (Olya): A scholar.
[system] Focus on Aria's magic
[system] [Example messages]
         <START>
         Aria: *casts fireball*
[system] Focus on Aria's magic          ← author's note at depth 4
[system] Lore: Fire Magic               ← lore at depth 2
         Aria wields blue flames...
[assistant] Welcome to the tower, Olya.
[user] I step inside.
```

---

## Advanced Prompt Mode

> The assembly-level contract for Advanced mode is documented in
> [Simple vs Advanced Mode](#simple-vs-advanced-mode) above (resolver seam,
> shared-field model, no-synthesis rule). This section covers the **UI /
> persistence** side: the canvas, the data flow, and ST import.

A preset can switch to **Advanced Mode** (SilkyTavern-compatible) via `advancedMode: true` on `PromptPresetDto`. The flag is **per-preset** and persisted in `prompt_presets.advanced_mode`.

When advanced mode is active:

- The Prompt Manager UI shows an editable canvas (`PromptOrderCanvas`) instead of the basic fields.
- The preset stores an explicit `promptOrder: PromptOrderEntry[]` (identifier, enabled, order, kind, **zone**, **depth**).
- **Custom injections** become the primary authoring surface — each injection has its own `identifier`, `name`, `content`, `role`, `depth`, `injectionPosition`, `injectionOrder`, `enabled`, and an optional `slot: PromptSlot`.
- Built-in slots (`main`, `jailbreak`, `authorsNote`, `chatHistory`, `worldInfoBefore/After`, `charDescription`, `charPersonality`, `scenario`, `personaDescription`, `dialogueExamples`) participate in the same order list and can be reordered/toggled.
- **Character V3 fields** (System Prompt, Post-History Instructions, Depth Prompt) appear as editable cards with a `CHAR` badge and dashed border, syncing directly with the active character card.

### `enabled` flag — authoritative source

There are two places where enabled state lives:

1. `customInjections[i].enabled` — the toggle on the injection row in the UI.
2. `promptOrder[identifier].enabled` — the toggle on the slot/marker in the prompt-order canvas.

For **custom injections**, the **authoritative source is `customInjections[i].enabled`**. `promptOrder` is used only for `order`/`placement` (matching SilkyTavern semantics).

For **built-in slots** (`main`, `jailbreak`, `authorsNote`, etc.), the authoritative source is `promptOrder[identifier].enabled` because there is no `customInjections` entry for them.

The UI (`InjectionTable.tsx`) keeps both flags in sync for custom injections when the row toggle is clicked — but the assembly layer only consults the authoritative source, so a desynced `promptOrder` entry cannot disable a custom injection.

### PromptSlot — visual canvas position

`PromptSlot` is the unified position model that replaces ST's legacy `injectionPosition`/`injectionOrder`/`depth` triple:

```ts
interface PromptSlot {
  zone: "before_chat" | "in_chat" | "after_chat";
  depth: number | null;   // messages from end, for in_chat zone
  order: number;          // sort order within zone+depth
}
```

Three places store position data, all converging on `PromptSlot`:

| Source | Location | How it's read |
|--------|----------|---------------|
| `PromptOrderEntry.zone` / `.depth` | `promptOrder[]` on preset | `AdvancedResolver.position()` (see [Simple vs Advanced Mode](#simple-vs-advanced-mode)) |
| `CustomInjection.slot` | `customInjections[]` on preset | Direct read in `buildLayers()` |
| Legacy ST fields | `injectionPosition`, `injectionOrder`, `depth` | `migrateInjection()` fallback |

Migration: `migrateInjection()` converts legacy fields into `PromptSlot` on first access. `slotToStFields()` reverse-maps for export. The canvas always writes `slot` on custom injections and `zone`/`depth` on `promptOrder` entries — legacy fields are never the source of truth.

### Canvas layout (PromptOrderCanvas)

The canvas is a multi-zone drag-and-drop surface built on `@dnd-kit`. **Visual position is the absolute source of truth** — no separate position/depth inputs on cards.

```
┌─ Before Chat ─────────────────────────────────────────────┐
│  [System Prompt] [WI Before] [Persona] [Char Desc] ...    │
└───────────────────────────────────────────────────────────┘
┌─ In Chat (Accordion) ─────────────────────────────────────┐
│  ▸ Depth 4+   (DroppableDepthContainer, depth ≥ 4)        │
│  ▸ Depth 3    (DroppableDepthContainer, depth=3)          │
│  ▸ Depth 2    (DroppableDepthContainer, depth=2)          │
│  ▸ Depth 1    (DroppableDepthContainer, depth=1)          │
└───────────────────────────────────────────────────────────┘
┌─ After Chat ──────────────────────────────────────────────┐
│  [Post-History] [Jailbreak] ...                           │
└───────────────────────────────────────────────────────────┘
┌─ Assistant Prefill (pinned, non-draggable) ───────────────┐
│  [Prefill card]                                           │
└───────────────────────────────────────────────────────────┘
```

**Depth accordion:** Depth containers ≥4 are collapsed into a single expandable bucket. Each depth bucket is a separate `DroppableDepthContainer` in `@dnd-kit`. Items dragged between zones are spread across containers via `onDragOver` cross-zone logic.

**Assistant Prefill** is pinned to the bottom, non-draggable, with no position badges. It is a message-start override, not a pipeline injection.

**Drag-and-drop flow:**
1. `onDragOver` — updates `activeZones` state, spreading items across containers in real time.
2. `onDragEnd` — `commitList()` writes the final visual order back into `nextPromptOrder` (for built-in/marker items) and `nextInjections` (for custom injections), setting `zone`, `depth`, and `order` on each.
3. `onPromptOrderChange` + `onChange` propagate to the parent draft.
4. `handleSave` in `PromptManagerModal` sends the full draft (including `promptOrder` with `zone`/`depth`) to the API.

**Badges:** Cards show zone-aware position indicators: `←4` for `in_chat` at depth 4, `"after"` for `after_chat`, nothing for `before_chat`. Custom injections in depth ≥4 show a `NumberInput` for adjusting depth inline.

### Character V3 field cards

Three character fields are always visible on the canvas (empty or filled):

| Card | Default Zone/Order | API Field |
|------|-------------------|-----------|
| Character System Prompt | `before_chat`, order 1 | `character.systemPrompt` |
| Character Depth Prompt | `in_chat`, order 65 | `character.depthPrompt` + `depthPromptDepth` |
| Character Post-History | `after_chat`, order 115 | `character.postHistoryInstructions` |

These are rendered as `CharacterFieldCard` components with:
- Dashed border + `CHAR` badge
- Editable `textarea` that syncs via `saveCharacterAction` (partial patch)
- Not draggable (position is fixed per zone, not reorderable)
- Depth Prompt card includes `NumberInput` for depth adjustment

The data flow: `AppShell` reads `activeCharacter` from snapshot store → passes to `PromptManagerModal` as `characterFields` → builds `CharacterCanvasDraft` → passes to `PromptOrderCanvas` → renders cards. Edits call `onCharacterFieldUpdate` → maps draft keys to API field names → `saveCharacterAction` patches the character directly.

### Zod schema — zone/depth persistence

The `promptPresetCoreSchema` in `prompt-preset-schema.ts` includes `zone` and `depth` fields in the `promptOrder` array. Without these, Zod strips them during validation, and canvas positions are lost on every save.

### Importing ST presets

ST preset JSON imports fill both `customInjections` and `promptOrder` from the original `prompts` and `prompt_order` arrays. The import:
- Maps ST fields to `PromptSlot` via `migrateInjection`
- Preserves each entry's `enabled` flag as-is
- Sets `advancedMode: true` automatically when injections or prompt order are present

---

## Testing

```bash
# All prompt-pipeline tests
bun test packages/prompt-pipeline/test/

# Just macro tests
bun test packages/prompt-pipeline/test/macro-resolution.test.ts
```

Test files:

| File | What it tests |
|------|---------------|
| `assemble.test.ts` | Layer creation, sorting, mode filtering, compaction, author's-note flat-field placement |
| `macro-resolution.test.ts` | All macro types, variables, conditionals, random, roll, nested if |
| `lore-activation.test.ts` | Lore keyword matching, logic operators, cooldown, group weights |
| `macros.test.ts` | Legacy macro tests (skipped — module removed) |
| `prompt-order.test.ts` | Prompt order overrides, ST-compatible insertion positions, chatHistory-always-enabled invariant |
| `st-injections.test.ts` | SillyTavern-style prompt injections, relative/absolute/depth placement |
| `media-injection.test.ts` | A7 media layers — character avatar/gallery + persona avatar appearance blocks, two-level gating, canvas-slot routing |

### Mode-contract testing

Tests that exercise **Advanced** behavior (canvas toggles, custom injections, ST
semantics) must declare `advancedMode: true` on their preset and write explicit
`zone`/`depth` on `promptOrder` entries (the [no-synthesis rule](#no-synthesis-rule)).
A test that omits `advancedMode` runs in Simple mode by default, where built-in
slots are always enabled and custom injections are ignored — so an
Advanced-behavior assertion will fail there, which is the contract, not a bug.
