# Prompt Pipeline

> **`@vibe-tavern/prompt-pipeline`** — Pure function, zero I/O, zero database. Takes a context object, returns an assembled prompt ready for an LLM.

---

## Overview

The pipeline transforms raw character/persona/preset/lore/memory data into an ordered list of **layers** and a final `messages` array suitable for any OpenAI-compatible LLM API.

```
PromptAssemblyContext
  │
  ├─ 1. Macro resolution        ← macro-registry.ts (AST parser + evaluator)
  ├─ 2. Layer creation          ← assemble.ts
  ├─ 3. Compaction              ← compaction.ts (if contextBudget exceeded)
  ├─ 4. Mode filtering          ← drop layers not active for current AssemblyMode
  ├─ 5. Sorting                 ← position → subPosition → priority descending
  └─ 6. Final assembly          ← interleave in_chat layers into history
  │
  ▼
PromptAssemblyResult (layers + messages + metadata)
```

---

## Entry Point: `assemblePrompt(context)`

**File:** `packages/prompt-pipeline/src/assemble.ts`

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
| `before_char` | `before_prompt` | — |
| `after_char` | `in_prompt` | 10 |
| `before_examples` | `in_prompt` | 30 |
| `after_examples` | `in_prompt` | 50 |
| `top_an` | `in_prompt` | 15 |
| `bottom_an` | `in_prompt` | 25 |
| `at_depth` | `in_chat` | — (uses `depth` field) |
| `outlet` | `hidden_system` | — |

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

A preset can switch to **Advanced Mode** (SilkyTavern-compatible) via `advancedMode: true` on `PromptPresetDto`. The flag is **per-preset** and persisted in `prompt_presets.advanced_mode`.

When advanced mode is active:

- The Prompt Manager UI shows an editable canvas (`PromptOrderCanvas`) instead of the basic fields.
- The preset stores an explicit `promptOrder: PromptOrderEntry[]` (identifier, enabled, order, kind).
- **Custom injections** become the primary authoring surface — each injection has its own `identifier`, `name`, `content`, `role`, `depth`, `injectionPosition`, `injectionOrder`, `enabled`.
- Built-in slots (`main`, `jailbreak`, `authorsNote`, `chatHistory`, `worldInfoBefore/After`, `charDescription`, `charPersonality`, `scenario`, `personaDescription`, `dialogueExamples`) participate in the same order list and can be reordered/toggled.

### `enabled` flag — authoritative source

There are two places where enabled state lives:

1. `customInjections[i].enabled` — the toggle on the injection row in the UI.
2. `promptOrder[identifier].enabled` — the toggle on the slot/marker in the prompt-order canvas.

For **custom injections**, the **authoritative source is `customInjections[i].enabled`**. `promptOrder` is used only for `order`/`placement` (matching SilkyTavern semantics).

For **built-in slots** (`main`, `jailbreak`, `authorsNote`, etc.), the authoritative source is `promptOrder[identifier].enabled` because there is no `customInjections` entry for them.

The UI (`InjectionTable.tsx`) keeps both flags in sync for custom injections when the row toggle is clicked — but the assembly layer only consults the authoritative source, so a desynced `promptOrder` entry cannot disable a custom injection.

### Importing ST presets

ST preset JSON imports fill both `customInjections` and `promptOrder` from the original `prompts` and `prompt_order` arrays. The import preserves each entry's `enabled` flag as-is; toggling re-enables an injection through the same UI flow.

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
| `assemble.test.ts` | Layer creation, sorting, mode filtering, compaction |
| `macro-resolution.test.ts` | All macro types, variables, conditionals, random, roll, nested if |
| `lore-activation.test.ts` | Lore keyword matching, logic operators, cooldown, group weights |
| `macros.test.ts` | Legacy macro tests (skipped — module removed) |
| `prompt-order.test.ts` | Prompt order overrides and ST-compatible insertion positions |
| `st-injections.test.ts` | SillyTavern-style prompt injections and placement behavior |
