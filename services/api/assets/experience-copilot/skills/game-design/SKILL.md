---
name: game-design
description: "Design a mini-app game so it is fun and understandable: the core loop, the goal and the end of a round, the systems a rule set needs, choices that matter, and how the game teaches the player from the screen alone. Use when building a new game, when a request is short or vague, when the user says the game is boring, confusing, unfair, or they do not understand how to play, or before adding a feature."
---

# Game design for Experience Copilot

This skill helps you decide what the game is before you write it, and check that a new player can play it from the screen alone.
Work through the steps that fit the task: all of them for a new game, the relevant one for a change.
Keep your reasoning short in chat; it shapes the buffers, it is not a report for the user.

## Step 1 — Write the game in five lines

Before the first draft, write these five lines for yourself (and show them to the user when you propose the game):

1. **Goal:** what the player is trying to achieve.
2. **Loop:** the situation the player sees → the action they take → the consequence → the new situation.
3. **End:** how a round ends, and what counts as winning, losing, or a draw.
4. **Seats:** who plays — the user alone, the user against a script, or the user against a character on a model seat.
5. **Pace:** alternating turns, or realtime.

If the request leaves one of these open and the answer changes the build, ask the user (the `grill-me` skill runs this interview).
A well-known game already fixes most lines: for chess or blackjack ask only about the variant, the look, and the character's part.

Example — «make a haggling game with the merchant»:
1. Goal: buy the amulet for as little as possible before the merchant loses patience.
2. Loop: the merchant names a price and shows a mood → the player offers, flatters, or walks away → the price and the patience change → a new price.
3. End: a deal, or the merchant's patience runs out; the score is the discount.
4. Seats: the user against the merchant on a model seat.
5. Pace: alternating turns.

## Step 2 — List the systems the request does not mention

Every rule set implies systems nobody asked for.
List them and build them in the first playable version, not later:

- what the player sees when an action is not allowed, and why (a reason next to the control);
- whose turn it is, and what the other side is doing while the player waits;
- how a round ends, the result screen, and how to play again;
- ties, and the situation where nobody can move;
- the character's seat: what it knows, how it chooses, what happens if its model does not answer (see `roleplay-integration`);
- any count the player must track in their head (cards left, patience, lives) — show it.

Example for the haggling game: the «walk away» action and what it does; the patience meter; what happens at patience zero; the result line «Bought for 40 coins — 60% off»; a «Haggle again» button.

## Step 3 — Give the player real choices

For each action, write one sentence: when is this the right move?
If an action has no situation where it is the best choice, change its cost, its risk, or its timing until it has one.
Good choices trade something: a sure small gain against a risky big one, speed against safety, now against later.

When the game has numbers (money, health, a score multiplier), play three moments on paper with the real values: the start, a tight spot, and the late game.
Look for a player who cannot recover, a resource that never runs short, or one strategy that always wins.
Then name a specific change and what it should do: «flattery costs 1 patience instead of 0, so it cannot be repeated forever».

For a puzzle, check that the goal is reachable from the start, not only that a legal move exists.
For random setups, decide first what makes a setup interesting, then randomize within that.

## Step 4 — Teach the game through play

The player learns from the screen, not from your chat message.
Many players will never read your explanation, so the game itself has to show how it is played.

**4a. Decide what needs teaching.**
Go through the rules one by one and ask: would the player find this by clicking what is highlighted?
If yes, a highlight is enough.
If no — a rule that is unusual, hidden, or only applies sometimes — plan to explain that rule in one sentence at the moment it first applies, next to the thing it concerns.
The most complex rule always gets that sentence.

**4b. Shape the first round in four beats.**
1. **Show** the main action once where nothing is at stake. Often the opponent does it first, so the player sees cause and effect before acting.
2. **Use** — the player does the same action with something at stake.
3. **Twist** — a situation that uses the action in a new way (the first time a special rule applies).
4. **Master** — the player handles it on their own.

Example for the haggling game: the merchant opens with a price and the page shows «Your offer must be lower than his price»; the first offer has no patience cost; the first flattery reveals that mood changes the next price; the round ends with the player deciding alone when to accept.

**4c. Put the instructions on the screen.**
- One line with the goal, visible from the start.
- On every turn: whose turn it is and what the player can do right now.
- When the player selects something, highlight where it can go or what it can affect.
- A control the player cannot use yet says why, where it sits («Wait for the merchant», «Offer less than 80»).
- The result of each action appears where the player is looking.
- Keep a short history of what happened («Merchant: 80 → you: 50 → merchant: 70»).

**4d. Make every action close its loop.**
For each action, check four things: the input, what the rules compute, what the player sees change, and what the player should conclude.
An action whose visible result does not tell the player anything is where they will hesitate.
Example: an offer the merchant ignores needs a visible reaction («He laughs. Price stays at 80»), or the player thinks the button is broken.

**4e. Help after repeated failure.**
Count failures at the same step; after two or three in a row, offer help the player may take or ignore («Show the merchant's lowest acceptable price»).

**4f. Test it in your head.**
Imagine a player who skipped your explanation.
Can they make their first move from the screen alone? Do they know when they won?
If not, the screen is not finished.

## Step 5 — Keep one fact sheet

Write a short list of every number and name the game uses: counts, costs, limits, action names, seat names.
The rules, the page labels, the help text, and the character's instruction must all agree with it.
After every edit, check the edited buffer against the sheet.
Example: if the rules give 10 patience but the page says «Patience: 8», the player learns the wrong game.

## Step 6 — Shape challenge and recovery

Make challenge grow along one named dimension at a time: tighter timing, fewer resources, smarter opponent, more to track.
Give a dangerous moment a visible warning and time to respond.
After a hard moment, give a moment of relief or a clear milestone.
Decide what a loss teaches and how quickly the next attempt starts; a short game restarts in one click.

## Changing an existing game

Tie every change to a player problem: a repeated choice that is always the same, a risk the player cannot see, no way to recover, an unclear goal.
Say what changes, what stays, and what the change costs.
Prefer deepening the existing action over adding a new subsystem.
Keep every feature the user asked for; suggest removals, never make them silently.

## Where the work goes

Mechanics, numbers, movement and outcomes live in `rules`; the player sees them through `project`.
Tell `game-visualization` what the player must notice and which actions need to look different.
For a realtime game with moving objects, read the contact section of `game-motion`.
For a character opponent, read `roleplay-integration`.

## Handing the game to the user

`run_test` and `run_simulate` show that the rules run and reach an end; they do not show that the game is understandable or fun.
Say so plainly, and ask the user for one play-through:

> Play one round without reading my explanation. Tell me where you hesitated or did not know what to do.

Fix each hesitation on the screen (a label, a highlight, a reason next to a control), not with a longer chat explanation.
