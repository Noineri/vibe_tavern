/**
 * Rules starter catalog (IR-81A). The five editable source skeletons a new
 * interactive rules script is copied from. Each starter is a self-contained
 * JS body that calls `context.experience.register({…})` with the four mandatory
 * methods (create / project / actions / reduce) and uses ONLY the public
 * Interactive Runtime contract — no application-internal imports and no host
 * globals (the VM allowlist excludes window, document, fetch, require, etc.).
 *
 * Order is the canonical display order in the editor picker and mirrors the
 * five visual starters (IR-63): Round ↔ Choice, Board ↔ Grid/Board, Card ↔
 * Card Table, Model Conversation ↔ Conversation, Blank State Machine ↔ Blank.
 *
 * Starter constants are immutable (`Object.freeze`). The authoring surface
 * (IR-81C) copies a starter's `source` into a fresh user-owned draft; the
 * frozen original is never mutated.
 */

/** One shipped rules starter. */
export interface RulesStarter {
  /** Stable id (matches the manifest id inside the source). */
  readonly id: string;
  /** Human-readable name shown in the "new from starter" picker. */
  readonly label: string;
  /** One-line description of what the starter is suited for. */
  readonly description: string;
  /** The editable JS source body (self-contained; calls register). */
  readonly source: string;
}

// ─── Source bodies ───────────────────────────────────────────────────────────
//
// Each body uses the public registration contract discovered by the IR-12
// sandbox: `context.experience.register({ apiVersion, manifest, capabilities,
// create, project, actions, reduce })`. The optional `choose` / `flavor`
// methods and the `setup` descriptor are omitted to keep starters minimal.
// Method shorthand (ES6) is supported inside the VM context.

const ROUND_SOURCE = [
  "context.experience.register({",
  "  apiVersion: 1,",
  '  manifest: { id: "round", name: "Round" },',
  "  capabilities: [{ capability: 'participants', reason: 'per-player turns and scores' }],",
  "  create(context) {",
  "    var names = context.participants.map(function (p) { return p.label || p.id; });",
  "    return { round: 1, turn: 0, scores: names.map(function () { return 0; }), names: names };",
  "  },",
  "  project(context) {",
  "    return {",
  "      round: context.state.round,",
  "      activePlayer: context.state.names[context.state.turn] || context.state.names[0],",
  "      scores: context.state.scores.slice(),",
  "      names: context.state.names.slice()",
  "    };",
  "  },",
  "  actions() {",
  "    return [",
  "      { type: 'score', label: 'Score' },",
  "      { type: 'pass', label: 'Pass turn' }",
  "    ];",
  "  },",
  "  reduce(context, action) {",
  "    var s = context.state;",
  "    if (action.type === 'score') {",
  "      var scores = s.scores.slice(); scores[s.turn] += 1;",
  "      return { state: { round: s.round, turn: s.turn, scores: scores, names: s.names }, status: 'active', events: [{ visibility: 'public', type: 'scored' }] };",
  "    }",
  "    if (action.type === 'pass') {",
  "      var next = (s.turn + 1) % s.names.length;",
  "      var round = next === 0 ? s.round + 1 : s.round;",
  "      return { state: { round: round, turn: next, scores: s.scores.slice(), names: s.names }, status: 'active', events: [{ visibility: 'public', type: 'turn_passed' }] };",
  "    }",
  "    return { state: s, status: 'active', events: [] };",
  "  }",
  "});",
].join("\n");

