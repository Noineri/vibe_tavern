---
name: roleplay-integration
description: "Connect a mini-app to the roleplay: a character as an opponent or partner on a model seat, how it chooses moves, bluffs, loses gracefully and comments in character, what it may know, and what the chat learns when the session ends. Use when a mini-app involves a character, NPC, opponent, dealer or narrator, or when its result should matter in the roleplay chat."
---

# Roleplay integration for Experience Copilot

Inside a roleplay, the mini-app carries the tedious part — rules, randomness, bookkeeping — and the character and the chat carry the drama.
The rules decide outcomes; the character chooses among legal moves and speaks; the chat narrates what happened.
The exact APIs are in the rules and visual references; this skill decides which channel to use and how to make the character a good opponent.

## The four channels

| Channel | How | Waits for it? | Changes state? | What the model knows |
|---|---|---|---|---|
| Model move | `reduce` returns `effects: [{ kind: "model", request: { viewer, mode, actionType?, instruction? } }]`; capability `model` | yes — that seat's turn | yes, through `reduce` | the seat's projected view and legal actions, plus the character and persona the host adds; story only with `rp_context` |
| Character line (chatter) | `flavor(context, viewer)` returns `{ experienceChatter: { seatId, instructions, fallback } }` as its only key | no | never | only your `instructions` — no character card, no persona, no story |
| Realtime request | the visual calls `xp.modelRequest(seatId, prompt)`; the reply arrives as a `model_result` loop event | no | only through a legal action | the seat's model with your prompt |
| Chat report | public events (`visibility: "public"`), frozen when the session finishes and attached to the user's next message | — | — | the chat model reads them as resolved facts |

Chatter is one short line (under ~50 words) shown in the visual; `fallback` shows while it is pending or if it fails.
The host makes at most one chatter call per session, viewer and revision.

## Step 1 — Decide who chooses the character's moves

- **The rules choose, the character talks.** A script seat with `choose` picks the move by a formula; chatter gives the character a voice. Instant, free, predictable difficulty. Good for a dealer, a bank, a quick opponent.
- **The character chooses.** A model seat with `mode: "action"` picks one of its legal actions. Its personality shapes real choices — when to bluff, when to show mercy. Each move is a model call and takes a few seconds.
- **The character speaks as its move.** A model seat with `mode: "text"`: an answer in a quiz, a reply in a conversation. The rules store the text; they never read an outcome out of it.

If a choice changes the outcome, offer it as actions; free text never decides something the rules cannot check.

## Step 2 — Make the character a good opponent

**2a. The rules do the math, the character chooses.**
On the character's turn, list a few concrete options and put what the character can know into each `label`.
The model then picks an option instead of calculating.

Example — a one-card poker duel (each player holds one card of J, Q, K; the character holds Q):

```js
actions(context, viewer) {
  if (viewer !== context.state.botSeat || context.state.turn !== viewer) return [];
  return [
    { type: 'check',   label: 'Check — show cards if the user also checks; you win against J (50%)' },
    { type: 'bet',     label: 'Bet 1 coin — a careful user folds a J and calls with a K' },
    { type: 'fold',    label: 'Fold — lose the 1 coin ante' }
  ];
}
```

The `instruction` of the model request carries the personality as plain numbers and a manner:
«You are cautious: you bet only when you are likely ahead, and bluff about one time in six. You hate losing to the user and say so.»

**2b. Bluffing is a share, not a rule.**
A good bluffer sometimes raises with a weak hand and sometimes plays a strong hand quietly; no move reveals the hand for certain.
For a script seat, write it as a probability table by hand strength:

| Hand | Fold | Call | Raise |
|---|---|---|---|
| weak | 80% | 5% | 15% (bluff) |
| middle | 10% | 60% | 30% |
| strong | 0% | 30% | 70% |

Use `context.chance` (or `context.random`) for the roll, so replays stay the same.

**2c. Personality is numbers that match the description.**
Give each character two or three numbers — how often it bluffs, how readily it challenges, how much risk it takes — and make its description agree.
A «reckless» character actually raises more; a «careful» one actually folds more.

**2d. Lose gracefully on easier settings.**
Compute the best move, then at a set rate choose a worse move that a person could make.
Better still, leave openings the player can find with some thought: the character overvalues one kind of hand, or believes a confident bet a little too often.
Avoid mistakes that look impossible for a person, like folding the best possible hand.

