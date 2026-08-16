/**
 * Independent reference/test experience fixtures (IR-91A).
 *
 * Five author-owned rules sources that pin the required classes of the
 * Interactive Runtime public contract, each driven through the REAL kernel /
 * tester boundary by `experience-reference-kernel.test.ts`. They are deliberately
 * independent from the preview-only fixture set and from the shipped production
 * starters, so a self-consistent fixture passing while a shipped pair is broken
 * cannot regress behind them.
 *
 * Every source uses ONLY the public registration contract —
 * `context.experience.register({ apiVersion, manifest, capabilities, create,
 * project, actions, reduce, choose? })` — and no application-internal imports
 * or host globals. The durable `choose` method is declared only by the one
 * fixture that specifically exercises the script-controlled chooser (fixture D).
 *
 * Fixture matrix (IR-91A):
 *  - {@link COUNTER_REFERENCE_SOURCE}        — no-capability counter to completion.
 *  - {@link HIDDEN_STATE_REFERENCE_SOURCE}   — secret stays out of projections / events / actions.
 *  - {@link DETERMINISTIC_RANDOM_REFERENCE_SOURCE} — seeded die draws reproduce + hash.
 *  - {@link SCRIPT_CONTROLLED_REFERENCE_SOURCE}    — script seat advances via `choose`.
 *  - {@link MODEL_STRUCTURED_REFERENCE_SOURCE}     — action-mode model effect + feed-back.
 *
 * These fixtures are IR-91A scope ONLY. Model-prompt privacy, replay/undo, and
 * the real shipped Conversation pair are IR-91B/C/D and are NOT covered here.
 */

// ─── A. No-capability counter ────────────────────────────────────────────────
//
// Declares no capabilities, grants nothing. Proves the kernel runs an empty
// capability context end to end: discover → create → project → actions → reduce
// to a rule-determined completion, emitting only public events and never any
// durable effect. The `reset` action is offered but never used to reach the end.

export const COUNTER_REFERENCE_SOURCE = [
	"context.experience.register({",
	"  apiVersion: 1,",
	'  manifest: { id: "ref_counter", name: "Reference Counter" },',
	"  capabilities: [],",
	"  create() { return { count: 0 }; },",
	"  project(c) { return { count: c.state.count }; },",
	"  actions() { return [{ type: 'inc', label: '+' }, { type: 'reset' }]; },",
	"  reduce(c, a) {",
	"    if (a.type === 'reset') return { state: { count: 0 }, status: 'active', events: [{ visibility: 'public', type: 'reset' }] };",
	"    if (a.type !== 'inc') return { state: c.state, status: 'active', events: [] };",
	"    const n = c.state.count + 1;",
	"    return { state: { count: n }, status: n >= 3 ? 'completed' : 'active', events: [{ visibility: 'public', type: 'inc', detail: { n } }] };",
	"  },",
	"});",
].join("\n");

// ─── B. Hidden-state projection ──────────────────────────────────────────────
//
// The authoritative state holds a distinctive `secret` that MUST NEVER reach the
// observer/human projection, the legal-action set, or a public event. `project`
// strips it for every viewer; a human `search` advances the clue count and asks
// the model for a hint via a durable text-mode model effect (the effect REQUEST
// is bounded payload — its instruction never echoes the secret). A `guess`
// action compares the payload against the secret without ever returning it.
//
// The model PROMPT privacy boundary (asserting the secret is absent from the
// prompt the executor receives) is IR-91B and is deliberately NOT exercised by
// this fixture: IR-91A only pins the projected/event/action surface + the model
// effect request SHAPE.

export const HIDDEN_STATE_REFERENCE_SOURCE = [
	"context.experience.register({",
	"  apiVersion: 1,",
	'  manifest: { id: "ref_hidden", name: "Reference Hidden State" },',
	"  capabilities: [",
	"    { capability: 'participants', reason: 'human + model seats' },",
	"    { capability: 'model', reason: 'model offers a hint from the projected view' }",
	"  ],",
	"  create() { return { secret: 'buried-at-the-old-oak-tree', clues: 0, hints: [], solved: false }; },",
	"  project(c) { return { clues: c.state.clues, hints: c.state.hints.slice(), solved: c.state.solved }; },",
	"  actions() { return [{ type: 'search' }, { type: 'guess', allowsText: true }]; },",
	"  reduce(c, a) {",
	"    if (a.type === 'guess') {",
	"      const text = (a.payload && a.payload.text) || '';",
	"      const solved = text === c.state.secret;",
	"      return { state: { secret: c.state.secret, clues: c.state.clues, hints: c.state.hints, solved }, status: solved ? 'completed' : 'active', events: [{ visibility: 'public', type: solved ? 'solved' : 'missed' }] };",
	"    }",
	"    if (a.type === 'search') {",
	"      const clues = c.state.clues + 1;",
	"      return {",
	"        state: { secret: c.state.secret, clues, hints: c.state.hints, solved: c.state.solved },",
	"        status: 'active',",
	"        events: [{ visibility: 'public', type: 'searched', detail: { clues } }],",
	"        effects: [{ kind: 'model', request: { viewer: 'model', mode: 'text', actionType: 'search', instruction: 'Offer one short hint based only on the clues you can see.' } }],",
	"      };",
	"    }",
	"    return { state: c.state, status: 'active', events: [] };",
	"  },",
	"});",
].join("\n");

