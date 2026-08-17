---
name: experience-authoring
description: Craft guidance for authoring interactive experiences — the rules-first workflow, state/action design patterns, turn ownership and seat mapping, the testing loop, and the common pitfalls (non-termination, capability mismatch, host leakage). Read this when you are about to write or repair a rules package or a visual, before proposing the edit.
---

# Experience authoring — craft guidance

This skill is the *strategy* layer. The exact API surface (`context.experience.register`, method signatures, the sandbox bounds, the `VibeExperience` visual bridge) lives in the two API references already in your system prompt — do not restate it here. Use this skill to decide *what to write* and *in what order*; use the references for *how* write it.

## The authoring loop

Work rules-first, always. The rules package is the source of truth for the experience; the visual only renders state the rules produce.

1. **Smallest valid package first.** Get to a rules package that passes `run_test` (discovers, creates, projects, lists legal actions) with the *minimum* state and actions that express the core loop. A counter that increments. A board that places one mark. Do not model the whole game before the first green test.
2. **Test, then elaborate.** After every `write_buffer`/`edit_buffer` to rules, call `run_test`. Read the digest: `status`, `legalActionTypes`, and the `stateSummary` tell you whether the package behaves. Only add the next mechanic once the current one is proven.
3. **Check termination with `run_simulate`** once script-controlled seats or automated flow exist. If `stopReason` is not `completed`/`awaiting_human` and `iterations` climbs to the bound, the rules stall — find the state where no legal action advances.
4. **Visual last.** Write the visual only once the rules' projected state is stable enough to render. The visual reads projected state; churning rules means churning visuals.

## Designing rules

- **State is a bounded JSON document.** Model the minimum state that distinguishes the positions the experience can reach. Everything else is derived in `project`. If a field never changes a legal action or a projection, it does not belong in state.
- **`actions` is the human's vocabulary; `reduce` is the only mutation.** `actions(viewer)` returns what *this viewer* may do; `reduce(action)` is the single place state changes. Keep `reduce` total over the action types `actions` advertises — an action that is listed but not reduced (or reduced into an invalid state) is a bug.
- **`project` is per-viewer and pure.** It hides private state and computes the display shape. Never mutate inside `project`; return a new object. What the visual renders comes from here.
- **Capabilities are declared, not assumed.** Read `context.participants` only with the `participants` capability; use `context.random` only with `deterministic_random`. Seeding randomness through `context.random` (inside `create`/`reduce`) is what makes replays deterministic — never `Math.random` for authoritative state.
- **`choose` and `flavor` are optional and purpose-built.** `choose` is for script-controlled seats making a decision the rules own (an AI dealer drawing a card). `flavor` is for cosmetic variety that must stay deterministic across viewers (renderring-flavored text). If you are unsure whether you need them, you do not — the four mandatory methods cover most experiences.

## Turn ownership and seat mapping (the #1 illegal-action trap)

Multi-seat games fail here more than anywhere else: the app "gets confused about whose turn it is" and every human move comes back `illegal_action`. The engine does not sync turn logic for you — you own three surfaces, and they desync silently. Follow these rules exactly:

- **Map seats through `context.participants`, never invent ids.** In `create`, capture `participants[i].id` into state and resolve any later viewer by looking up `viewer.participantId` in THAT array. A hardcoded `'player_1'` or `'seat_0'` that differs from the roster id makes `actions()` return `[]` for the human forever — while the visual still shows "your move".
- **`actions(viewer)` is the SINGLE gate.** Gate every descriptor by turn ownership there; `reduce` re-checks ownership defensively (no-op on mismatch). Do NOT add a second gate anywhere else — especially not in the visual.
- **The visual must gate clicks on `view.actions` DATA, not on re-derived turn logic.** A click is legal if and only if its action type is present in the current `view.actions` for this viewer. The visual never re-computes whose turn it is from projected state (`turn`, `attacker`, `phase` fields are for LABELS, not for gating) — a visual that derives its own `ownerTurn` will eventually disagree with the rules and submit moves the engine rejects. Render the buttons from `view.actions`; an empty list is a waiting state.
- **After ANY change to turn order** (swaps after a bout, skips, round rotations), immediately `run_test` and walk one full cycle of every seat before elaborating. A swap applied in `actions` but not in `reduce` (or vice versa) is exactly the multi-iteration bug this section exists to prevent.
- **Debugging `illegal_action`:** the error names the action and participant. Read the CURRENT legal set from the digest (`legalActionTypes` for the test viewer) — if it is empty for the human seat, your seat mapping or turn gate is wrong; if it shows another seat's types, ownership lives in the wrong branch. Fix the rules, never the visual, when they disagree.

## Designing the visual

- The visual receives the projected state over the bridge and renders it. It must not encode rules logic — if the visual needs a value the rules do not project, change `project` to surface it rather than recomputing it in the visual.
- Keep the visual a pure function of projected state plus the actions the bridge exposes. Side effects belong to the rules; the visual only reflects.
- Click-gating is data, not logic: buttons come from `view.actions`, never from a re-derived turn check (see "Turn ownership and seat mapping" above).

## When something fails

- **`run_test` returns an error digest** — read `errorCode`/`errorKind`/`errorMessage`. `syntax`/`vm_error` means the source does not run; `validation_error`/`missing_method` means it runs but breaks the contract. Fix the source, re-propose, re-test — all within the same turn.
- **`run_simulate` runs to the iteration bound** — a loop of legal actions never reaches a human boundary or a terminal status. Look for a state where `actions` keeps returning non-terminal moves and `reduce` keeps accepting them. Either add a termination condition in `reduce` or a different action selection in `choose`.
- **Capability mismatch** — the rules read `context.participants`/`context.random` without declaring the capability, or declared it and never seeded `context.random`. Check the declared capabilities in the discovered definition against what the methods touch.
- **Host leakage** — the rules reference `context.character`, `context.chat`, `context.lore`, or any RP/prompt data. None of that exists in the rules VM; strip it.

## Quality bar

- Could a reader predict what the experience *does* from the rules alone? If the package is all plumbing and no behavior, the core loop is not modeled yet.
- Does every legal action lead somewhere? An action that the user can take but that has no effect (or no terminal path) is dead weight.
- Did you propose the smallest change that achieves the goal? A targeted `edit_buffer` beats a full `write_buffer` rewrite once a buffer exists — preserve unrelated code, change only what was asked.
- Is your one-line `summary` honest? It is the user's only signal of what a proposal does before they open the diff.
