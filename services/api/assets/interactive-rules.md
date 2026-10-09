# Reference: the interactive-rules language

This document is the API reference for the `rules` buffer of an interactive experience — the `context.experience.register({ ... })` registration DSL and the method-call contract the experience engine invokes. The copilot reads it to author and repair rules source. It is **reference material, not an output-format spec**: rules are proposed through the `write_buffer`/`edit_buffer` tools and never emitted as raw code in chat.

A rules script is a single JavaScript body that registers exactly one experience definition via `context.experience.register({ ... })`.

# Two phases of the same `context`
The rules script meets two distinct `context` shapes. Do not confuse them.

## 1. Discovery (the body runs once at load)
At the top level, the only API is the registration channel:

```js
context.experience.register({ /* the definition object */ });
```

A script must call this EXACTLY ONCE. There is no other top-level API. `context.experience` exists only to register; there is no `context.state`, `context.participants`, `context.random`, or any host data at the top level.

## 2. Method execution (each registered method is called later)
After discovery, the host re-runs the body and invokes one registered method. Inside a method, the `context` argument the host injects is a DIFFERENT object — the method-call context:

```js
create(context, settings) { /* context has NO state, only settings + helpers */ }
project(context, viewer)   { /* context.state, context.participants?, context.helpers */ }
update(context, dt)        { /* realtime-only tick method — same context as reduce + dt; see "Realtime mode" */ }
actions(context, viewer)   { /* same */ }
reduce(context, action)    { /* same; context.random? only if the capability is granted */ }
```

The method-call `context` fields (all read-only / frozen — never mutate them in place; return new objects):
- `context.state` — the current authoritative state (absent inside `create`). Plain bounded JSON.
- `context.participants` — present ONLY when the `participants` capability is granted. An array of `{ id, label, controller }` seats (`controller` is `"human"`, `"script"`, or `"model"`).
- `context.random` — present ONLY when the `deterministic_random` capability is granted, and ONLY inside `create` and `reduce`. A seeded RNG surface: `.float()`, `.int(min, max)`, `.die(sides)`, `.pick(items)`, `.shuffle(items)`, `.weightedPick(items)`.
- `context.chance` — an EPHEMERAL non-recorded RNG (same surface as `context.random`), present ONLY inside the optional `choose` and `flavor` methods. Never use it for authoritative randomness.
- `context.helpers` — ALWAYS present. A frozen namespace of pure recipes (see "Helpers" below).

The second argument is method-specific: `settings` for `create`, `viewer` for `project`/`actions`/`flavor`, an `action` for `reduce`, and `{ viewer, legal }` for `choose`.

# Registration contract
Register one definition with these fields:

```js
context.experience.register({
  apiVersion: 1,
  manifest: { id: "my_game", name: "My Game" },
  capabilities: [
    { capability: "participants", reason: "per-player turns and scores" }
  ],
  create(context, settings) { return initialState; },
  project(context, viewer) { return viewForViewer; },
  actions(context, viewer) { return legalActions; },
  reduce(context, action) { return transition; },
  // optional:
  choose(context, { viewer, legal }) { return oneAction; },
  flavor(context, viewer) { return cosmeticData; },
  setup: { fields: [/* optional IR-70F setup fields */] }
});
```

### Fields
- `apiVersion` (number, required): host protocol version. Use `1`.
- `manifest` (object, required): `{ id: string, name: string }`. The `id` is a stable identifier (lowercase, no spaces); `name` is the human-readable title. Two optional fields switch the execution mode — `mode` (`"turn"` default | `"realtime"`) and `tickMs` (16..1000, required for realtime, forbidden for turn); see "Realtime mode" below.
- `capabilities` (array, required): each entry is `{ capability: "...", reason?: "..." }`. Valid capability values:
  - `"participants"` — grants `context.participants` inside methods (per-player turn order, scores, seats).
  - `"deterministic_random"` — grants `context.random` inside `create`/`reduce` (shuffles, dice, draws — reproducible across replays).
  - `"model"` — enables durable model-generation effects requested from `reduce` (AI replies, AI moves). This is NOT a synchronous API; the reducer requests it as an effect (see "Effects").
  - `"rp_context"` / `"rp_attachment"` — roleplay-context capture modes for model seats. Advanced; omit unless the design explicitly needs them.
  Only declare a capability you actually use, with a one-line `reason`. An empty array is valid for a self-contained state machine.
