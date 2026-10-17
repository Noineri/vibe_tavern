---
name: experience-authoring
description: Craft guidance for authoring interactive experiences — the rules-first workflow, state/action design patterns, turn ownership and seat mapping, the testing loop, and the common pitfalls (non-termination, capability mismatch, host leakage). Read this when you are about to write or repair a rules package or a visual, before proposing the edit.
---

# Experience authoring — craft guidance

This skill is the *strategy* layer. The exact API surface (`context.experience.register`, method signatures, the sandbox bounds, the `VibeExperience` visual bridge) lives in the two API references already in your system prompt — do not restate it here. Use this skill to decide *what to write* and *in what order*; use the references for *how* write it.

## The authoring loop

Work rules-first, always. The rules package is the source of truth for the experience; the visual only renders state the rules produce.

1. **Smallest valid package first.** Get to a rules package that passes `run_test` (discovers, creates, projects, lists legal actions) with the *minimum* state and actions that express the core loop. A counter that increments. A board that places one mark. Do not model the whole game before the first green test.
2. **Test, then elaborate.** After every `write_buffer`/`edit_buffer` to rules, call `run_test`. Read the digest's `launchContext` first: `source: "sandbox"` is the user's own Try-it setup; `source: "derived"` means they have not configured the Try-it panel and the roster is the default one (one human seat, plus an AI seat for participants + model). Then read `status`, `legalActionTypes`, `seatLegality` and the `stateSummary` to see whether the package behaves. Only add the next mechanic once the current one is proven.
3. **Compare the sandbox setup with what the rules need.** With `source: "sandbox"`, set `launchContext.seats` beside the seats your rules expect and `launchContext.grants` beside the declared capabilities. When they differ — one seat where the game needs two, a model seat missing, `participants` or `model` not granted — the user's Try setup is why the game misbehaves, and the user is the only one who can change it. Tell them in the same message, as steps with the interface's own labels (below): which participant to add with which role, which boxes to tick, and for an AI-character seat the provider and the model to pick. Keep the rules written for the setup the game needs; adapting them to a broken setup hides the cause and breaks the game once the setup is fixed.
4. **Check termination with `run_simulate`** once script-controlled seats or automated flow exist. If `stopReason` is not `completed`/`awaiting_human` and `iterations` climbs to the bound, the rules stall — find the state where no legal action advances.
5. **Visual last.** Write the visual only once the rules' projected state is stable enough to render. The visual reads projected state; churning rules means churning visuals.

Try-it panel labels, English interface / Russian interface — quote the ones matching the user's language, never paraphrase them: tab "Try it" / «Попробовать»; section "Participants & launch settings" / «Участники и параметры запуска»; button "Add participant" / «Добавить участника»; roles "I play myself" / «Я играю сам», "AI character" / «ИИ-персонаж», "Automaton (by rules)" / «Автомат (по правилам)»; pickers "Select provider…" / «Выбрать провайдера…» and "Select model…" / «Выбрать модель…»; permissions "What the app is allowed to do" / «Что разрешено приложению»; launch button "Play" / «Играть».

## Designing rules

- **State is a bounded JSON document.** Model the minimum state that distinguishes the positions the experience can reach. Everything else is derived in `project`. If a field never changes a legal action or a projection, it does not belong in state.
- **`actions` is the human's vocabulary; `reduce` is the only mutation.** `actions(viewer)` returns what *this viewer* may do; `reduce(action)` is the single place state changes. Keep `reduce` total over the action types `actions` advertises — an action that is listed but not reduced (or reduced into an invalid state) is a bug.
- **`project` is per-viewer and pure.** It hides private state and computes the display shape. Never mutate inside `project`; return a new object. What the visual renders comes from here.
- **Capabilities are declared, not assumed.** Read `context.participants` only with the `participants` capability; use `context.random` only with `deterministic_random`. Seeding randomness through `context.random` (inside `create`/`reduce`) is what makes replays deterministic — never `Math.random` for authoritative state.
- **`choose` is required for script seats; `flavor` is optional.** As soon as a script-controlled seat can own the turn, the rules need `choose` — a script seat with legal actions and no `choose` stops the game with `no_choose_method`. `flavor` is for cosmetic variety that must stay deterministic across viewers. If no seat is script-controlled and nothing cosmetic varies, the four mandatory methods are enough.

## Turn ownership and seat mapping (the #1 illegal-action trap)

Multi-seat games fail here more than anywhere else: the app "gets confused about whose turn it is" and every human move comes back `illegal_action`. The engine does not sync turn logic for you — you own three surfaces, and they desync silently. Follow these rules exactly:

