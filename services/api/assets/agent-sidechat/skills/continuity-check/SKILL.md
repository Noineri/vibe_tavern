---
name: continuity-check
description: "Find continuity errors in the roleplay: facts in the story that contradict the character card, the lore or earlier messages — names, ages, places, relationships, objects, injuries, timeline, who knows what. Use when the user asks whether there are inconsistencies, plot holes or contradictions, says the model forgot something, or wants the story checked against the card or lore."
---

# Continuity check

Long roleplays drift: the RP model forgets an injury, renames a tavern, lets a character know something they never learned. Your job is to find those places, show the evidence, and suggest a fix. You report; you never change anything yourself.

## What to compare

Check the story against three sources:

- **The card and persona**: `<character name="...">` and `<persona>` in your context.
- **The lore**: entries the RP model saw last are in `<active_lore>`; other entries (the search covers the whole library; the active character's lore ranks first) can be found with `search_context` (type `lore-entry`) and read with `read_context_item`.
- **The story itself**: the `<rp_sync>` blocks in your context, and older messages found with `search_context` (type `rp-message`) and read with `read_context_item`. Only messages that were really sent count: an unselected `<rp_variants>` alternative did not happen, and after `<rp_branch_forked at="n"/>` only this branch counts.

The usual suspects: names and spellings; ages and dates; places and how to get between them; relationships and how characters address each other; objects (who has what, what was lost or broken); injuries and their healing; time of day and how much time passed; who knows which secret and when they learned it; abilities and their stated limits.

## How to check

1. Ask what to focus on if the story is long and the user did not say; otherwise start with the facts that matter most to the current scene.
2. For each fact, find where it was established and where it is used. Search with the exact names and with synonyms; search again in the story's language if the first search misses.
3. Read the actual messages before reporting: a search hit is a pointer, not evidence.
4. If the work is long, keep a checklist with `todo` so nothing is skipped.

## The report

For each contradiction:

- **What conflicts**, in one line.
- **Source A and source B**: the two quotes, each with where it comes from (card, lore entry title, or `<rp_message position="n">`).
- **How sure you are**: certain (the two statements cannot both be true), likely, or possible (could be explained in-story — say how).
- **A suggested fix** the user can apply: which message to edit or regenerate, or which card or lore line to update, and to what.

Order by impact on the story ahead, most damaging first. If you found nothing, say so and list what you checked.

## Honest limits

- Say plainly how much you covered: which positions you read in full, which you saw only as an `<rp_summary>` (a summary can hide or blur a detail), and what you did not reach. Never report «no contradictions» for parts you did not read.
- Search works by keywords: a fact phrased differently can be missed. Say so when it matters.
- If `search_context` or `read_context_item` is off, you can check only what is in your context; say that and ask the user to attach the messages, card or lore they suspect with `@`.
- Never edit messages, the card or the lore, and never rewrite the scene yourself: the user applies the fixes.