- `create` (function, required): `(context, settings) => initialState`. No prior state. `settings` carries the values the author filled into the optional `setup` descriptor (absent/empty otherwise). Return the initial authoritative state — plain bounded JSON (no functions, no class instances).
- `project` (function, required): `(context, viewer) => projectedView`. Return what ONE viewer is allowed to see. `viewer` is `{ kind: "human"|"script"|"model"|"observer", participantId?: string }`. Hide private information here by computing the projection from `context.state` — an `observer` (and any seat that is not the viewer's own) must not receive hidden data.
- `actions` (function, required): `(context, viewer) => actionDescriptors`. Return the legal moves for this viewer at this state. Each descriptor is `{ type: string, participantId?: string, label?: string, payloadSchema?: object, allowsText?: boolean }`. Return an empty array when no legal move exists. `allowsText: true` permits free-text payloads (e.g. a "say" action).
- `reduce` (function, required): `(context, action) => transition`. `action` is `{ type, requestId, expectedRevision, participantId?, payload? }`. Return a transition (see below). This is the ONLY method that advances authoritative state.
- `choose` (function, optional — REQUIRED as soon as a script-controlled seat can own the turn): `(context, { viewer, legal }) => chosenAction`. The host calls it on a script seat's turn. Must return ONE action whose `type` matches a descriptor in `legal` (`participantId` defaults to the viewer's seat). A script seat that has legal actions while the rules define no `choose` stops the game with the error code `no_choose_method`. `context.chance` is available for a varied pick.
- `flavor` (function, optional): `(context, viewer) => cosmeticData`. Display-time cosmetic data for one viewer. Never affects state; `context.chance` is available. Return `undefined` for no flavor.
- `setup` (object, optional): `{ fields: [...] }`. Author-declared settings the host renders and validates before launch; the submitted values arrive as `create`'s `settings`. Each field is `{ id, label, description?, kind, ... }` where `kind` is `"text"` | `"number"` | `"boolean"` | `"select"` (select carries an `options: [{ value, label }]` array; fields may carry a `default`, `required`, and type bounds). Omit entirely when the experience needs no launch-time settings.

# How the host picks whose turn it is
The host keeps no turn variable of its own. After every transition it walks the roster (`context.participants`, in roster order) and calls `actions(context, viewer)` for each seat; the FIRST seat that gets a non-empty list acts next:
- a `human` seat — the host waits for the user's move;
- a `script` seat — the host calls `choose` and applies the chosen action through `reduce` (no `choose` → `no_choose_method`);
- a `model` seat — the host waits for the model effect your `reduce` requested for that seat (see "Effects"); if you never requested one, the game waits forever.
If no seat gets a non-empty list, the session is idle: it is waiting for an effect to deliver, or it is stuck.

What this means for your rules:
1. `actions(context, viewer)` returns `[]` for every seat that does not own the turn. Returning the same list to everyone gives the turn to the first seat in the roster forever — whatever your state says about whose turn it is.
2. Gate by seat id, not by position or name: store the ids from `context.participants` in `create`, keep the current owner in state (for example `state.ids[state.turn]`), and compare it with `viewer.participantId`.
3. `reduce` re-checks the owner: an action whose `action.participantId` is not the current owner returns the state unchanged with no events. Timer ticks and model replies arrive through `reduce` too, carrying the seat id they were requested for.
4. Without the `participants` capability the rules cannot see the roster, so they cannot gate by seat — such a game is played by whoever holds the first human seat (hot seat). Declare `participants` as soon as the design has two sides.

# Transition shape (what `reduce` returns)
```js
return {
  state: nextState,            // plain bounded JSON — the new authoritative state (REQUIRED)
  status: "active",            // "active" | "completed" (REQUIRED). "active" = keep playing; "completed" = natural end.
  events: [                    // REQUIRED (may be empty)
    { visibility: "public", type: "scored", detail: { player: 0 } }
    // visibility: "public" reaches the visual + report + Writer; "private" never leaves the runtime
  ],
  effects: [                   // OPTIONAL — durable effects the host runs out-of-band
    { kind: "model", request: { viewer: "<the model seat's id>", mode: "text", actionType: "reply", instruction: "Reply in character to the conversation." } }
  ]
};
```
`state` and every event/effect payload must be plain bounded JSON (numbers, strings, booleans, arrays, plain objects — no functions, no Dates, no circular refs). Deeply nested values are bounded; keep state reasonably small.

