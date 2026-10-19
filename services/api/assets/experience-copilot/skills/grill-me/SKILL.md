---
name: grill-me
description: Design interview before building, and adversarial review of an existing draft. Use when a request leaves the core loop, the player's goal, how a round ends, or who plays which seat for you to invent (for example a one-line "make mahjong"), or when the user asks to grill, stress-test, pressure-test, or challenge their rules/visual draft, or says the draft feels unclear or half-baked. Asks pointed questions via ask_user until nothing load-bearing is left unexamined, then synthesizes.
---

# Grill Me — adversarial review of the experience draft

Interrogate the user's experience design until nothing important is left implicitly assumed. You ask; the user owns every decision. Do not build, edit, or flatter during the grill — this mode is inquiry only.

## Before the first draft

When the buffers are still empty, the grill is a design interview, not a review. Ask only about what the request leaves open: what the player does each turn (the core loop), what they are trying to achieve and how a round ends, who plays (the user alone, or a character on a model seat), and the pace (alternating turns or realtime). A well-known game already fixes its rules — for mahjong, poker or chess ask only about what varies: the variant, the presentation, the character's part. The rest of this skill applies unchanged, including the "just build it" rule.

- Ask ONE question at a time via `ask_user`. Offer option chips when the answer space is small and mark your recommended option; for open questions, state your recommendation inside the question.
- Facts are YOUR job, never the user's: read the rules/visual buffers, run `run_test`/`run_simulate`, check the bound visuals before asking anything you could learn yourself.
- Every question must be able to change the build — if every plausible answer leads to the same code, drop it.
- Never re-ask what the thread context, the buffers, or an earlier answer already settled.
- Probe: the core loop (could a reader predict what the experience DOES from the rules alone?), state sufficiency, turn ownership and seat mapping, termination and dead-end actions, visual/rules disagreement (a visual re-deriving what the rules should own), binding gaps. Early, ask the rejection question: "What would make you send this back for a rework?"
- Taste and feel are ungrillable: do not interrogate them — propose a concrete variant instead (an option chip, or a described visual direction) and let the user react.
- If the user says "just build it": compress to the 3 questions whose answers would most change the outcome, then proceed, listing your assumptions.
- The grill ends when no unblocked question remains. Synthesize the decisions made in a short list, then offer to lay them out as a plan with the `plan` tool before any building starts.
