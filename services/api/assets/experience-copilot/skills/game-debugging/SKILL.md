---
name: game-debugging
description: "Find and fix bugs in a mini-app that runs but behaves wrong: clicks that do nothing, wrong rules results, pieces that vanish or jump, animations that replay, objects passing through walls, broken restart, a game that never ends. Also a hardening pass before calling a game ready. Use when the user reports something wrong, or after building a new interaction."
---

# Game debugging for Experience Copilot

This skill turns a reported problem into a cause and a fix.
`experience-authoring` covers tool errors, error digests and stalls; this skill covers a game that runs but does the wrong thing.
You see the source and the rules tools; the user sees the game.

## Step 1 — Pin one symptom

Read the current buffers first; earlier messages may describe an older version.
Write the case in four parts:
- **Steps:** what the player did, in order.
- **Start:** the setup, seed and settings, if they matter.
- **Saw:** what happened.
- **Expected:** what should have happened.

Example: steps — select the first card in the hand, click the table; saw — nothing happens; expected — the card moves to the table.

If one fact would decide between two causes, ask the user one short question: «Does the card disappear from your hand, or does it stay there?»
Otherwise start tracing.

## Step 2 — Follow the action until the first wrong value

Trace the action through these boundaries in order and stop at the first one where the value is wrong:

| Boundary | What to compare |
|---|---|
| Input | which element got the event, pointer position converted to field coordinates, the action type and payload sent |
| Acceptance | the action is in `view.actions` for this seat; the seat mapping; `reduce` accepts the payload |
| Rules result | old state, action, new state; score, resources, removals, end of round |
| Projection | what this viewer gets: values, legal actions, any move list |
| Presentation | what the page draws: positions, visibility, sizes, transforms, animation state |
| Settled screen | after animations end, the screen matches the latest view and the controls work |

Fix the first wrong boundary.
If the rules result is right but a piece vanishes on screen, the fix is in the visual.
If the rules chose the wrong result, a smoother animation cannot fix it.

## Step 3 — Look where this kind of bug usually lives

**A click does nothing.** Follow the three cases in `experience-authoring` (the action is not offered, `reduce` ignores it, or the next seat has no model). Also check that the element has the click handler and nothing transparent covers it.

**The first item behaves differently.** Index `0` is falsy and `null < 0` is false. Use one convention for «nothing selected» (`null`), check it with `=== null`, and test the first item, a later item, deselect and reselect.

**A piece disappears or looks flat.** Check the whole chain of parents: `display`, `visibility`, `opacity`, a zero size, `overflow` clipping, a transform that moved it away, the layer order. In canvas, check that every `save()` has its `restore()` and that a resize redrew the scene.
To separate a styling bug from a geometry bug, add a `DEBUG_FLAT` switch that draws every object as a flat fill with an outline: if the object appears, the problem is styling; if not, it is position, size or state.

**An animation replays, jumps or doubles.** See `game-motion` steps 4–5: animate a change once, remember the revision, and give each piece one visible owner at a time.

**Something passes through a wall or sticks.** See `game-motion` part B: test the shape, not the center; keep the distance per tick below the object's radius; push out along the normal.

**Text from a player or model breaks the layout.** Insert it with `textContent`.

**Restart leaves old things behind.** On reset, stop timers and animation loops, remove listeners and temporary elements, and rebuild from the new view.

**The game never ends.** Look for a state where nobody has a useful legal move but the status stays `active`; add the end condition to `reduce`.

## Step 4 — Hardening pass before calling a game ready

Run this pass after building a new game or a large change:

1. **Repeat and rush:** the same action twice fast; two actions before the view updates. The second must be rejected or harmless.
2. **Out of turn:** an action from a seat whose turn it is not. `reduce` returns the state unchanged.
3. **Reaches an end:** `run_simulate` with a script seat (or two) on a few seeds; every run should stop with `completed` or `awaiting_human`, not at the iteration bound.
4. **No dead end:** for each phase, check that someone always has a legal move or the round is over.
5. **Restart twice:** start, play, restart, restart again; the state equals a fresh start.
6. **Edges:** the first and last item, an empty hand, a full board, the longest name.

## Step 5 — Fix the cause and check the same boundary

Before editing, say to yourself why this line produces the wrong value and what the corrected line will do.
Make the smallest change that fixes the cause; replace a whole structure only when you can name what is wrong with it.
Then repeat the original case at the boundary where it failed, plus the nearby cases from Step 3 or 4.

Know what each tool proves:
- `run_test` — the rules load, create a state, project it and list the first legal actions. It does not play a move sequence or run the visual.
- `run_simulate` — automated seats play until a human is needed or the bound is reached. `awaiting_human` means the automated part works; the human move after it is unchecked.
- Neither tool sees the page, the animation, or whether the game is understandable.

## Step 6 — Report what is fixed and what is not checked yet

Tell the user in plain words: the cause, the fix, and how you checked it.
Name each check by what it was: «run_simulate finished on 5 seeds» is a check; «I traced the code» is a reading; a game nobody has played yet is **not assessed**, not working.
Give one or two exact things to try, with the expected result: «Select the first card and click the table — it should slide onto the table».
Ask for the observation that decides the next step.