Effects are durable async host operations; requesting one does NOT block `reduce` — return the transition with the effect, and the host fulfills it later, feeding the result back through a subsequent `reduce`. Never `await` anything; `reduce` is synchronous. Two kinds exist:
- `{ kind: "model", request: { viewer, mode, actionType?, instruction? } }` — out-of-band AI generation for a model seat (requires the `model` capability). `viewer` is the model seat's id from `context.participants`. Two modes:
  - `mode: "text"` — the model writes a free-text reply. `actionType` is REQUIRED: the host feeds the reply back into `reduce` as `{ type: actionType, participantId: viewer, payload: { text } }`.
  - `mode: "action"` — the model picks ONE of the actions `actions(context, viewer)` lists for that seat at that moment, so list them on the model seat's turn; when the chosen descriptor has a `payloadSchema`, the model supplies matching args. The host feeds it back as `{ type: <the chosen type>, participantId: viewer, payload: <args, when given> }`.
  `instruction` is your extra direction for the model, appended to what it already receives (the seat's projected view and legal actions; the host adds the character and persona context). The reply is applied to the state AS IT IS WHEN THE REPLY ARRIVES: if other moves happened in between, `reduce` receives the reply on top of the newer state — check that it still fits (for example, that it is still that seat's turn) and return the state unchanged when it does not. (Timer ticks are different: a tick that arrives after the state moved on is dropped.)
- `{ kind: "timer", request: { viewer, actionType, afterMs, args? } }` — the host fires `actionType` (with optional `args`) as that viewer's synthetic action back into `reduce` after `afterMs` milliseconds. This is the runtime's real-time axis — it is NOT purely turn-based: deadlines, cooldowns, and periodic ticks (a piece falling, a clock running out) are modeled as timers, not as extra human turns. `viewer` is REQUIRED and must be a real seat id from `context.participants` (pattern: `viewer: context.participants[0].id` captured in `create`) — the tick is checked against that seat's legal actions; a missing/unknown viewer fails the effect at claim. `afterMs` is a positive integer (max ~24.8 days); no capability grant is required. The host owns the clock: the delay counts from when the host picks the effect up (≈1s poll granularity), and a host restart restarts the countdown — game time does not advance while the host is down. At fire time the tick must still be legal for that viewer (`actions` is re-checked) and `args` must satisfy the action's `payloadSchema`; an illegal tick fails the effect typed, it never mutates state. Timers fire both in the Try-it sandbox ("Play") and in live chat sessions. A transition may request up to 16 effects.

# Realtime mode

`mode: "realtime"` in the manifest switches the package to a client-side fixed-timestep round loop that runs INSIDE the visual frame: game time advances in discrete `tickMs` ticks, human and script inputs apply at tick boundaries, and the loop's roleplay surface (rules + visual + bridge) stays the same. The round is a solo session and commits once at the end — the host chat receives exactly one card. Everything in the sections above remains true unless this section says otherwise.

## Declaration

```js
manifest: { id: "my_game", name: "My Game", mode: "realtime", tickMs: 100 }
```

- `mode` — `"turn"` (default) or `"realtime"`. Turn keeps the classic host-driven flow (reducer, revisions, timer/model effects). Realtime runs the client-side loop inside the visual frame; the round is one solo session and commits once at the end.
- `tickMs` — REQUIRED when `mode: "realtime"` and FORBIDDEN otherwise. Integer 16..1000 — the fixed timestep of the loop (each tick advances exactly `tickMs` of game time).

## The `update` method (realtime only, optional)

```js
update(context, dt) { return transition; }
```

The realtime tick. Same method-call `context` as `reduce` (`state`, `participants?`, `random?`, `helpers` — NO `chance`), plus `dt` = the elapsed game milliseconds for this tick (always exactly the manifest `tickMs`). Returns the SAME transition shape as `reduce`; `"completed"` ends the round. Called once per tick, BEFORE queued inputs and script moves. Keep it cheap — it runs at tick rate (60fps = 60 calls/sec).

## Realtime restrictions (HARD)