**2e. Remember the player's habits.**
Keep a small record in state: how often the user bluffed and was caught, their last big win.
Shift the character's challenge rate with it, and let the character mention it: «Third bluff tonight — I'm calling».

**2f. Keep the character's knowledge honest.**
A model seat receives `project(context, viewer)` for its own seat: hide the user's cards there exactly as for a human.
Its lines and labels use only what it could know.

**2g. A move even when the model is slow.**
For a character that might not answer (a slow or failing model), also return a timer effect for its seat with a safe legal move, for example `{ kind: "timer", request: { viewer: botSeat, actionType: "check", afterMs: 30000 } }`.
If the model answers first, the turn has moved on and the timer's move is rejected without changing anything.
If the timer plays, emit a public event so the story knows («Mira hesitated and checked»).

## Step 3 — Give the character a voice that reacts to the game

Let the rules name the moments worth a remark as events in state: a big raise, a caught bluff, a close win, a long streak.
Write in the chatter `instructions` (or the model move's `instruction`) what kind of remark each moment invites, and the manner:
«Mira, a sly card sharp. The user just caught your bluff: react in one short line, rueful but teasing.»

- Remark on the specific moment, not on the game in general: a win by one coin deserves a remark about the margin.
- Keep the last few lines the character said in state (`keepLast`) and pass them in the instruction, so it does not repeat a joke.
- Ask for chatter only on revisions with such a moment — keep a `highlight` field in state and return the chatter marker only when it is set; otherwise every click costs a model call.
- Chatter receives no character card: put the name and manner into its `instructions`.
- Information the player needs never goes only into chatter; it may arrive late or fail.

## Step 4 — Spend model calls deliberately

Each model move and each chatter line is a call on the user's key and adds a few seconds.
One model move per character turn is normal.
Say in the proposal how many calls one round makes, for example: «about 6 calls per round: one per character turn plus a line at the showdown».

## Step 5 — Write the events the chat will narrate

The chat model receives the report as lines: the app name, a fixed line saying these are resolved facts, an optional summary, then one `- <type>: <detail>` line per public event.

- Emit milestones, not clicks: «round_won: Mira called the bluff — the user held only a jack».
- Use the names from `context.participants` labels.
- Write facts, not reactions: «Mira lost the bet», not «Mira is furious». The chat decides the reaction.
- End with an outcome event: the winner, the score, and the stakes (a wager, a favor, an item).
- When the story should learn a secret at the end (the hidden card), emit a public reveal event at that moment.
- In realtime, events are dropped: put the result into `finishRound({ status, score, summary })`.

## Step 6 — Connect to the story

**Who the character is.** The rules have no `context.character` or persona; use the seat `label`.
A model seat already gets the character and persona from the host, so its `instruction` carries game direction only.
For things the app needs to know — the stakes, the opponent's manner — add a `setup` field («Stakes», «Opponent's manner») instead of hard-coding one character.

**Story context (`rp_context`).** Declare it only when the character's choices should depend on the story so far — a grudge, a debt.
It is captured once when the session starts.
Modes: `none`, `recent`, `summaries_recent`, `current_branch`, `compact_summary`; `summaries_recent` suits most character games, `recent` a quick scene, `none` a standalone game.

**The result in the chat (`rp_attachment`).** Declare it when the result matters to the roleplay.
When the session finishes, the host freezes the report; it is attached to the user's next chat message.
A session that never completes never reports, so design a clear end.

## Apps that are not games

- A messenger: an `allowsText` action for the user, a model seat in `text` mode for the character, history kept short with `keepLast`, only important lines as public events.
- A skill check: `deterministic_random` for the roll, one public event with the roll, the target and the result.
- A guided scene: actions for the user's choices, public events for the decisions the story must remember.

## Deliver

Tell the user briefly:
- which seats are characters and what each model call is for, with the expected call count;
- the Try setup each model seat needs, as steps with the interface's own labels (the label list is in `experience-authoring`): the participant with the AI-character role, a provider and a model — without them the character cannot move;
- which capabilities to grant and which context mode you recommend;
- two or three report lines the chat will receive;
- one real-chat check: finish a session, send a message, and see whether the character reacts to the actual result.