const BOARD_SOURCE = [
  "context.experience.register({",
  "  apiVersion: 1,",
  '  manifest: { id: "board", name: "Board" },',
  "  capabilities: [],",
  "  create() {",
  "    return { cells: [null, null, null, null, null, null, null, null, null], player: 0, moves: 0 };",
  "  },",
  "  project(context) {",
  "    return { cells: context.state.cells.slice(), player: context.state.player, moves: context.state.moves };",
  "  },",
  "  actions(context) {",
  "    var legal = [];",
  "    for (var i = 0; i < context.state.cells.length; i++) {",
  "      if (context.state.cells[i] === null) legal.push({ type: 'place_' + i, label: 'Cell ' + (i + 1) });",
  "    }",
  "    return legal;",
  "  },",
  "  reduce(context, action) {",
  "    if (action.type.indexOf('place_') !== 0) return { state: context.state, status: 'active', events: [] };",
  "    var idx = parseInt(action.type.slice(6), 10);",
  "    if (isNaN(idx) || idx < 0 || idx >= context.state.cells.length || context.state.cells[idx] !== null)",
  "      return { state: context.state, status: 'active', events: [] };",
  "    var cells = context.state.cells.slice();",
  "    cells[idx] = context.state.player;",
  "    var moves = context.state.moves + 1;",
  "    var status = moves >= 9 ? 'completed' : 'active';",
  "    return { state: { cells: cells, player: (context.state.player + 1) % 2, moves: moves }, status: status, events: [{ visibility: 'public', type: 'placed', detail: { index: idx } }] };",
  "  }",
  "});",
].join("\n");

const CARD_SOURCE = [
  "context.experience.register({",
  "  apiVersion: 1,",
  '  manifest: { id: "card", name: "Card" },',
  "  capabilities: [{ capability: 'deterministic_random', reason: 'shuffle the deck' }],",
  "  create(context) {",
  "    var suits = ['hearts', 'diamonds', 'clubs', 'spades'];",
  "    var deck = [];",
  "    for (var s = 0; s < 4; s++) {",
  "      for (var r = 1; r <= 13; r++) { deck.push(r + ' of ' + suits[s]); }",
  "    }",
  "    deck = context.random.shuffle(deck);",
  "    return { deck: deck, hand: [] };",
  "  },",
  "  project(context) {",
  "    return { hand: context.state.hand.slice(), remaining: context.state.deck.length };",
  "  },",
  "  actions(context) {",
  "    if (context.state.deck.length === 0) return [];",
  "    return [{ type: 'draw', label: 'Draw a card' }];",
  "  },",
  "  reduce(context, action) {",
  "    if (action.type !== 'draw' || context.state.deck.length === 0)",
  "      return { state: context.state, status: 'active', events: [] };",
  "    var deck = context.state.deck.slice();",
  "    var card = deck.shift();",
  "    var hand = context.state.hand.slice();",
  "    hand.push(card);",
  "    var status = deck.length === 0 ? 'completed' : 'active';",
  "    return { state: { deck: deck, hand: hand }, status: status, events: [{ visibility: 'public', type: 'drew', detail: { card: card } }] };",
  "  }",
  "});",
].join("\n");

const MODEL_CONVERSATION_SOURCE = [
  "context.experience.register({",
  "  apiVersion: 1,",
  '  manifest: { id: "model_conversation", name: "Model Conversation" },',
  "  capabilities: [{ capability: 'model', reason: 'AI-driven conversation replies' }],",
  "  create() {",
  "    return { messages: [], turn: 0 };",
  "  },",
  "  project(context) {",
  "    return { messages: context.state.messages.slice(), turn: context.state.turn };",
  "  },",
  "  actions() {",
  "    return [{ type: 'say', label: 'Say something', allowsText: true }];",
  "  },",
  "  reduce(context, action) {",
  "    if (action.type !== 'say') return { state: context.state, status: 'active', events: [] };",
  "    var text = typeof action.payload === 'string' ? action.payload : '';",
  "    var messages = context.state.messages.slice();",
  "    messages.push({ role: 'user', text: text });",
  "    return {",
  "      state: { messages: messages, turn: context.state.turn + 1 },",
  "      status: 'active',",
  "      events: [{ visibility: 'public', type: 'user_said', detail: { text: text } }],",
  "      effects: [{ kind: 'model', request: { viewer: 'model_seat', mode: 'text', instruction: 'Reply to the conversation' } }]",
  "    };",
  "  }",
  "});",
].join("\n");