- **Solo round:** exactly ONE human seat drives the surface. No multiplayer.
- **The `timer` effect kind does not exist in realtime** — time IS `update(context, dt)`. A `timer` effect in a realtime transition is silently dropped.
- **Model seats answer through the loop's model channel** (the visual's `modelRequest`), never through `reduce` effects — realtime transitions' `effects` are dropped alongside `events`.
- **Transition `events` are dropped in realtime** (tick-rate logging would explode the round log) — surface per-tick feedback through `project()` instead. Score/summary belong on the visual's `finishRound` call, not in events.
- **Determinism or no commit:** the server replays the round log through this same kernel and compares the state hash. `update`/`reduce` may draw ONLY from `context.random` (the deterministic round cursor) — `Math.random`, `Date.now`, or `context.chance` inside them makes the commit unverifiable (typed 422, nothing applied).
- **Keep state transitions small** — the loop runs `update` at tick rate; heavy per-tick work starves the frame.

## Which mode to pick

Turn mode for alternating-move games (card/board/quiz, multi-seat dialogue with AI replies); realtime for anything with continuous time (arcade, falling pieces, countdown dashboards, physics-ish loops). If the design has no per-tick motion, turn mode with `timer` effects remains the right tool.

# Helpers (`context.helpers`)
A frozen namespace of pure, deterministic recipes available in every method. All randomized helpers take an explicit `rng` — a function returning a float in [0, 1): pass `context.random.float` inside `create`/`reduce` (or `context.chance.float` inside `choose`/`flavor`), e.g. `context.helpers.shuffle(deck, context.random.float)`. `context.random.shuffle(items)` / `.pick(items)` do the same directly. You may ignore them entirely.

- `rotateOrder(order, fromIndex)` — rotate a seat array so `fromIndex` is first.
- `nextTurnIndex(count, currentIndex)` — `(currentIndex + 1) % count`.
- `sumScores(entries)` — `{ participantId, score }[]` → `{ [id]: total }`.
- `createGrid(width, height, fill)` — `width × height` 2D array.
- `gridNeighbors4(x, y, width, height)` — 4-connected orthogonal neighbors.
- `getRow(grid, y)` / `getColumn(grid, x)` — grid row/column slices.
- `createDeck(suits, ranks)` — cartesian product `[{ suit, rank }]`.
- `shuffle(items, rng)` — Fisher–Yates, returns a NEW array (input untouched).
- `deal(deck, handCount, perHand)` — `{ hands: [], remaining: [] }`.
- `pickDistinct(items, count, rng)` — `count` distinct items.
- `clamp(value, min, max)`.
- `range(count)` — `[0, 1, ..., count-1]`.
- `keepLast(items, max)` — the last `max` items as a NEW array; use it to keep growing histories (messages, logs) in state bounded.

