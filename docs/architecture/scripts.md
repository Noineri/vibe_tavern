# Scripts

> **`services/api/src/domain/scripts-engine/script-sandbox.ts`** — the `node:vm` sandbox that runs user-authored JavaScript. **`services/api/src/domain/prompt/prompt-resolver.ts:executeScripts`** — the caller that loads, runs, and persists script state. **`apps/web/src/components/build/editors/script-templates/*.js`** — the shipped template bodies.

---

## Overview

A **script** is a snippet of user-authored JavaScript that runs **once per generated turn**, after lore activation and before prompt assembly. It can mutate the character's `personality` / `scenario` fields, inject extra messages into the prompt, and keep persistent per-chat state. Scripts are the bespoke, code-first counterpart to lorebooks: where a lorebook is a declarative table of keyword→text rules evaluated by an engine, a script is arbitrary code evaluated in a sandbox.

VT scripts are modeled on **Janitor AI's** scripting API, not SillyTavern's. The lineage is visible in the conventions: snake_case aliases (`last_message`, `message_count`, `inject_message`) mirroring JAI's surface, the `{ code, script }` JSON import shape that `parseScriptImport` accepts, per-character binding, and the `context.chat` / `context.character` shape. SillyTavern has no comparable freeform per-turn JS feature (its closest surfaces — Quick Reply scripts and the slash-command system — are a different model), so there is no ST parity to speak of here. See [Lineage: Janitor AI, not SillyTavern](#lineage-janitor-ai-not-sillytavern).

Scripts sit **between lore activation and prompt assembly** in the layer pipeline:

```
System preset layer        ← always present
Character description      ← always present
Lorebook entries           ← activated this turn, positioned by entry.position
                           ← ── scripts run HERE ──
                           ←   • read context.lore.activeEntries
                           ←   • mutate character.personality / scenario
                           ←   • push context.chat.injectMessage(...) outputs
Chat history               ← script-injection layers land at depth 0 (right before last message)
```

The script step is the only pipeline stage that runs **arbitrary user code**. Everything else (preset, character, lore, persona) is data assembly.

---

## Data Model

### Script (`packages/domain/src/entities.ts`)

| Field | Purpose |
|-------|---------|
| `scopeType` | `global` / `character` / `persona` / `chat` — the script's **home scope** (its primary owner) |
| `sortOrder` | Execution order within a turn — ascending. The resolver sorts the active set by this before running |
| `enabled` | Master switch. Disabled scripts are never loaded by the resolver |
| `code` | Raw JavaScript source, run verbatim in `node:vm` |
| `characterId` / `personaId` / `chatId` | Legacy FK columns — the **home scope** binding. Retained as the primary owner; `script_links` layers M:N on top |
| `extensions` | Free-form JSON bag (`extensions_json` column). Not read by the engine; available for editor metadata |

