# Activation Params — quick reference

The dense field reference for lorebook authoring. Read this when a param choice
is non-obvious; for the workflow and the delegate-only rule, see the parent
`SKILL.md`. Defaults come from `LOREBOOK_DEFAULTS` in `packages/domain` — the
single source of truth for the draft engine and Apply.

## Book-level activation (`create_lorebook` / `edit_lorebook`)

| Field | Default | Range / values | When to deviate |
|---|---|---|---|
| `scopeType` | `character` | `global` \| `character` \| `persona` \| `chat` | `character` attaches the book to the current character (the common case). `global` for world every character shares. `persona` / `chat` are rare — only when the book is truly persona- or chat-scoped. |
| `enabled` | `true` | bool | Set `false` to draft a book that stays dormant until the author enables it. |
| `scanDepth` | `10` | positive int | How many recent messages the engine scans for key matches. Raise (15–20) for a slow-burn book whose triggers appear across a longer window; lower (5) for a tight, fast-triggering book. Most books: leave at 10. |
| `tokenBudget` | `1000` | positive int | Max tokens this book may inject per turn (fixed-budget mode, when `tokenBudgetPercent` is null). Raise for dense reference books the RP leans on; lower for terse flavor books. |
| `tokenBudgetPercent` | `null` | `null` \| 0–100 | `null` = fixed mode (use `tokenBudget`). 0–100 = percent of model context (scales with context window). Prefer percent for books that should grow with the model's context. Not exposed on the co-author tools — set it via the full editor if needed. |
| `recursiveScanning` | `false` | bool | `true` lets a matched entry's keys trigger more entries (chains). Use for layered worlds where one fact unlocks another; leave `false` when you want predictable, independent entries. Recursion can inflate token spend — pair with a tighter budget. |

## Entry-level activation

Set at skeleton time (`create_lore_entry` / `add_lore_entry`), adjustable later
(`edit_lore_entry`, `set_lore_activation`). Content and keys are **not** set
here — they come from the delegate tools.

| Field | Default | Values | Notes |
|---|---|---|---|
| `title` | (optional) | string | Organizational only — not an activation trigger. A short label for the author and the review surface. |
| `constant` | `false` | bool | `true` = inject every turn regardless of key match (world rules, core conditions). Sparing use — constant entries always cost budget. The keyword path is the default for a reason. |
| `position` | `before_char` | `before_char` \| `after_char` \| `before_examples` \| `after_examples` \| `top_an` \| `bottom_an` \| `at_depth` \| `outlet` \| `before_prompt` \| `in_prompt` \| `in_chat` \| `hidden_system` | Where the entry injects in the assembled prompt. `before_char` / `after_char` are the common cases (world info before/after the character card). The 8 SillyTavern positions map onto the prompt-order canvas; the 4 pipeline-native ones (`before_prompt`/`in_prompt`/`in_chat`/`hidden_system`) are for VT-native books. |
| `depth` | `4` | int | Injection depth for depth-aware positions (`at_depth`, `in_chat`). Only meaningful when `position` uses depth. |
| `enabled` | `true` | bool | `false` drafts a dormant entry (toggle later via `set_lore_activation`). |

## Logic — how keys combine (`logic` on skeleton / edit tools)

Primary `keys` are activation triggers (from `ai_generate_lore_keys`,
`keyTarget: "primary"`). `secondaryKeys` are additional combining signal
(`keyTarget: "secondary"`). `logic` says how they combine:

| `logic` | Meaning | Use |
|---|---|---|
| `and_any` (default) | at least one secondary key must match (in addition to a primary) | The common case — "this entry fires when a primary trigger is present AND any of these supporting signals are too." |
| `and_all` | ALL secondary keys must match | Strict: only fire when every supporting signal is present. Narrow reach; high precision. |
| `not_any` | NONE of the secondary keys may match | Suppress: fire on a primary trigger UNLESS a disqualifying signal is present (e.g. "faction lore, but not when the character is pretending to be from elsewhere"). |
| `not_all` | NOT all secondary keys match (at least one missing) | Niche inverse of `and_all`. Rarely needed. |

For a fresh entry, default `and_any` + `keyTarget: "both"` + replace. Reach for
`not_any` when you need an exclusion condition; reach for `and_all` only when
the entry must not fire without its full supporting context.

## Keys vs secondary keys — which to generate

`ai_generate_lore_keys`'s `keyTarget` picks the set:

- **`primary`** — the triggers that surface this entry. Most entries need these.
- **`secondary`** — extra signal combined via `logic`. Only generate when you're
  actually using `and_any`/`and_all`/`not_any`/`not_all` with a second set.
- **`both`** (default) — generate both. Right for a fresh entry whose logic you
  haven't narrowed yet.

`appendMode: true` adds to the existing set (deduped); `false` replaces the
targeted set only. The non-targeted set is never touched.
