# Lorebooks

> **`services/api/src/domain/prompt/lore-activation-engine.ts`** — pure activation engine. **`packages/prompt-pipeline/src/assemble.ts`** — layer creation + position mapping. Lorebooks are the SillyTavern-compatible "World Info" system: keyword-triggered, context-budgeted knowledge injection.

---

## Overview

A **lorebook** is a named collection of **entries**. Each entry has a piece of
text ("Alice carries a golden pocket watch") and a set of **keys** that trigger
when to inject that text into the prompt ("alice", "watch", "pocket"). The user
binds lorebooks to characters, personas, or chats; the activation engine
decides per turn which entries fire, and the prompt pipeline places their
content at the right depth/position in the final payload.

The feature is a deliberate SillyTavern (ST) parity surface. ST's World Info
module is the de-facto standard for AI roleplay card ecosystem, so VT
preserves its field names, its activation algorithm, and its budget semantics
to make ST card imports lossless. Where VT diverges, it is either a bug to
fix or a documented bonus — see [SillyTavern Parity](#sillytavern-parity)
and the planning repo's `lorebook-st-parity-audit.md` for the full audit.

Lorebooks sit **after** the prompt preset and **before** chat history in the
layer stack. A typical prompt assembly looks like:

```
System preset layer        ← always present
Character description      ← always present
WorldInfo Before (WIBefore) ← lorebook entries at position before_char
WorldInfo After  (WIAfter)  ← lorebook entries at position after_char
Lorebook at-depth injects  ← interleaved with chat history at depth N
Chat history               ← trimmed by compaction if needed
```

---

## Data Model

### Lorebook (`packages/domain/src/entities.ts`)

The container. Settings here are **per-book** — they constrain all of the
book's entries together.

| Field | Purpose |
|-------|---------|
| `scopeType` | `global` / `character` / `persona` / `chat` — who the book is bound to |
| `scanDepth` | How many recent chat messages to scan for keys (N from the bottom) |
| `tokenBudget` | Fixed token budget for this book's entries (when `tokenBudgetPercent` is null) |
| `tokenBudgetPercent` | Context-% mode — `round(maxContext × percent / 100)`, capped by `tokenBudget`. ST parity: `null` = fixed mode |
| `useGroupScoring` | Group Scoring — book-level default for entries whose `useGroupScoring` is `null` (inherit). ST's global `world_info_use_group_scoring` switch maps onto this on directory import (D9) |
| `recursiveScanning` | Whether Pass 2+ (recursion) runs at all |
| `maxRecursionSteps` | Hard cap on recursion passes |
| `minActivations` | Engine widens scan depth if fewer than N entries match — retry loop |
| `minActivationsDepthMax` | Upper bound for the min-activations depth skew |
| `includeNames` | Prefix each entry's content with `[title]` |
| `overflowAlert` | UI-only: warn when budget overflows |
| `enabled` | Master switch |

### LoreEntry (`packages/domain/src/entities.ts`)

A single knowledge fragment. Its 40+ fields group naturally:

**Matching**
- `keys: string[]` — primary triggers; matched against scan text (regex `/pattern/flags` supported, otherwise literal substring or whole-word)
- `secondaryKeys: string[]` — additional conditions combined via `logic`
- `logic` — `and_any` (default) / `and_all` / `not_any` / `not_all`
- `caseSensitive`, `matchWholeWords`
- `matchSources` — which text sources to scan (chat, character description, persona, author's note, etc.). VT bonus — ST scans only chat.

**Positioning**
- `position` — ST-style: `before_char` / `after_char` / `before_examples` / `after_examples` / `top_an` / `bottom_an` / `at_depth` / `outlet` (plus pipeline-native `before_prompt` / `in_prompt` / `in_chat` / `hidden_system`)
- `depth` — for `at_depth`, how deep in chat history to inject
- `role` — `system` / `user` / `assistant` — the message role of the injected content
- `priority` — tie-breaker for budget overflow (see [Budget & Priority](#budget--priority-the-truth))

**Time windows (VT bonus — ST has these too as of recent versions)**
- `stickyWindow` — entry stays active for N turns after first activation, no re-roll. The window is anchored at first activation and NEVER extended while alive (only-if-absent, LG-12)
- `cooldownWindow` — entry cannot reactivate for N turns after activation; when sticky+cooldown are both set, the cooldown is re-anchored at the sticky END (handoff) and a live sticky overrides it (entry keeps activating until the window closes)
- `delayWindow` — first match sets a pending state; entry activates N turns later; never re-arms after fulfillment

**Recursion**
- `excludeRecursion` — entry never participates in recursion scans
- `preventRecursion` — entry's content is NOT added to the recursion buffer (others can't match against it)
- `delayUntilRecursion` — entry only activates during a recursion pass at its `recursionLevel` or deeper
- `recursionLevel` — paired with `delayUntilRecursion`

**Inclusion group (entries compete)**
- `groupName` — comma-separated list of groups this entry belongs to
- `groupWeight` — weight for the weighted-random pick (rolls happen among scoring survivors, or over the whole group when scoring is off; default 100)
- `prioritizeInclusion` — auto-wins its group, checked AFTER the scoring filter (ST: `groupOverride`)
- `useGroupScoring` — tri-state: `true` / `false` explicit, `null` = inherit the book default. When scoring is on for a group, members below the group's max match count are REMOVED — a strict filter, not an arbiter; unflagged members are immune to the removal (see the per-pass pipeline below)

**Filters & odds**
- `constant` — always active, skip key matching
- `probability` — 0–100, per-entry roll on activation
- `ignoreBudget` — entry bypasses token budget (always included if activated)
- `characterFilter` — list of `{ id, name }` (ghost = name-only ref); `characterFilterExclude` flips match→block
- `enabled` — master switch

### Activation state (`LoreActivationState`)

Persisted **per chat** in `chats.lore_activation_state_json`. Maps
`entryId → { activatedAtTurn, lastMatchedAtTurn, pendingDelayUntilTurn }`.
This is how sticky/cooldown/delay survive across turns — without it, an entry
marked "stay active for 5 turns" would lose count on every page reload.
`activatedAtTurn` anchors the sticky window, `lastMatchedAtTurn` anchors the
cooldown; both are written only-if-absent (live windows never extend — LG-12),
and an expired sticky anchor is cleared by the engine's expiry sweep, never
left stale.

### Activation reasons (`LoreActivationReason`)

A discriminated union surfaced on the prompt trace so users can see **why**
each activated entry fired. Five kinds, matching the five activation paths
inside the engine:

| Kind | Trigger |
|------|---------|
| `constant` | `constant: true` — always active (step 4) |
| `sticky` | Inside `stickyWindow` after prior activation (step 5); carries `turnsSinceActivation` + `window` |
| `delay_fulfilled` | `delayWindow` elapsed — pending state now fulfilled (step 7) |
| `decorator` | `@@activate` at start of content forced activation without a key match (step 8/12) |
| `key_match` | A primary key matched; carries `matchedKeys`, `matchCount`, `scanState: "normal" \| "recursion"` |

Scope: **activated entries only**. Skip reasons (`cooldown`, `no key match`,
`character filter`, `probability failed`, ...) are computed inside the engine
for `console.debug` but deliberately not surfaced — they would bloat every
trace row. See [Trace Integration](#trace-integration).

---

## Activation Engine

Entry point: `resolveActivatedEntries(input: ActivationInput): ActivationResult`
in `services/api/src/domain/prompt/lore-activation-engine.ts`. Pure function —
no I/O, no DB. The caller (`prompt-resolver.ts`) loads the lorebooks, builds
the `ActivationInput`, persists the returned `updatedState` back to the chat.

### High-level flow

```
resolveActivatedEntries(input)
  │
  ├─ 1. Flatten entries from all lorebooks + book group-scoring defaults
  ├─ 1b. Sticky-active snapshot (input state) + sticky-expiry sweep
  │      ← clears expired anchors once, hands cooldown over to the expiry scan
  ├─ 2. Pass 1: Normal scan         ← tryActivateEntry() per entry
  │     └─ min-activations retry loop (widens scan depth if too few matches)
  ├─ 3. Pass 2+: Recursive scans    ← scanText + recurseBuffer
  │     └─ delay-until-recursion level advancement
  │     (EVERY pass, 2 and 3 alike, then runs the per-pass pipeline:)
  │       collect candidates → sticky-first sort → inclusion-group pipeline
  │       → probability gate → survivors commit state + seed recursion buffer
  ├─ 4. Include-names prefix        ← optional [title] prepended
  ├─ 5. Sort: sticky-first → priority desc → id (budget consumption order)
  ├─ 6. Token budget                ← per-book budget filter on sorted list
  │
  ▼
ActivationResult { activatedEntries, updatedState }
```

### Per-entry activation (`tryActivateEntry`)

Twelve sequential gates. First gate that rejects returns `{ status: "skipped" }`
(with a `console.debug` reason); the first gate that accepts returns
`{ status: "activated", ... }` with a structured `reason`. Timed-window
ANCHORING (sticky/cooldown writes) is NOT here — it lives in the per-pass
survivor loop and the expiry sweep (see below), because only pass survivors
persist activation state. Probability is not a gate here either: it rolls
AFTER the per-pass group pipeline (LG-11).

| Step | Gate | On reject |
|------|------|-----------|
| 0 | `enabled === false` / already activated this resolve | skip |
| 1 | Character filter | skip: "character filter" |
| 2 | Recursion context (`excludeRecursion`, `recursionLevel` not reached) | skip: "recursion level not reached" |
| 3 | `@@activate` / `@@dont_activate` decorator on first line of content | decorator forces on, or `@@dont_activate` forces skip |
| 4 | `constant: true` — the inline cooldown gate applies UNLESS the sticky window is live (ST `isCooldown && !isSticky`) | activated: `constant` reason / skip: "cooldown" |
| 5 | Sticky window live | activated: `sticky` reason (carries turns/window) |
| 6 | Cooldown live | skip: "cooldown" |
| 7 | Delay window — pending fulfilled | activated: `delay_fulfilled` reason |
| 8 | Key matching (skipped if `@@activate` decorator) | skip: "no key match" |
| 9 | Secondary keys + `logic` (AND/NOT) | skip: "secondary keys fail" |
| 10 | Delay first-match arm (only when BOTH anchors are absent — never re-arms) | skip: "delay window set" (deferred to future turn) |
| 11 | Activate — return (state persists later, in the survivor loop) | activated: `decorator` or `key_match` reason |

The reason assigned at step 11 is **either `decorator` (if `@@activate` forced
its way through) or `key_match` (normal path)**. The `scanState` field on a
`key_match` reason distinguishes "matched during Pass 1 normal scan" from
"matched during Pass 2+ recursion scan".

### Recursion pass

After the normal scan, if any lorebook has `recursiveScanning: true` AND at
least one normal-pass entry contributed content to the recursion buffer:

1. For each entry not yet activated, scan `originalScanText + "\n" + recurseBuffer`.
2. Entries marked `preventRecursion` are excluded from the buffer (their
   content doesn't seed further matches).
3. Entries marked `delayUntilRecursion` only activate once the loop's current
   recursion level reaches their `recursionLevel`. Levels advance when a full
   pass yields zero new activations.
4. Loop ends at `maxRecursionSteps` or when no delay levels remain.

Each recursion-pass activation carries `scanState: "recursion"` on its
`key_match` reason, so the trace can distinguish "matched a primary key in
chat" from "matched a key that appeared in another lore entry's output".
Recursion activations run through the SAME per-pass group pipeline as the
normal scan — and an earlier pass's group winner LOCKS its group, so a new
recursion candidate for the same group is removed (raw-string group
equality; a comma-group winner locks only the exact comma string).

### Per-pass pipeline: inclusion groups + probability

The group pipeline no longer runs once over the final activated list — it
runs INSIDE every scan pass (normal and recursion alike), right after the
pass's candidates are collected (LG-5; ST runs `filterByInclusionGroups`
inside the scan loop). Removals are **not** reflected in the activation
`reason` (the entry thought it activated, then lost in competition). See
[Trace Integration](#trace-integration) for the design implication.

Per-pass order:

1. **Sticky-first sort** — pass candidates ordered sticky-active first (from
   the input-state snapshot), stable otherwise. This order governs group
   resolution order, the probability gate, and budget consumption (ST
   world-info.js 4881-4886).
2. **Group pipeline** (`applyInclusionGroups`), per group:
   - **Sticky dominance** (pass 0): a group with sticky-active members keeps
     only them; scoring, locking, override and rolls are all skipped and
     EVERY sticky member survives (no single winner) — LG-6, ST
     `filterGroupsByTimedEffects`.
   - **Scoring filter**: if the group qualifies (any member explicitly
     `useGroupScoring: true`, or its book default is on), members whose
     `groupScore` (match count) is below the group max are removed. A
     FILTER, not an arbiter: unflagged members are immune to the removal but
     still count toward the max. Removal splices only this group's array, so
     a multi-group member removed in one group keeps competing in its other
     groups (ST "ghost" membership).
   - **Lock**: an earlier pass's winner for this group removes ALL new
     candidates (checked before the ≤1 guard — even a lone new candidate is
     removed; D7b).
   - **≤1 rule**: a group left with 0 or 1 candidates is done — a lone
     survivor just stays.
   - **Override**: any member with `prioritizeInclusion: true` → the
     highest-priority one wins, others removed.
   - **Weighted roll**: otherwise one winner by weighted random over
     `groupWeight`.
3. **Probability gate** (per survivor, AFTER the filter — LG-11, ST
   `verifyProbability`): survivors with `probability < 100` roll;
   sticky-active auto-passes. A failure is permanent for the whole resolve
   (never retried in later passes), leaves the survivor's group EMPTY (its
   competitors were already removed), seeds no recursion, and commits no
   activation state. Constants roll here like everyone else.

**State writes** happen in the survivor loop after the pipeline: only
entries that survived the whole pass persist activation state — group losers
and probability failures never write anchors.

**Token budget** (`applyTokenBudget`): per-lorebook budget (fixed or
context-%). Runs ONCE at the end over the merged, sorted survivor list;
entries that don't fit are dropped. `ignoreBudget: true` entries bypass the
check entirely.

### Timed-window anchoring (LG-12)

Anchors are written only-if-absent (ST `#setTimedEffectOfType`): a live
window is never extended by re-activation.

- A **sticky-expiry sweep** runs once per resolve, BEFORE any pass, over the
  input state: an expired sticky anchor is cleared exactly once (a cleared
  anchor cannot re-fire) and the cooldown is handed over to the expiry scan —
  a fresh full window anchored THERE (ST's `onEnded` callback). The next real
  activation anchors a fresh sticky window.
- While a sticky window is live, the entry auto-activates every scan without
  key matching, and a live sticky OVERRIDES cooldown (ST `isCooldown &&
  !isSticky`) — constants included.
- `commitActivationState` anchors per path: constants keep live anchors
  (anchor fresh otherwise); the sticky path keeps the sticky anchor (alive by
  construction) and only sets a MISSING cooldown anchor; key-match /
  decorator / delay-fulfilled activations write a fresh dual anchor (their
  gates guarantee no live window exists).

### Budget & Priority (the truth)

This is the most-misunderstood part of the system, so it gets its own section.

**Priority is NOT only for visual ordering.** Priority is the tie-breaker
that decides which entries **survive budget overflow**. Mechanism:

1. `activated.sort(sticky-first → priority desc → id asc)` — the merged
   survivor list is sorted before budgeting. The sticky tier (LG-11) makes
   this the budget CONSUMPTION order: ST consumes the budget in the scan
   loop's sticky-first candidate order (world-info.js 4881-4893), so a sticky
   survivor must not lose its queue position to a plain priority sort.
2. `applyTokenBudget` iterates this sorted list and accumulates used tokens.
3. Once a lorebook's budget is exhausted, every subsequent entry from that
   book (lower priority) is dropped.

Net effect: **higher-priority entries consume the budget first and survive;
lower-priority entries are evicted when the budget runs out.** This is
identical to SillyTavern, which sorts by `order` (= priority) descending
(`world-info.js`'s `sortFn = (a, b) => b.order - a.order`) and breaks its scan
loop on `token_budget_overflowed`.

`ignoreBudget: true` exempts an entry from this eviction — useful for
lore that must always ship (e.g. core character traits).

---

## SillyTavern Parity

Full audit: `vibe_tavern_plan/archive/lorebook-st-parity-audit.md`. Summary:

### Matches 1-в-1 (ST behaviour preserved)
- Scan depth (mechanic; default differs)
- Recursive scanning, `excludeRecursion`, `preventRecursion`
- Activation states (constant / conditional / disabled)
- Selective logic (AND/NOT on primary/secondary keys)
- Probability roll
- Character filter (include/exclude)
- At-depth injection
- Auxiliary lorebook stacking (global / character / chat scopes)
- Case sensitivity / match whole words
- Inclusion groups (LG-1–LG-8: strict-loser scoring filter, tier order, per-pass pipeline with earlier-winner locks, book-level default + tri-state entry flag, import mapping)
- Sticky dominance in groups (LG-6)
- Probability: post-group roll, permanent failures, sticky auto-pass, constants included (LG-11)
- Timed windows: only-if-absent anchoring, sticky-end cooldown handoff, sticky-over-cooldown override (LG-12)
- Order / priority overflow resolution
- Author's Note positioning (preset-level)

### Known divergences (audit-flagged)
- **Token budget default** differs from ST.
- **`World Info Before/After` markers**: only `before_char` / `after_char`
  entries map onto the WI prompt-order markers; other ST positions route to
  their own slots and must not be dropped when a WI marker is disabled. This
  was a real bug class — see parity audit §2.1.
- **`priority` vs `insertion_order` naming**: Janitor AI's exporter uses a
  different field name; the importer normalises. See parity audit §4.2.
- **Group scoring book-level default on import (D9)**:
  ST's group-scoring switch is a GLOBAL client setting, not part of any
  lorebook file. The ST **directory import** reads it from `settings.json`
  (`world_info_use_group_scoring`) and maps it onto every imported book
  (owner decision, 2026-08-31); single-file imports have no source for it
  and default `useGroupScoring: false`. Per-entry explicit flags
  (`useGroupScoring` top-level, mirrored to `extensions.use_group_scoring`
  by ST saves) DO import, preserved as tri-state (`true` / `false` /
  `null` = inherit the book default). See
  `LOREBOOK_GROUP_SCORING_PARITY_REPORT` (D9, LG-8).

### VT bonus features (not in ST, or richer than ST)
- `matchSources` — scan arbitrary text sources beyond chat (character
  description, persona, author's note, etc.).
- Time windows (`stickyWindow` / `cooldownWindow` / `delayWindow`) as
  first-class editor fields with persisted per-chat state.
- Structured activation reasons on the prompt trace — see below.

---

## Pipeline Integration

After activation, the resolver hands the surviving entries to the prompt
pipeline as `ActiveLoreEntry[]` (a `LoreEntry` extended with the activation
reason + matched keys for the trace). The pipeline, in `assemble.ts`,
converts each entry into a **prompt layer**.

### Position mapping (`assemble.ts`)

ST-style positions are mapped to the pipeline's four native positions:

| ST position | Pipeline position | Notes |
|-------------|-------------------|-------|
| `before_char` | `in_prompt` | Maps onto `worldInfoBefore` marker |
| `after_char` | `in_prompt` | Maps onto `worldInfoAfter` marker |
| `before_examples` / `after_examples` | `in_prompt` | Fine-grained via `subPosition` |
| `top_an` / `bottom_an` | `in_prompt` | Author's-note adjacency via `subPosition` |
| `at_depth` | `in_chat` | Interleaved into chat history at `entry.depth` |
| `outlet` | `hidden_system` | Available to scripts/macros but not in payload |

Pipeline-native positions (`before_prompt`, `in_prompt`, `in_chat`,
`hidden_system`) pass through unchanged. The `worldInfoBefore` /
`worldInfoAfter` markers are the **only** two positions whose prompt-order
visibility can drop an entry from the payload — other positions always render
(see parity audit §2.1 for why this matters).

### Layer creation

Each entry becomes a layer with:
- `id` — derived from the entry id (stable across turns for tracing)
- `sourceType: "lore_entry"` — drives trace badge rendering
- `sourceId` — entry id (used by the trace to look up activation reason)
- `position` / `subPosition` / `priority` / `role` / `injectionDepth` — from the entry
- `text` — `[title]\n<content>` (title prepended only if non-empty; `includeNames` is a separate per-book prefix applied earlier)

### Canvas override (advanced mode only)

In advanced mode, the canvas can override where `before_char` / `after_char`
entries land. The worldInfo slot's `{ zone, order, depth }` is authoritative:
`after_chat` → `in_chat` at depth 0; `in_chat` → `in_chat` at `slot.depth`;
`before_chat` → stays `in_prompt`. Other positions are never overridden by
the marker's zone. Simple mode ignores the canvas entirely.

---

## Persistence

### Database schema (`packages/db/src/db-schema.ts`)

Three tables:

- **`lorebooks`** — the containers, with all per-book settings.
- **`lore_entries`** — 40 columns mirroring `LoreEntry` one-to-one. Indexed by `lorebookId`.
- **`lorebook_links`** — junction table binding lorebooks to scopes
  (character / persona / chat). A lorebook itself carries a `scopeType`, but
  the link table enables many-to-many bindings (one global book linked to
  multiple characters, etc.).

### Per-chat activation state

`chats.lore_activation_state_json` — a `Record<entryId, ActivationStateRow>`
serialised as JSON. Updated after every turn via
`chat-store.ts: updateLoreActivationState(chatId, state)`. This is what makes
`stickyWindow` / `cooldownWindow` / `delayWindow` work across turns and
across server restarts.

### Prompt traces

Activated entries are persisted on each `prompt_traces` row in two parallel
columns:
- `activated_lore_entries_json` — array of entry ids (legacy, retained)
- `activated_lore_detail_json` — array of `{ id, title, reason }` (new; NULL for pre-migration traces maps to `[]`)

The split is deliberate: the id list stays cheap for clients that only need
to know "which entries fired", while the detail array carries the structured
reason for the trace UI. See [Trace Integration](#trace-integration).

---

## Trace Integration

The prompt trace shows each activated lorebook entry with a **reason badge**
next to its title, so users can debug why an entry fired. The badge is
color-coded by reason kind (`LoreReasonBadge` in
`apps/web/src/components/build/trace-payload-view.tsx`).

### What is shown
- Every entry in `activatedLoreDetail` renders a badge on its layer card or
  in-chat inject divider.
- Badge labels are i18n-localised (en + ru); key-match badges list the
  matched keys, sticky badges show `turnsSinceActivation/window`, recursion
  matches carry a `⟳` suffix.

### What is NOT shown (and why)
- **Skip reasons** (why an entry did NOT activate) — kept in `console.debug`
  only. Surfacing them would require a second UI block ("Skipped entries")
  because skipped entries have no card in the trace. Tracked as a future
  feature; see `vibe_tavern_plan/reports/lorebook-trace-conditions.md`.
- **Pipeline losses** — an entry whose activation was rejected by the
  per-pass group pipeline, the probability gate, or budget overflow is
  **not rendered in the trace at all**: the engine returns only the
  survivors, so losers never reach `activatedLoreDetail` (they have no layer
  card and no inject divider).
  This is deliberate — the trace is payload-faithful: it shows what actually
  reached the prompt, and a losing entry did not. A separate "why didn't it
  fire" inspector (skip reasons and losses together) remains an optional
  future feature; see
  `vibe_tavern_plan/reports/lorebook-trace-conditions.md`.

### Architecture note

`reason` is assigned inside `tryActivateEntry` (the final gate), which runs
**before** the per-pass group pipeline, the probability gate, and the budget
filter. This means the reason always reflects *why the entry activated*,
never *why it survived the pipeline or the budget*. If you need the latter, the
cleanest extension is a second optional field on `ActivationResult` populated
by `applyInclusionGroups` / `applyTokenBudget`, not loosening the existing
`reason` semantics.

---

## UI Editor

Lorebook editor lives in `apps/web/src/components/build/editors/`. Follows the
project's progressive-disclosure pattern (see ADs on progressive disclosure):

- **`LorebookAccordion`** — per-book settings (scan depth, token budget mode
  toggle, recursion, min-activations). Collapsible.
- **`LoreEntryList`** — the entry list with drag-and-drop reordering
  (`@dnd-kit/core` only — intentionally not `@dnd-kit/sortable` due to a
  cached-rect viewport bug; documented in the component).
- **`LoreEntryEditor`** — single-entry editor with a `advancedOpen` toggle.
  Simple mode shows only keys + content + position; advanced mode reveals
  time windows, recursion flags, inclusion-group fields, character filter,
  probability, and match sources.
- **`LorebookImportModal`** — SillyTavern V2/V3 + Janitor AI card import. Group-scoring entry flags import as tri-state; the directory import maps ST's global switch onto the book default, single-file imports default `false` (D9). Migration caveat (0058/0059): the book-level Group Scoring switch defaults to OFF for pre-existing books, and pre-tri-state explicit-`false` entry flags were migrated to `NULL` (inherit) — they resolve to the same OFF unless the book switch is enabled, so upgraded chats keep their pre-upgrade behavior until the user opts in. New entries default to Inherit (`null`).

The token-budget control in `LorebookAccordion` toggles between fixed mode
(`tokenBudget`) and context-% mode (`tokenBudgetPercent`). Null percent =
fixed mode; non-null percent = context-% mode. Both modes coexist because ST
exports both fields and VT preserves them on import.

---

## References

- **Code**
  - `services/api/src/domain/prompt/lore-activation-engine.ts` — activation engine (entry point: `resolveActivatedEntries`)
  - `services/api/src/domain/prompt/prompt-resolver.ts` — wires engine into assembly, persists activation state
  - `packages/prompt-pipeline/src/assemble.ts` — position mapping + layer creation
  - `packages/domain/src/entities.ts` — `Lorebook`, `LoreEntry`, `LoreActivationReason`, `ActiveLoreEntry`, `ActivatedLoreDetail`
  - `packages/db/src/db-schema.ts` — `lorebooks`, `lore_entries`, `lorebook_links` tables
  - `packages/db/src/stores/chat-store.ts` — `updateLoreActivationState` (per-chat state persistence)
  - `apps/web/src/components/build/editors/` — UI editors
  - `apps/web/src/components/build/trace-payload-view.tsx` — `LoreReasonBadge` + reason lookup

- **Planning repo** (`vibe_tavern_plan/`)
  - `archive/lorebook-st-parity-audit.md` — the full ST parity audit
  - `reports/lorebook-trace-conditions.md` — activation-reasons trace feature (IMPLEMENTED 2026-06-21)
  - `_archive/ST_LOREBOOK_ACTIVATION_GAP_REPORT.md` — historical gap analysis
  - `plans/VECTOR_LORE_ACTIVATION.md` — planned vector/RAG activation mode

- **SillyTavern reference** — `world-info.js` in the user's local ST install
  at `N:/SillyTavern/public/scripts/world-info.js`. The `sortFn` on line 88
  (`b.order - a.order`) and the budget loop starting around the
  `token_budget_overflowed` flag are the canonical reference for ST's
  priority-and-budget semantics.