- **The host has no turn variable.** It gives the turn to the first seat in roster order whose `actions(viewer)` is non-empty (rules reference: "How the host picks whose turn it is"). Everything below follows from that.
- **Map seats through `context.participants`, never invent ids.** In `create`, capture `participants[i].id` into state and resolve any later viewer by looking up `viewer.participantId` in THAT array. A hardcoded `'player_1'` or `'seat_0'` that differs from the roster id makes `actions()` return `[]` for the human forever — while the visual still shows "your move". The same holds for a fallback roster: when `context.participants` is absent because `participants` is not granted, let `create` fail on it rather than invent ids — the error names the setup gap, while invented ids produce a game where nobody can move. The fix is the grant (step 3 of the authoring loop).
- **`actions(viewer)` is the SINGLE gate.** Gate every descriptor by turn ownership there; `reduce` re-checks ownership defensively (no-op on mismatch). Do NOT add a second gate anywhere else — especially not in the visual.
- **The visual must gate clicks on `view.actions` DATA, not on re-derived turn logic.** A click is legal if and only if its action type is present in the current `view.actions` for this viewer. The visual never re-computes whose turn it is from projected state (`turn`, `attacker`, `phase` fields are for LABELS, not for gating) — a visual that derives its own `ownerTurn` will eventually disagree with the rules and submit moves the engine rejects. Render the buttons from `view.actions`; an empty list is a waiting state.
- **After ANY change to turn order** (swaps after a bout, skips, round rotations), immediately `run_test` and walk one full cycle of every seat before elaborating. A swap applied in `actions` but not in `reduce` (or vice versa) is exactly the multi-iteration bug this section exists to prevent.
- **Debugging `illegal_action`:** the error names the action and participant. Read `seatLegality` in the digest — it shows which seat owns the turn at that state. If the move came from a seat that does not own the turn, the gate is right and the caller is wrong; if the seat that SHOULD own the turn has no legal actions, the gate or the seat mapping is wrong. An empty `legalActionTypes` is a fault only when the echoed roster (`launchContext.seats`) has a human seat whose turn it is — on any other seat's turn it is the correct waiting state. Fix the rules, never the visual, when they disagree.

## Designing the visual

- The visual receives the projected state over the bridge and renders it. It must not encode rules logic — if the visual needs a value the rules do not project, change `project` to surface it rather than recomputing it in the visual.
- Keep the visual a pure function of projected state plus the actions the bridge exposes. Side effects belong to the rules; the visual only reflects.
- Click-gating is data, not logic: buttons come from `view.actions`, never from a re-derived turn check (see "Turn ownership and seat mapping" above).

## When something fails

- **`Invalid input for tool …` (the whole call was dropped)** — a required argument was missing or invalid; nothing executed. The most common miss is `target` on `write_buffer`/`edit_buffer`: EVERY buffer call carries `target: "rules" | "visual"` plus its payload. Re-send the complete corrected call — a rejected call mutates nothing, so the buffer is still in its pre-call state.

- **`run_test` returns an error digest** — read `errorCode`/`errorKind`/`errorMessage`. `syntax`/`vm_error` means the source does not run; `validation_error`/`missing_method` means it runs but breaks the contract. Fix the source, re-propose, re-test — all within the same turn.
- **`run_simulate` runs to the iteration bound** — a loop of legal actions never reaches a human boundary or a terminal status. Look for a state where `actions` keeps returning non-terminal moves and `reduce` keeps accepting them. Either add a termination condition in `reduce` or a different action selection in `choose`.
- **`run_simulate` stops with `no_legal_action` at iteration 0** — check `launchContext.seats` first: with no seats there is nobody to act, which is a setup gap, not a rules bug; with seats, no seat's `actions` returned anything at the start — a genuine stall (usually the stored turn owner's id matches no roster id).
- **`no_choose_method`** — a script seat got the turn and the rules have no `choose`. Add `choose`, or make sure script seats never own the turn.
- **Capability mismatch** — the rules read `context.participants`/`context.random` without declaring the capability, or declared it and never seeded `context.random`. Check the declared capabilities in the discovered definition against what the methods touch.
- **The user says a click does nothing** — the digest tells you which of three it is, so read it before naming a cause: the action is absent from `view.actions` for that seat (`seatLegality`, then the seat mapping above); the action is offered but `reduce` returns the state unchanged with no events (a defensive no-op swallowing it); or the next seat is an AI-character seat with no provider/model picked (the setup comparison in step 3). Tell the user which one the digest shows. When the digest cannot tell, say that the cause is a guess and name the one check that would settle it.
- **The only fix you see removes something the user asked for** — a model-driven character, a capability, a seat, a mechanic. Keep the buffers as they are and tell the user what blocks the feature and the two ways forward with their cost (for example: pick a model for the character seat and get real bluffing with a few seconds per move, or let the rules play the character by formula and move instantly). Apply the one they pick. The user asked for that feature; a game that works without it is a different game than the one they asked for.
- **Host leakage** — the rules reference `context.character`, `context.chat`, `context.lore`, or any RP/prompt data. None of that exists in the rules VM; strip it.

## Quality bar

- Could a reader predict what the experience *does* from the rules alone? If the package is all plumbing and no behavior, the core loop is not modeled yet.
- Does every legal action lead somewhere? An action that the user can take but that has no effect (or no terminal path) is dead weight.
- Did you propose the smallest change that achieves the goal? A targeted `edit_buffer` beats a full `write_buffer` rewrite once a buffer exists — preserve unrelated code, change only what was asked.
- Is your one-line `summary` honest? It is the user's only signal of what a proposal does before they open the diff.
