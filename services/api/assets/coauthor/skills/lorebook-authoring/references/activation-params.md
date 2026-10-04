# Activation Params — quick reference

The dense field reference for lorebook authoring.
Read this when a param choice is non-obvious; for the workflow and the delegate-only rule, see the parent `SKILL.md`.
Every field below is accepted by the tools as named: `create_lorebook` / `edit_lorebook` take all book fields, and `create_lore_entry` / `add_lore_entry` / `edit_lore_entry` take all entry fields — only the fields you supply change anything.
`set_lore_activation` is the narrow convenience for `constant` / `enabled` only; anything else goes through `edit_lore_entry`.
"Default" is what a drafted node gets when the field is left unset: books from `LOREBOOK_DEFAULTS` in `packages/domain` plus the Apply create defaults, entries from the draft skeleton plus the Apply create defaults.
Content and keys are **never** set through these fields — they come from the delegate tools (`ai_write_lore_entry` / `ai_generate_lore_keys`).

## Book-level activation (`create_lorebook` / `edit_lorebook`)

| Field | Default | Range / values | When to deviate |
|---|---|---|---|
| `name` | (required on create) | string | The lorebook's display name, e.g. 'World Lore' or 'Castle Anvil'. |
| `description` | `""` | string | A short description of what this lorebook covers; helps the author (and you, in later turns) pick the right book. |
| `scanDepth` | `10` | int ≥ 0 | How many recent chat messages the engine scans for key matches. Raise (15–20) for a slow-burn book whose triggers appear across a longer window; lower (5) for a tight, fast-triggering book. Most books: leave at 10. |
| `tokenBudget` | `1000` | positive int | Max tokens this book may inject per turn in FIXED-budget mode (used while `tokenBudgetPercent` is null). Raise for dense reference books the RP leans on; lower for terse flavor books. |
| `tokenBudgetPercent` | `null` | `null` \| 0–100 | Budget as a PERCENT of the model's context window instead of a fixed token count: `null` = fixed mode (use `tokenBudget`), 0–100 = percent mode (scales with the model's context). Prefer percent for reference books that should grow with the model. |
| `tokenBudgetCap` | `0` | int ≥ 0 | Absolute token ceiling for percent mode; `0` = no cap. Ignored in fixed mode (`tokenBudget` is already absolute). The cap only clamps down — it never raises a small percent budget. |
| `recursiveScanning` | `false` | bool | `true` lets a matched entry's keys trigger more entries (chains, layered worlds). Use when one fact should unlock another; leave `false` for predictable, independent entries. Recursion can inflate token spend — pair it with a tighter budget. |
| `useGroupScoring` | `false` | bool | Book-level default for group scoring: when entries share a `groupName`, their key scores compete within the group (see Groups below). Entries can override per-entry (their `null` = inherit this default). |
| `caseSensitive` | `false` | bool | Book-level default: key matching distinguishes upper/lower case. Entries can override per-entry (their `null` = inherit). |
| `matchWholeWords` | `false` | bool | Book-level default: single-word keys match only as whole words, not as substrings. Entries can override per-entry (their `null` = inherit). |
| `maxRecursionSteps` | `0` | int ≥ 0 | How many scan passes a single resolve may follow when `recursiveScanning` is on — the count includes the initial normal scan. `0` = unlimited; set 2–3 when chains should not run away. |
| `includeNames` | `true` | bool | Also scan speaker NAMES as match text: each scanned message is prefixed with its speaker's name, so keys can match who spoke, not just what was said. Turn off only when a character's name collides with lore keys. |
| `minActivations` | `0` | int ≥ 0 | Minimum number of entries that must activate before the book is satisfied; while the count is unmet the engine widens its scan window deeper into the chat trying to reach it. Use for reveal structures where a single trigger is noise. |
| `minActivationsDepthMax` | `0` | int ≥ 0 | Cap on how far the `minActivations` window may widen, in messages back from the newest. `0` = no cap (chat length is the only bound). Set it so a low `minActivations` cannot scan the whole chat. |
| `overflowAlert` | `false` | bool | Show the author an alert when this book's token budget overflows and entries get dropped. Turn on for books the author is actively tuning. |
| `characterStrategy` | `1` | `0` \| `1` \| `2` | How character-scoped and global lore entries are ordered relative to each other: `0` = evenly interleave (merged by priority), `1` = character books first (default), `2` = global books first. Chat- and persona-bound entries always precede both. |
| `scopeType` | `entity` | `global` \| `entity` \| `chat` | `entity` attaches the book to the current character (the common case). `global` for a world every character shares. `chat` is rare — only when the book is truly chat-scoped. |
| `enabled` | `true` | bool | Set `false` to draft a book that stays dormant until the author enables it. |