The `scopeType` + one FK column form the home scope. **M:N link-binding** (one script activating across multiple characters/personas without duplication) is layered on top via the `script_links` junction — see [Scope Resolution](#scope-resolution).

### `script_links` junction (`packages/db/src/db-schema.ts`)

Mirrors `lorebook_links`. A row `{ scriptId, targetType, targetId }` binds a script to an **additional** character or persona beyond its home-scope FK. Composite PK `(scriptId, targetType, targetId)` makes links idempotent. `ON DELETE cascade` on `scriptId` cleans up links when a script is deleted.

Chat-scoped scripts stay 1:1 via the `chatId` FK — `script_links` supports `character` / `persona` targets only, identical to lorebooks. Linking a script to another chat is semantically meaningless (different conversation).

### Per-chat state (`chats.script_state_json`)

`Record<scriptId, Record<string, unknown>>` serialised as JSON. Each script gets its **own bucket** keyed by id; buckets are isolated — script A cannot read script B's writes via `context.state` (they communicate only through the shared mutable channels: `character.personality`/`scenario` and `injectMessage`). Updated after every turn by `prompt-resolver.ts`. This is what makes the HP-tracker, dice-roller cache, and turn-counters survive across turns and server restarts.

---

## Execution Engine

Entry point: `executeScripts(input: ScriptExecutionInput): ScriptExecutionResult` in `services/api/src/domain/scripts-engine/script-sandbox.ts`. **Pure function** — no I/O, no DB. The caller (`prompt-resolver.ts`) loads the scripts, builds the input, persists the returned `updatedScriptState` back to the chat.

### High-level flow

```
executeScripts(input)
  │
  ├─ for each script in input.scripts (ITERATION ORDER = INPUT ORDER, see invariant below)
  │   ├─ init stateBucket from input.scriptState[script.id] (or {})
  │   ├─ build sandbox { context: {...}, Math, JSON, Date, ... allowlist }
  │   ├─ runInNewContext(script.code, sandbox, { timeout: 5000, filename })
  │   │    └─ on throw/syntax/timeout → capture to errors[], CONTINUE to next script
  │   └─ updatedScriptState[script.id] = { ...stateBucket }   ← INSIDE the try block
  │
  ▼
ScriptExecutionResult { character: {personality, scenario}, injectedMessages, updatedScriptState, errors }
```

### The `context` object

The script's only handle on the world. Built per-script from the input. All channels are either read-only (frozen, `Object.defineProperty` getters) or deliberately mutable.

**`context.chat`** — the conversation being generated for.
- `messages` — raw input array (`[{ message, role }]`)
- `lastMessage` — getter; `messages.at(-1)?.message ?? ""` (empty string when no messages)
- `messageCount` — getter; `messages.length`
- `injectMessage(content, role = 'system')` — pushes `{ content, role }` to the output channel. `role` is `'system' | 'user' | 'assistant'`. This is how scripts add prompt content without mutating character fields
- Janitor-AI snake_case aliases (getter-backed, same source): `last_message`, `message_count`, `inject_message`

**`context.character`** — the character being roleplayed. `name` is read-only; `personality` and `scenario` are getter/setter pairs backed by a shared mutable object — assignment propagates to the result.
- `name` — plain property (read-only in effect: assignment mutates a local copy the engine discards)
- `personality` — get/set
- `scenario` — get/set

**`context.lore.activeEntries`** — `Object.freeze`'d array of `Object.freeze`'d `{ title, content, keys }` snapshots of the lore entries that activated this turn. Read-only; mutation silently fails (or throws in strict mode, caught as an error). This is the bridge from the lore engine to scripts.

**`context.state`** — the per-script persistent bucket.
- `get(key, defaultValue?)` — **Map.get-style**: returns `defaultValue` when the key is absent. Without the second argument, returns `undefined` for missing keys. (The `defaultValue` parameter is required for the HP-tracker pattern — see [Engine Invariants](#engine-invariants).)
- `set(key, value)`
- `increment(key, amount = 1)` — adds to an existing number (or 0 if absent), returns the new total

**Utility context** — pure helpers.
- `random()` — `Math.random()`
- `randomInt(min, max)` — inclusive integer
- `pick(arr)` — uniform random element
- `weightedPick(items)` — each item has a `weight` field; weighted random selection

### Sandbox globals (allowlist)

The VM context exposes only: `Math`, `JSON`, `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Array`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Map`, `Set`, `Error`, and a silenced `console` (`log`/`warn`/`error` are no-ops so debug calls don't pollute server logs). **`process`, `require`, `globalThis`, `fetch`, and the filesystem are NOT exposed** — scripts cannot exfiltrate data or touch the host. See [Engine Invariants](#engine-invariants).

---

## Engine Invariants

Pinned by `services/api/test/script-sandbox.test.ts`. These are non-obvious contracts that a refactor could silently break.

### 1. The engine does NOT sort scripts — the caller does

`executeScripts` iterates `input.scripts` **verbatim**. Sorting by `sortOrder` is the caller's responsibility:
- `prompt-resolver.ts` (production): `.sort((a, b) => a.sortOrder - b.sortOrder)` before calling.
- `script-test-service.ts` (test panel): single script, no sort needed.

A future change to sort inside the engine would double-sort in production and change test-panel semantics. Pinned in `executeScripts — execution order`.

### 2. Pre-throw state writes are NOT persisted

`updatedScriptState[id] = { ...stateBucket }` runs **inside** the `try` block, after `runInNewContext` returns. If the script throws, that line is skipped — so `state.set('hp', 50)` calls made before the throw are lost.

Consequence for users: a script that decrements HP then throws does not get its HP change persisted. If state resilience against errors is wanted, the snapshot must move outside the try — but that is a behaviour change, not a fix, and would update the pinned test. See `executeScripts — error handling > a script that errors does NOT persist its pre-error state`.

### 3. `state.get(key, default)` honours the default

The HP-tracker template does `const hp = context.state.get('hp', 100)`. Before the 2026-06-29 fix, the sandbox's `get` took one parameter and the default was silently ignored — `hp` came back `undefined`, `undefined - dmg = NaN`, and the tracker produced `[HP] NaN/100` on first run. Now `get` accepts `(key, defaultValue?)` and returns the default when the key is undefined. Pinned by the REGRESSION test in `script-templates.test.ts — hp.js`.

### 4. Per-script state is isolated

Each script gets its own bucket from `scriptState[script.id]`. Script A's `state.set('x', 1)` is **not** visible to script B's `context.state.get('x')` — they communicate only via the shared mutable channels (`character.*`, `injectMessage`). Cross-script coupling through `state` would be a silent contract change. Pinned in `executeScripts — execution order > state written by an earlier script is NOT visible to a later script`.

### 5. Errors do not abort siblings

A throwing/syntax-erroring/timing-out script is captured to `errors[]` and the loop continues to the next script. One bad script cannot break prompt assembly for everyone. Pinned in `executeScripts — error handling`.

### 6. The 5s VM timeout is the only runaway-code defence

`runInNewContext(..., { timeout: 5000 })` kills infinite loops. There is no instruction-count limit; the wall-clock timeout is the sole backstop. Pinned in `executeScripts — error handling > an infinite loop is killed by the 5s VM timeout`.

---

## Pipeline Integration

The resolver runs scripts **after** `listActiveLoreEntries` and **before** `assemblePrompt`. Three output channels feed the pipeline:

| Script output | Pipeline destination |
|---------------|----------------------|
| `character.personality` (mutated) | `assemblePrompt.character.personality` — replaces the raw DB value for this turn only |
| `character.scenario` (mutated) | `assemblePrompt.character.scenario` — same |
| `injectedMessages[]` | `assemblePrompt.chat.scriptInjections` → becomes `in_chat` layers at `injectionDepth = 0` (right before the last message), `priority = 200 + i`, `sourceType = 'script_injection'` |

Character mutations are **non-persistent** — the DB row is not touched, only the per-turn prompt sees the mutated text. The next turn reads the original `character.personality` again and the script re-mutates it (possibly differently, based on new `messageCount` or state).

`injectedMessages` layers are visible in the prompt trace as `script_injection` source-type badges. See `packages/prompt-pipeline/src/assemble.ts` around the `Script-injected messages` block.

### Trace data

`prompt-assembly-service.ts` builds a `scriptInjections` trace entry when the script step had **any** observable effect (errors, personality/scenario mutation, or injected messages). The trace row carries the mutated personality/scenario, the injected messages, and any error string — so the prompt trace explains what scripts did this turn.

---

## Scope Resolution

`ScriptStore.listAllEnabledForChat(characterId, personaId, chatId)` is the resolver entry point. It builds an enabled-script set from **two** sources, then sorts by `sortOrder`:

1. **FK-scoped** (home scope): `global` ∪ `character(FK=characterId)` ∪ `persona(FK=personaId)` ∪ `chat(FK=chatId)`.
2. **Junction-linked** (`script_links`): all scripts M:N-linked to `characterId` or `personaId`.

The resolver consults **both** sources with `Set`-based dedup by id. This is deliberate: the `script_links` migration is incremental, so FK-owned scripts created the normal way (via `createScript`, which does **not** mirror the FK into the junction) would be silently dropped if the resolver were junction-only. `LorebookStore.listAllActiveForChat` uses the same FK ∪ junction shape (fixed 2026-06-29 — previously it was junction-only for char/persona, which was a real bug; see `packages/db/test/lorebook-fk-activation.test.ts`). The two resolvers are now consistent.

Editor tabs (`listByScope`) also union FK ∪ junction for character/persona scopes, so a script appears in a character's editor tab iff it activates for that character — no editor/resolver divergence. Chat scope remains FK-only (1:1, no junction).

### Link management

`ScriptStore` exposes `getLinks` / `setLinks` (transactional replace) / `addLink` (idempotent) / `removeLink` / `listScriptsLinkedToTarget` (reverse query for the editor view). The UI binds scripts to targets via `LinkBindingPopover` in both directions: from the character/persona editor (`BoundResourcesField` lists scripts bound to this target) and from the script editor (`ScriptEditor` lists targets this script is bound to). Mirrors the lorebook binding UI.

---

## Persistence

### Database schema (`packages/db/src/db-schema.ts`)

- **`scripts`** — the script rows. Indexed on `characterId`, `personaId`, `chatId`, `scopeType`.
- **`script_links`** — M:N junction (see above). Indexed on `(targetType, targetId)` and `scriptId`.

### Dual-write to disk

`ScriptStore` dual-writes every script as a canonical JSON file under `data/scripts/` (via `ContentStore.writeEntity`). The `has_file_on_disk` / `content_hash` columns track the file. Reads lazy-migrate: if `has_file_on_disk === 0`, the store regenerates the file from the DB row. This mirrors the lorebook / character dual-write pattern.

### Per-chat state round-trip

1. `prompt-resolver.executeScripts` reads `chat.scriptState` (typed `Chat.scriptState`, parsed from `script_state_json`).
2. Passes it as `scriptState` to `executeScripts`.
3. `executeScripts` returns `updatedScriptState` (the post-run buckets).
4. Resolver persists via `chat-store.updateScriptState(chatId, state)`. Persistence failures are swallowed (the pipeline does not crash on a state-write error).

---

## UI Editor

`apps/web/src/components/build/editors/ScriptEditor.tsx` (`useScriptPanel` hook). Follows the project's progressive-disclosure pattern.

- **List view** — scope-filtered script list with ON/OFF badges.
- **Editor panel** — name, description, enabled toggle, delete; the `LinkBindingPopover` for forward binding (script → characters/personas); a `CodeEditor` for the body; a templates row; a test panel.
- **API Reference** — an in-panel collapsible that documents `context.chat.*`, `context.character.*`, `context.state.*`, `context.lore.*`. This is the canonical user-facing API doc; keep it in sync with `script-sandbox.ts` when adding context fields.
- **AI Assistant** — `AiAssistantModal` in `script` mode can generate/replace script code.
- **Test panel** — runs the script against a simulated `lastMessage` and renders five independent output channels: errors, personality output, scenario output, injected messages (with role badges), and the resulting script state (JSON). Independent rendering matters: a script that injects a dice roll but touches no personality field still shows its output, rather than the old "no result" placeholder.

### Templates (`script-templates/*.js`)

Eight shipped templates, each a standalone `.js` file loaded as a raw string via Vite `?raw` imports in `script-templates/index.ts`. Keys mirror the i18n keys `script_template_<key>` in `apps/web/src/i18n/locales/*.json`.

| Key | Purpose |
|------|---------|
| `relationship` | Personality evolves with conversation length (message-count branches) |
| `events` | Keyword-triggered scenario events + a 10th-message milestone |
| `memory` | Remembers hobbies/preferences mentioned ≥ 10 messages ago |
| `lorebook` | Keyword→backstory, with a trust-gated secret at > 15 messages |
| `advanced_lore` | Mini lore-engine: priorities, `notWith`/`requiresAny`/`requiresAll` filters, recursive trigger activation |
| `hp` | Persistent HP with damage/heal; `state.get('hp', 100)` is the canonical use of the default-arg fix |
| `dice` | `/roll dN[+M][ adv|dis]` parser; output via `injectMessage`; per-message cached for stable regen |
| `random` | 5%-chance ambient event each turn |

Every template is covered by `services/api/test/script-templates.test.ts`, which loads the bodies via `Bun.file()` and runs them through the real sandbox. This is the regression net for the engine invariants (the HP and dice tests are explicitly tagged REGRESSION).

---

## Lineage: Janitor AI, not SillyTavern

VT scripts trace to **Janitor AI's** scripting model, not SillyTavern. The code is explicit about this: the snake_case aliases in `script-sandbox.ts` are labelled "Janitor aliases" (see the comment above `last_message`), and `parseScriptImport` accepts the `{ code, script }` JSON shape used by JAI exports. The `context` shape (`chat` / `character` / `lore` / `state`) and per-character scoping follow the same convention.

The parity is **loose, not exact**: VT does not replicate JAI's full API surface, and a script written for JAI may need light porting (mainly around which `context.*` fields exist and how state is namespaced per script). It is a borrowed convention, not a compatibility shim.

**SillyTavern is a different parentage.** ST has no freeform per-turn-JS feature equivalent to VT/JAI scripts. Its extension surfaces — Quick Reply scripts (button-triggered), the slash-command system, the iframe `postMessage` API, the `event_types` lifecycle hooks — are a different model: event-driven, browser-iframe-sandboxed, not server-side-per-generation-turn. None of those are implemented in VT, and none were ever a target. VT's **lorebook** system is the ST parity surface (see `lorebooks.md`); VT's **script** system is not, and is not planned to become one.

Where a user expects to run an ST extension script unmodified in VT: it will not work, and there is no plan to make it work — the two systems solve different problems.

---

## References

- **Code**
  - `services/api/src/domain/scripts-engine/script-sandbox.ts` — the engine (`executeScripts`, context builders)
  - `services/api/src/domain/scripts-engine/script-test-service.ts` — `testScript` (test-panel backend) + `parseScriptImport`
  - `services/api/src/domain/prompt/prompt-resolver.ts` — `executeScripts` method: loads scripts, runs, persists state
  - `services/api/src/domain/prompt/prompt-assembly-service.ts` — pipeline integration; script output → `assemblePrompt` + trace
  - `packages/prompt-pipeline/src/assemble.ts` — `scriptInjections` → `in_chat` layers at depth 0
  - `packages/domain/src/entities.ts` — `Script` entity
  - `packages/db/src/db-schema.ts` — `scripts`, `script_links` tables; `chats.script_state_json`
  - `packages/db/src/stores/script-store.ts` — CRUD + link management + `listAllEnabledForChat` (resolver entry point)
  - `packages/db/src/stores/chat-store.ts` — `updateScriptState` (per-chat state persistence)
  - `services/api/src/api/routes/script.ts` + `adapters/script-adapter.ts` — HTTP routes + adapter
  - `apps/web/src/components/build/editors/ScriptEditor.tsx` — UI (`useScriptPanel`)
  - `apps/web/src/components/build/editors/script-templates/` — shipped template bodies + typed registry
  - `apps/web/src/components/shared/LinkBindingPopover.tsx` + `BoundResourcesField.tsx` — binding UI (shared with lorebooks)

- **Tests**
  - `services/api/test/script-sandbox.test.ts` — engine characterization (37 tests, the 6 invariants)
  - `services/api/test/script-templates.test.ts` — template coverage (23 tests, 2 REGRESSION)
  - `packages/db/test/script-store.test.ts` — store CRUD + link management + FK∪junction resolution

- **Planning repo** (`vibe_tavern_plan/`)
  - `reports/script-link-binding-gap.md` — the M:N link-binding gap analysis + execution log (the `script_links` junction shipped from this report)