// ─── C. Deterministic-random rounds ──────────────────────────────────────────
//
// Declares the `deterministic_random` capability. Each `draw` consumes exactly
// one `c.random.die(6)` value, so a fixed seed reproduces the identical draw +
// event sequence (and therefore an identical stable hash) across independent
// runs, while a different seed produces a divergent sequence. Completes after
// three draws. Driven through the real `createDeterministicRandom` stream the
// tester builds from the seed — no `Math.random`, no mock RNG.

export const DETERMINISTIC_RANDOM_REFERENCE_SOURCE = [
	"context.experience.register({",
	"  apiVersion: 1,",
	'  manifest: { id: "ref_dice", name: "Reference Deterministic Random" },',
	"  capabilities: [{ capability: 'deterministic_random', reason: 'one die draw per round' }],",
	"  create() { return { draws: [] }; },",
	"  project(c) { return { draws: c.state.draws.slice() }; },",
	"  actions() { return [{ type: 'draw', label: 'Draw' }]; },",
	"  reduce(c) {",
	"    const face = c.random.die(6);",
	"    const draws = c.state.draws.slice(); draws.push(face);",
	"    return { state: { draws }, status: draws.length >= 3 ? 'completed' : 'active', events: [{ visibility: 'public', type: 'drew', detail: { face } }] };",
	"  },",
	"});",
].join("\n");

// ─── D. Script-controlled participant ────────────────────────────────────────
//
// Declares the `participants` capability + the optional `choose` method. A
// single `bot` (script-controlled) seat has legal actions and acts ONLY through
// the host's explicit `choose` → reduce loop: the host computes legal actions
// for the bot viewer, calls `choose`, then reduces the picked intent. The bot
// is the ONLY seat that ever advances; a human seat present in the roster is
// never attributed a bot action. Completes after three `step` actions.

export const SCRIPT_CONTROLLED_REFERENCE_SOURCE = [
	"context.experience.register({",
	"  apiVersion: 1,",
	'  manifest: { id: "ref_script_bot", name: "Reference Script Bot" },',
	"  capabilities: [{ capability: 'participants', reason: 'one script-controlled seat' }],",
	"  create() { return { steps: 0 }; },",
	"  project(c) { return { steps: c.state.steps }; },",
	"  actions(c, v) {",
	"    if (v && v.participantId === 'bot') return [{ type: 'step', participantId: 'bot' }];",
	"    return [];",
	"  },",
	"  choose(c, info) {",
	"    const pick = info.legal[0];",
	"    return pick ? { type: pick.type, participantId: info.viewer.participantId } : { type: 'step', participantId: 'bot' };",
	"  },",
	"  reduce(c, a) {",
	"    if (a.participantId !== 'bot') return { state: c.state, status: 'active', events: [] };",
	"    const steps = c.state.steps + 1;",
	"    return { state: { steps }, status: steps >= 3 ? 'completed' : 'active', events: [{ visibility: 'public', type: 'stepped', detail: { steps } }] };",
	"  },",
	"});",
].join("\n");

// ─── E. Model-controlled structured action ───────────────────────────────────
//
// Declares `participants` + `model`. A HUMAN `pick` (no participantId) asks the
// model seat to choose a door and emits a structured action-mode model effect
// targeted at the model seat (`request.viewer === 'model'`, `request.mode ===
// 'action'`). The host then feeds the structured pick back as `{ type: 'pick',
// participantId: 'model', payload: { door } }`, which the kernel accepts against
// the legal action set and the reducer records. Completes after the model has
// picked three doors. No provider/model executor is invoked — the effect is
// reported data only, and the structured feed-back is driven directly.

export const MODEL_STRUCTURED_REFERENCE_SOURCE = [
	"context.experience.register({",
	"  apiVersion: 1,",
	'  manifest: { id: "ref_model_pick", name: "Reference Model Pick" },',
	"  capabilities: [",
	"    { capability: 'participants', reason: 'human + model seats' },",
	"    { capability: 'model', reason: 'model chooses a structured door' }",
	"  ],",
	"  create() { return { round: 0, picks: [] }; },",
	"  project(c) { return { round: c.state.round, picks: c.state.picks.slice() }; },",
	"  actions() { return [{ type: 'pick', label: 'Pick a door' }]; },",
	"  reduce(c, a) {",
	"    if (a.type !== 'pick') return { state: c.state, status: 'active', events: [] };",
	"    if (a.participantId === 'model') {",
	"      const door = (a.payload && a.payload.door) || 0;",
	"      const picks = c.state.picks.slice(); picks.push(door);",
	"      const round = c.state.round + 1;",
	"      return { state: { round, picks }, status: round >= 3 ? 'completed' : 'active', events: [{ visibility: 'public', type: 'picked', detail: { door } }] };",
	"    }",
	"    return {",
	"      state: c.state, status: 'active', events: [{ visibility: 'public', type: 'offered' }],",
	"      effects: [{ kind: 'model', request: { viewer: 'model', mode: 'action', instruction: 'Pick a legal door.' } }],",
	"    };",
	"  },",
	"});",
].join("\n");
