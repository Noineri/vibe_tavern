---
name: lorebook-authoring
description: The canonical lorebook-authoring workflow for every Co-Author mode. Read this before any lore tool. Covers the full lifecycle (create book with activation params → entry skeleton → delegate content → delegate keys → edit / rename / re-parametrize / regenerate across turns), the delegate-only-keys rule (keys and content are never written inline), activation-param defaults and when to deviate, and the language-anchoring guidance. Read references/activation-params.md when you need the exact field ranges and logic modes.
---

# Lorebook Authoring

You're about to draft or edit a lorebook (world-info book) for a character. This is the canonical workflow for every Co-Author mode — read it before your first lore tool call in the turn. Lore work uses a **discuss-then-mutate** rhythm: settle what a book covers before creating it, then propose through tools for review.

## The delegate-only rule (load-bearing)

**Keys and content are NEVER written inline.** They only ever come from the two delegation tools:

- **Content** → `ai_write_lore_entry` (a separate, focused generation authors dense worldbuilding prose).
- **Keys** → `ai_generate_lore_keys` (a separate generation derives activation keywords from the entry's content).

The skeleton tools — `create_lore_entry`, `add_lore_entry`, `edit_lore_entry` — set the entry's **title and activation params + logic ONLY** (constant / position / depth / logic / enabled). They do not take content or keys. Do not try to smuggle prose or triggers into them. This split is what keeps lore quality high and activation correct: the delegate grounds on the card + the entry, not on a vague inline guess.

## The lifecycle (one book)

1. **Settle scope first.** Agree with the author what this book covers (a setting, a faction web, a magic system, one character's backstory). One book = one coherent domain. Then `create_lorebook` with `name`, `description`, and activation params. **Defaults are correct for most books** (`scanDepth` 10, `tokenBudget` 1000, `recursiveScanning` false, `character` scope). Deviate only with a stated reason — see `references/activation-params.md`.
2. **Per entry: skeleton → content → keys, in that order.**
   - `create_lore_entry` (parent drafted this turn) **or** `add_lore_entry` (parent already exists) → creates the entry with a `title` + activation params + `logic` only. No content, no keys.
   - `ai_write_lore_entry` → delegates the content body. **Keys are derived from content**, so write content first.
   - `ai_generate_lore_keys` → delegates the activation keys from that content.
3. **Constant entries.** A world rule that must always be present (a magic system, the character's core condition) is `constant: true` — set it at creation or via `set_lore_activation`. Constant entries inject every turn regardless of key match; use sparingly, only when keyword matching would be the wrong trigger.
4. **Compose into one draft.** Every tool returns the **complete cumulative lore draft** (all books + entries proposed this turn). The author reviews per book and per entry at Apply — nothing is persisted until then. Keep proposing; the draft accumulates.

## The `ai_write_lore_entry` instruction is a complete brief

The delegate sees **only the character card + this entry's lorebook + your `instruction`** — not this conversation. So `instruction` must be a complete, self-contained authoring directive: translate the user's request (however vague) into the subject to cover, the specific facts/angles/sensory detail to include, and tone/length. Never write "as we discussed" or "the thing they mentioned" — spell out everything the delegate needs to author the entry in isolation.

## `ai_generate_lore_keys` controls

- **`keyTarget`** — which set to generate: `primary` (activation triggers), `secondary` (additional combining signal), or `both` (default). The non-targeted set is left untouched.
- **`appendMode`** — `false` (default) = **replace** the targeted set(s); `true` = **augment** (append only newly-generated keys, deduped against existing).

Pick deliberately: a fresh entry → `both` + replace. The author already approved good primary keys and you're refining signal → `secondary` + replace. You're adding to keys the author liked → `appendMode: true`. Generating the set you didn't target is never destructive.

## Cross-turn editing (the book already exists)

Persisted lorebooks and entries are editable in later turns — reference them by their stable id (the `[entryId: ...]` shown beside a bound entry's title in awareness; never the display title).

- **New entry in an existing book** → `add_lore_entry` (NOT `create_lore_entry`, which is only for a book drafted this turn).
- **Rename / re-describe / re-parametrize a book** → `edit_lorebook` (`name` / `description` / `scopeType` / `scanDepth` / `tokenBudget` / `recursiveScanning` / `enabled` — only the fields you supply change).
- **Re-title / re-logic / re-position / toggle an entry** → `edit_lore_entry` (title + activation params + logic only; not content/keys).
- **Regenerate content** → `ai_write_lore_entry` again on the same entry id.
- **Regenerate or add keys** → `ai_generate_lore_keys` again, with `appendMode: true` to add rather than replace.

## Language anchoring

The delegate grounds on the character card + the entry's lorebook, so it naturally authors content and keys **in the card's content language** — not in the language you happened to write your instruction in. To keep that grounding consistent, **write your `ai_write_lore_entry` instruction in the card's content language.** If the card is in Russian, brief the delegate in Russian; the content comes back in Russian. This is guidance, not a hard rule, but following it is what produces language-matched lore without any extra machinery.

## When to offer lore at all

Only when the premise has worldbuilding depth worth playing against: a setting with factions or history, a quirk with a hidden backstory, an object or place the character reacts to, a system (magic, politics, economics) that shapes behavior. Don't force a lorebook onto a simple character — name it as an option and let the author decide, the same way you'd offer any trade-off. For a sparse brief in a speed mode, a single starter book is fine; for a deep world, propose books per domain rather than one giant book.

## When you need the exact field ranges

Read `references/activation-params.md` via `read_skill_file('lorebook-authoring/references/activation-params.md')` when you need the precise `scanDepth` / `tokenBudget` / `recursiveScanning` ranges, the `tokenBudgetPercent` mode, the four `logic` modes (`and_any` / `and_all` / `not_any` / `not_all`), or the entry `position` taxonomy. Don't preload it — read it only when a param choice is non-obvious.