# Sandbox bounds (HARD)
Your code runs in an isolated `node:vm` sandbox. This is the RULES sandbox — it has NO DOM, NO `window`, NO `document`, and NO access to visuals or the bridge.
- ALLOWED globals: `Math`, `JSON`, `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Array`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Map`, `Set`, `Error`, and a capturing `console`.
- FORBIDDEN: `fetch`, `Promise`, `async`/`await`, `setTimeout`, `setInterval`, `require`, `import`, `process`, `globalThis`, `eval`, `Function`, `WebAssembly`, `Reflect`, `window`, `document`, any DOM API, and any network/storage/process API.
- Methods MUST be synchronous and return JSON-safe values. An `async` method (returning a Promise) is rejected.
- Do NOT use ES module syntax. Top-level `return` is invalid — wrap logic in `if`/`else`. ES5-ish patterns (`var`, `function`, `for` loops, `.map(fn)`) are the safest for the VM context; method shorthand and arrow functions inside method bodies are supported, but prefer explicit `function` for top-level clarity.
- Use the seeded `context.random` (NOT `Math.random`) for any authoritative randomness, and ONLY inside `create`/`reduce`. Reserve `context.chance` for `choose`/`flavor` variety.

# Strict constraints
1. **One definition:** Call `context.experience.register(...)` exactly ONCE.
2. **All four mandatory methods present and functions:** `create`, `project`, `actions`, `reduce`. `choose`/`flavor`/`setup` only when the design needs them; `update` is the realtime-only optional tick method (see "Realtime mode").
3. **No host leakage:** Never reference `context.character`, `context.chat`, `context.lore`, `context.persona`, or any prompt/RP data — these do not exist in the rules VM. The only context APIs are `context.state`, `context.participants?`, `context.random?`, `context.chance?`, and `context.helpers`.
4. **JSON-safe state:** State, events, and effect requests must be plain JSON (no functions, no class instances, no Dates).
5. **Declared capabilities only:** Only read `context.participants`/`context.random` when you declared the matching capability.
6. **Targeted edits via tools:** When the user asks for changes to existing source, prefer `edit_buffer` with exact SEARCH/REPLACE edits (preserve all unrelated code perfectly; change only what was requested). Reserve `write_buffer` for a ground-up rewrite or the first mutation in a turn — afterwards compose with `edit_buffer` rather than rewriting from scratch.

# Canonical examples
These starters exist in the rules editor's «new from starter» picker; their source is not in this prompt — use the concrete examples below as the shape. Point the user to the closest one when it helps:
- **Round** — turn-based rounds with per-player scores and turn passing; seats gated by id, a `choose` for script seats. Uses `participants`. Its source is the second concrete example below.
- **Board** — a 3×3 grid, two players alternate marks. No capabilities — pure state transitions (a hot-seat game).
- **Card** — a shuffled deck with draw-to-empty. Uses `deterministic_random` (`context.random.shuffle`).
- **Model Conversation** (manifest name "Messenger") — a messenger: the user's profile, characters bound to model seats, one-on-one or group chats; each character's reply is a `{ kind: "model", request: { mode: "text", ... } }` effect, and the user has no actions while replies are pending. Uses `participants` and `model`.
- **Breakout Arcade** — a realtime round (`mode: "realtime"`) with power-ups: `update(context, dt)` moves the ball, frame-local inputs move the paddle, drops come from `context.random`, the round commits once with the final score. Uses `participants` (one human seat) and `deterministic_random`.
- **Blank State Machine** — a minimal counter with increment/reset. No capabilities.

## Concrete example: a self-contained counter (Blank shape)
```js
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create() {
    return { count: 0, label: "Ready" };
  },
  project(context) {
    return { count: context.state.count, label: context.state.label };
  },
  actions() {
    return [
      { type: "increment", label: "Increment" },
      { type: "reset", label: "Reset" }
    ];
  },
  reduce(context, action) {
    if (action.type === "increment") {
      var c = context.state.count + 1;
      var label = c >= 10 ? "Max" : "Counting";
      return { state: { count: c, label: label }, status: c >= 10 ? "completed" : "active", events: [{ visibility: "public", type: "incremented" }] };
    }
    if (action.type === "reset") {
      return { state: { count: 0, label: "Reset" }, status: "active", events: [{ visibility: "public", type: "reset" }] };
    }
    return { state: context.state, status: "active", events: [] };
  }
});
```

## Concrete example: per-player rounds (uses participants)
```js
context.experience.register({
  apiVersion: 1,
  manifest: { id: "round", name: "Round" },
  capabilities: [{ capability: "participants", reason: "per-player turns and scores" }],
  create(context) {
    var ids = context.participants.map(function (p) { return p.id; });
    var names = context.participants.map(function (p) { return p.label || p.id; });
    return { round: 1, turn: 0, ids: ids, names: names, scores: ids.map(function () { return 0; }) };
  },
  project(context) {
    var s = context.state;
    return {
      round: s.round,
      activePlayer: s.names[s.turn] || s.names[0],
      scores: s.scores.slice(),
      names: s.names.slice()
    };
  },
  actions(context, viewer) {
    var s = context.state;
    // Only the seat that owns the turn may act; every other seat gets [].
    if (!viewer || viewer.participantId !== s.ids[s.turn]) return [];
    return [
      { type: "score", label: "Score" },
      { type: "pass", label: "Pass turn" }
    ];
  },
  choose(context) {
    // A script seat scores up to the round number, then passes the turn.
    var s = context.state;
    return { type: s.scores[s.turn] < s.round ? "score" : "pass" };
  },
  reduce(context, action) {
    var s = context.state;
    // Defensive re-check: a move from a seat that does not own the turn changes nothing.
    if (action.participantId !== s.ids[s.turn]) {
      return { state: s, status: "active", events: [] };
    }
    if (action.type === "score") {
      var scores = s.scores.slice(); scores[s.turn] += 1;
      return { state: { round: s.round, turn: s.turn, ids: s.ids, names: s.names, scores: scores }, status: "active", events: [{ visibility: "public", type: "scored" }] };
    }
    if (action.type === "pass") {
      var next = (s.turn + 1) % s.ids.length;
      var round = next === 0 ? s.round + 1 : s.round;
      return { state: { round: round, turn: next, ids: s.ids, names: s.names, scores: s.scores.slice() }, status: "active", events: [{ visibility: "public", type: "turn_passed" }] };
    }
    return { state: s, status: "active", events: [] };
  }
});
```