## Entry-level activation

Set at skeleton time (`create_lore_entry` / `add_lore_entry`), adjustable later (`edit_lore_entry`; `set_lore_activation` covers only `constant` / `enabled`).

| Field | Default | Range / values | When to deviate |
|---|---|---|---|
| `title` | `""` | string | Organizational only — not an activation trigger. A short label for the author and the review surface. |
| `logic` | `and_any` | `and_any` \| `and_all` \| `not_any` \| `not_all` | How secondary keys combine with a primary key match — see the Logic table below. |
| `position` | `before_char` | 14 values (below) | Where the entry injects in the assembled prompt — see Positions below. |
| `depth` | `4` | int | Injection depth for depth-aware positions (`at_depth`, `in_chat`): how many messages deep the entry lands. Only meaningful when `position` uses depth. |
| `priority` | `100` | int | Insertion priority when several entries compete for the same slot: higher wins (this is ST's `order`). Also breaks `prioritizeInclusion` ties within a group. Most entries can leave it alone. |
| `constant` | `false` | bool | `true` = inject every turn regardless of key match (world rules, core conditions). Sparing use — constant entries always cost budget. The keyword path is the default for a reason. |
| `probability` | `100` | 0–100 | Chance the entry actually injects when it activates, in percent. Use for flavor entries that should not fire every time. A failed roll is final for that turn's resolve. |
| `ignoreBudget` | `false` | bool | `true` = the entry bypasses the lorebook's token budget entirely. Use sparingly for must-have entries. |
| `role` | `system` | `system` \| `user` \| `assistant` | Chat role the injected text plays for depth-aware chat positions. Only meaningful with `position` `at_depth` / `in_chat`. |
| `groupName` | `""` | string | Inclusion group: entries sharing a `groupName` form a group of which only some inject per turn (picked by weight). Comma-separate names to join several groups at once ("g1,g2"). Empty = no group. See Groups below. |
| `groupWeight` | `100` | number | Relative chance this entry is the one picked from its inclusion group (higher = more likely). Only matters when the group resolves by weighted roll. |
| `prioritizeInclusion` | `false` | bool | `true` = this entry is always included when its inclusion group is picked, before weighted selection: flagged members compete and the highest `priority` takes the group. |
| `useGroupScoring` | `null` | `null` \| bool | Per-entry override of the book's group-scoring default for this entry's group: `null` (default) = inherit the book's setting, `true`/`false` = explicit. |
| `excludeRecursion` | `false` | bool | `true` = this entry can never be activated BY a recursive scan (only by the normal chat scan). |
| `preventRecursion` | `false` | bool | `true` = this entry's own content is not added to the recursion buffer, so it cannot trigger further entries during recursion. |
| `delayUntilRecursion` | `false` | bool | `true` = the entry only becomes eligible once the scan recurses to its `recursionLevel` — it waits until other entries have already matched and been injected. |
| `recursionLevel` | `0` | int ≥ 0 | The recursion level this entry waits for when `delayUntilRecursion` is true; `0` counts as the first recursion level. |
| `scanDepthOverride` | `null` | `null` \| int | Per-entry override of the book's `scanDepth` for this entry only: a number = override, `null` (default) = use the book's scan depth. |
| `caseSensitive` | `null` | `null` \| bool | Per-entry override of the book's `caseSensitive` default: `null` (default) = inherit the book's setting, `true`/`false` = explicit. |
| `matchWholeWords` | `null` | `null` \| bool | Per-entry override of the book's `matchWholeWords` default: `null` (default) = inherit the book's setting, `true`/`false` = explicit. |
| `caseFormsKeys` | `[]` | string[] | The subset of this entry's keys for which the Russian case-forms compiler auto-generates grammatical case variants (a Russian name key then matches in genitive/dative/etc. too). Only meaningful for Russian keys; list keys that exist on the entry (keys come from `ai_generate_lore_keys`). |
| `characterFilter` | `[]` | `{ id, name }[]` | Restrict activation to specific characters: use `id` null + the character's name for a name-matched filter, or a real character id for a rename-proof filter. Empty = no filter. |
| `characterFilterExclude` | `false` | bool | `false` (default) = the `characterFilter` is an ALLOW-list (only listed characters trigger the entry); `true` = a BLOCK-list (everyone except the listed characters). |
| `matchSources` | `["chat_messages"]` | source values (below) | Which text sources the engine scans for this entry's keys — see Match sources below. |
| `enabled` | `true` | bool | `false` drafts a dormant entry (toggle later via `set_lore_activation` or `edit_lore_entry`). |
| `stickyWindow` | `0` | int ≥ 0 | After this entry activates, it keeps injecting for the next N turns even without a key match (stickiness). Use for facts that should persist once surfaced (an injury, a revealed secret). |
| `cooldownWindow` | `0` | int ≥ 0 | After this entry activates, it is suppressed for the next N turns even on a key match. Use to stop a trigger from re-firing every turn. |
| `minChatMessages` | `0` | int ≥ 0 | Absolute chat-length gate: while the chat has fewer messages than this, the entry is fully suppressed (constants and windows included). Use for late-game reveals. |

## Positions — where an entry injects

- Common: `before_char` / `after_char` — world info around the character card.
- Depth-aware: `at_depth` (uses `depth`), `in_chat` — inside the chat history.
- Around example dialogue: `before_examples` / `after_examples`.
- Author's Note: `top_an` / `bottom_an`.
- Persona slots: `before_persona` / `after_persona` — around the user's persona description.
- VT-native prompt slots: `before_prompt` (before everything), `in_prompt` (main prompt block), `hidden_system` (system-level instruction, not shown in prompt traces).
- `outlet` is import-preservation only: outlet entries join `{{outlet::name}}` macro slots by their imported outlet name, and a hand-authored entry with position `outlet` never reaches the prompt — do not set it on entries you author.

## Timing windows — sticky vs cooldown vs delay

- **Sticky** (`stickyWindow` > 0): once activated, the entry keeps injecting for the next N turns with no key match needed — a revealed secret stays in play.
- **Cooldown** (`cooldownWindow` > 0): once activated, the entry is suppressed for the next N turns even on a fresh match — a trigger that just fired cannot spam.
- The two compose: a live sticky window wins over the cooldown, and when the sticky expires a set cooldown starts fresh from that point (the fact persists, then rests).
- **Chat-length delay** (`minChatMessages` > 0): an absolute gate checked before everything else — below the threshold the entry is fully suppressed, constants and live sticky windows included.
- **Recursion delay** (`delayUntilRecursion` + `recursionLevel`): a different kind of delay — not turn-based but chain-based; the entry waits until recursion reaches its level.
- Pick one dominant timing mechanism per entry; stacking sticky + cooldown is legal but every window you add makes the entry's behavior harder for the author to predict.

## Inclusion groups and weights

- Entries that share a `groupName` form a group; per scan pass only some members inject.
- Resolution order: sticky-active members dominate (all of them survive, no winner is picked) → group scoring drops lower-scoring flagged members (only when the book default or a member flag turns it on; unflagged members are immune, ties survive) → a group that already produced a winner this resolve rejects later candidates → `prioritizeInclusion` members compete by `priority` and the winner takes the group → otherwise a weighted random roll by `groupWeight` picks exactly one.
- Use groups for alternatives — rumors, variant scenes, one-of-many NPC quirks: same `groupName` on every variant, `groupWeight` by desirability, and only one lands per turn.
- `useGroupScoring` (book default + per-entry override) decides whether key-match quality filters the group before the roll.

## Recursion

- The book's `recursiveScanning` switches chains on: activated entries' content joins the scan buffer and can trigger further entries.
- `excludeRecursion` keeps an entry out of chains entirely (normal scan only); `preventRecursion` lets it activate from a chain but stops it from starting one; `delayUntilRecursion` holds an entry back until recursion reaches its `recursionLevel`.
- `maxRecursionSteps` caps the passes (0 = unlimited).

## Token budget — fixed vs percent

- Fixed mode (`tokenBudgetPercent` null): the book injects at most `tokenBudget` tokens per turn.
- Percent mode (0–100): the budget is `round(percent × model context / 100)`, and `tokenBudgetCap` clamps it down if set.
- Entries consume the budget in sticky-first, then priority-descending order; an entry that lands exactly on the limit trips the overflow, and later entries of that book are dropped without a fit check.
- `ignoreBudget` entries bypass the budget entirely (and stay eligible after a book has overflowed).
- `overflowAlert` makes an overflow visible to the author as an alert plus a prompt-trace note — it does not change what activates.

## Character filter

- `characterFilter` matches against the ACTIVE character: an id-bound entry (`id` from `search_context` results) survives renames; a name-only entry (`id` null) matches by name even for characters not in this database.
- `characterFilterExclude` flips the list from ALLOW (default) to BLOCK.
- Use it for multi-character books where some lore belongs to only one character — or must never appear for one.

## Match sources

- Default is `["chat_messages"]` — only the recent chat (within `scanDepth` / `scanDepthOverride`) is scanned.
- Add sources to scan beyond the chat: character fields (`character_desc`, `character_personality`, `character_note`, `character_alt_greetings`), persona (`persona_desc`), chat framing (`scenario`, `authors_note`, `chat_dynamic_prompt`, `chat_summary`), background (`creator_notes`, `summaries`).
- Use a wider source list when the entry's triggers live on the card or in the scenario rather than in what the players type; every extra source widens what can accidentally match.

## Logic — how keys combine (`logic` on skeleton / edit tools)

Primary `keys` are activation triggers (from `ai_generate_lore_keys`, `keyTarget: "primary"`).
`secondaryKeys` are additional combining signal (`keyTarget: "secondary"`).
`logic` says how they combine:

| `logic` | Meaning | Use |
|---|---|---|
| `and_any` (default) | at least one secondary key must match (in addition to a primary) | The common case — "this entry fires when a primary trigger is present AND any of these supporting signals are too." |
| `and_all` | ALL secondary keys must match | Strict: only fire when every supporting signal is present. Narrow reach; high precision. |
| `not_any` | NONE of the secondary keys may match | Suppress: fire on a primary trigger UNLESS a disqualifying signal is present (e.g. "faction lore, but not when the character is pretending to be from elsewhere"). |
| `not_all` | NOT all secondary keys match (at least one missing) | Niche inverse of `and_all`. Rarely needed. |

For a fresh entry, default `and_any` + `keyTarget: "both"` + replace.
Reach for `not_any` when you need an exclusion condition; reach for `and_all` only when the entry must not fire without its full supporting context.

## Keys vs secondary keys — which to generate

`ai_generate_lore_keys`'s `keyTarget` picks the set:

- **`primary`** — the triggers that surface this entry. Most entries need these.
- **`secondary`** — extra signal combined via `logic`. Only generate when you're actually using `and_any`/`and_all`/`not_any`/`not_all` with a second set.
- **`both`** (default) — generate both. Right for a fresh entry whose logic you haven't narrowed yet.

`appendMode: true` adds to the existing set (deduped); `false` replaces the targeted set only.
The non-targeted set is never touched.