const BLANK_SOURCE = [
  "context.experience.register({",
  "  apiVersion: 1,",
  '  manifest: { id: "blank_state_machine", name: "Blank State Machine" },',
  "  capabilities: [],",
  "  create() {",
  "    return { count: 0, label: 'Ready' };",
  "  },",
  "  project(context) {",
  "    return { count: context.state.count, label: context.state.label };",
  "  },",
  "  actions() {",
  "    return [",
  "      { type: 'increment', label: 'Increment' },",
  "      { type: 'reset', label: 'Reset' }",
  "    ];",
  "  },",
  "  reduce(context, action) {",
  "    if (action.type === 'increment') {",
  "      var c = context.state.count + 1;",
  "      var label = c >= 10 ? 'Max' : 'Counting';",
  "      return { state: { count: c, label: label }, status: c >= 10 ? 'completed' : 'active', events: [{ visibility: 'public', type: 'incremented' }] };",
  "    }",
  "    if (action.type === 'reset') {",
  "      return { state: { count: 0, label: 'Reset' }, status: 'active', events: [{ visibility: 'public', type: 'reset' }] };",
  "    }",
  "    return { state: context.state, status: 'active', events: [] };",
  "  }",
  "});",
].join("\n");

// ─── Catalog ─────────────────────────────────────────────────────────────────

/** The five shipped starters in canonical picker order. Frozen — never mutated. */
export const RULES_STARTERS: readonly RulesStarter[] = Object.freeze([
  Object.freeze({
    id: "round",
    label: "Round",
    description: "Turn-based rounds with per-player scores and turn passing. Uses the participants capability.",
    source: ROUND_SOURCE,
  }),
  Object.freeze({
    id: "board",
    label: "Board",
    description: "A 3×3 grid where two players alternate placing marks. No capabilities — pure state transitions.",
    source: BOARD_SOURCE,
  }),
  Object.freeze({
    id: "card",
    label: "Card",
    description: "A shuffled deck with draw-to-empty mechanics. Demonstrates the deterministic-random capability.",
    source: CARD_SOURCE,
  }),
  Object.freeze({
    id: "model_conversation",
    label: "Model Conversation",
    description: "A conversation turn that emits a model effect for AI replies. Uses the model capability.",
    source: MODEL_CONVERSATION_SOURCE,
  }),
  Object.freeze({
    id: "blank_state_machine",
    label: "Blank State Machine",
    description: "Minimal counter with increment/reset. No capabilities — the escape hatch for custom state machines.",
    source: BLANK_SOURCE,
  }),
]);

/** Look up a starter by id (returns undefined if not found). */
export function getRulesStarter(id: string): RulesStarter | undefined {
  return RULES_STARTERS.find((s) => s.id === id);
}

/** All starter source strings, for the no-host-globals / no-imports test sweep. */
export const RULES_STARTER_SOURCES: readonly string[] = Object.freeze(
  RULES_STARTERS.map((starter) => starter.source),
);

// ─── Duplication inputs (pure value copies — never mutate the source) ────────

/**
 * Produce the draft values for a new interactive rules script copied from a
 * starter. Returns a fresh plain object; the frozen starter is never mutated.
 * The resulting `{ name, code }` is a direct input to `createScript`.
 */
export interface InteractiveRulesDraftValues {
  name: string;
  description: string;
  code: string;
  scriptKind: "interactive";
  enabled: false;
}

export function rulesStarterToDraftValues(starter: RulesStarter): InteractiveRulesDraftValues {
  return {
    name: starter.label,
    description: starter.description,
    code: starter.source,
    scriptKind: "interactive",
    enabled: false,
  };
}

/** Copy an existing source into a new, explicitly untrusted interactive draft. */
export function duplicateRulesValues(
  source: Pick<InteractiveRulesDraftValues, "name" | "description" | "code">,
): InteractiveRulesDraftValues {
  return {
    name: source.name,
    description: source.description,
    code: source.code,
    scriptKind: "interactive",
    enabled: false,
  };
}
