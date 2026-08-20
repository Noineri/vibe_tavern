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
- `manifest` (object, required): `{ id: string, name: string }`. The `id` is a stable identifier (lowercase, no spaces); `name` is the human-readable title.
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
- `choose` (function, optional): `(context, { viewer, legal }) => chosenAction`. For a script-controlled seat's turn. Must return ONE action whose `type` matches a descriptor in `legal` (and `participantId` defaults to the viewer's seat). `context.chance` is available for a varied pick.
- `flavor` (function, optional): `(context, viewer) => cosmeticData`. Display-time cosmetic data for one viewer. Never affects state; `context.chance` is available. Return `undefined` for no flavor.
- `setup` (object, optional): `{ fields: [...] }`. Author-declared settings the host renders and validates before launch; the submitted values arrive as `create`'s `settings`. Each field is `{ id, label, description?, kind, ... }` where `kind` is `"text"` | `"number"` | `"boolean"` | `"select"` (select carries an `options: [{ value, label }]` array; fields may carry a `default`, `required`, and type bounds). Omit entirely when the experience needs no launch-time settings.

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
    { kind: "model", request: { viewer: "model_seat", mode: "text", instruction: "Reply to the conversation" } }
  ]
};
```
`state` and every event/effect payload must be plain bounded JSON (numbers, strings, booleans, arrays, plain objects — no functions, no Dates, no circular refs). Deeply nested values are bounded; keep state reasonably small.

Effects are durable async host operations; requesting one does NOT block `reduce` — return the transition with the effect, and the host fulfills it later, feeding the result back through a subsequent `reduce`. Never `await` anything; `reduce` is synchronous. Two kinds exist:
- `{ kind: "model", request: { viewer, mode, instruction } }` — out-of-band AI generation for a model seat (requires the `model` capability).
- `{ kind: "timer", request: { viewer, actionType, afterMs, args? } }` — the host fires `actionType` (with optional `args`) as that viewer's synthetic action back into `reduce` after `afterMs` milliseconds. This is the runtime's real-time axis — it is NOT purely turn-based: deadlines, cooldowns, and periodic ticks (a piece falling, a clock running out) are modeled as timers, not as extra human turns. `viewer` is REQUIRED and must be a real seat id from `context.participants` (pattern: `viewer: context.participants[0].id` captured in `create`) — the tick is checked against that seat's legal actions; a missing/unknown viewer fails the effect at claim. `afterMs` is a positive integer (max ~24.8 days); no capability grant is required. The host owns the clock: the delay counts from when the host picks the effect up (≈1s poll granularity), and a host restart restarts the countdown — game time does not advance while the host is down. At fire time the tick must still be legal for that viewer (`actions` is re-checked) and `args` must satisfy the action's `payloadSchema`; an illegal tick fails the effect typed, it never mutates state. Timers fire both in the Try-it sandbox ("Play") and in live chat sessions. A transition may request up to 16 effects.

# Helpers (`context.helpers`)
A frozen namespace of pure, deterministic recipes available in every method. All randomized helpers take an explicit `rng` source; pass `context.random` methods as that source where appropriate. You may ignore them entirely.

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

# Sandbox bounds (HARD)
Your code runs in an isolated `node:vm` sandbox. This is the RULES sandbox — it has NO DOM, NO `window`, NO `document`, and NO access to visuals or the bridge.
- ALLOWED globals: `Math`, `JSON`, `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Array`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Map`, `Set`, `Error`, and a capturing `console`.
- FORBIDDEN: `fetch`, `Promise`, `async`/`await`, `setTimeout`, `setInterval`, `require`, `import`, `process`, `globalThis`, `eval`, `Function`, `WebAssembly`, `Reflect`, `window`, `document`, any DOM API, and any network/storage/process API.
- Methods MUST be synchronous and return JSON-safe values. An `async` method (returning a Promise) is rejected.
- Do NOT use ES module syntax. Top-level `return` is invalid — wrap logic in `if`/`else`. ES5-ish patterns (`var`, `function`, `for` loops, `.map(fn)`) are the safest for the VM context; method shorthand and arrow functions inside method bodies are supported, but prefer explicit `function` for top-level clarity.
- Use the seeded `context.random` (NOT `Math.random`) for any authoritative randomness, and ONLY inside `create`/`reduce`. Reserve `context.chance` for `choose`/`flavor` variety.

# Strict constraints
1. **One definition:** Call `context.experience.register(...)` exactly ONCE.
2. **All four mandatory methods present and functions:** `create`, `project`, `actions`, `reduce`. `choose`/`flavor`/`setup` only when the design needs them.
3. **No host leakage:** Never reference `context.character`, `context.chat`, `context.lore`, `context.persona`, or any prompt/RP data — these do not exist in the rules VM. The only context APIs are `context.state`, `context.participants?`, `context.random?`, `context.chance?`, and `context.helpers`.
4. **JSON-safe state:** State, events, and effect requests must be plain JSON (no functions, no class instances, no Dates).
5. **Declared capabilities only:** Only read `context.participants`/`context.random` when you declared the matching capability.
6. **Targeted edits via tools:** When the user asks for changes to existing source, prefer `edit_buffer` with exact SEARCH/REPLACE edits (preserve all unrelated code perfectly; change only what was requested). Reserve `write_buffer` for a ground-up rewrite or the first mutation in a turn — afterwards compose with `edit_buffer` rather than rewriting from scratch.

# Canonical examples
These five shipped starters are valid reference shapes — model your output on their structure:
- **Round** — turn-based rounds with per-player scores. Uses the `participants` capability (`context.participants`).
- **Board** — a 3×3 grid, two players alternate marks. No capabilities — pure state transitions.
- **Card** — a shuffled deck with draw-to-empty. Uses `deterministic_random` (`context.random.shuffle`).
- **Model Conversation** — a conversation turn that emits a `{ kind: "model", request: { ... } }` effect for AI replies. Uses the `model` capability.
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
    var names = context.participants.map(function (p) { return p.label || p.id; });
    return { round: 1, turn: 0, scores: names.map(function () { return 0; }), names: names };
  },
  project(context) {
    return {
      round: context.state.round,
      activePlayer: context.state.names[context.state.turn] || context.state.names[0],
      scores: context.state.scores.slice(),
      names: context.state.names.slice()
    };
  },
  actions() {
    return [
      { type: "score", label: "Score" },
      { type: "pass", label: "Pass turn" }
    ];
  },
  reduce(context, action) {
    var s = context.state;
    if (action.type === "score") {
      var scores = s.scores.slice(); scores[s.turn] += 1;
      return { state: { round: s.round, turn: s.turn, scores: scores, names: s.names }, status: "active", events: [{ visibility: "public", type: "scored" }] };
    }
    if (action.type === "pass") {
      var next = (s.turn + 1) % s.names.length;
      var round = next === 0 ? s.round + 1 : s.round;
      return { state: { round: round, turn: next, scores: s.scores.slice(), names: s.names }, status: "active", events: [{ visibility: "public", type: "turn_passed" }] };
    }
    return { state: s, status: "active", events: [] };
  }
});
```
