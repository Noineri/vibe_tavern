---
name: game-visualization
description: "Make a mini-app look like a finished game: a visual direction, scene layout, crafted objects with light and material, readable controls and states, and synthesized sound. Use when writing or restyling the visual buffer, or when the user says the game looks plain, sloppy, generic, cramped, or like a form."
---

# Game visualization for Experience Copilot

This skill helps you build a visual that looks like a small finished game.
The visual is one HTML page with CSS, inline SVG or canvas, and plain JavaScript; it has no images, fonts, libraries or network.
The bridge (how the page connects and sends actions) is described in the visual reference; this skill is about what the page looks like and how it feels to use.
Changing a rule, a timing or a hit area is `game-design` work; this skill changes how things look.

## Step 1 — Turn the direction into construction decisions

Pick a direction that fits the game, then write it as concrete parts and materials.
An adjective is not enough to build from; a list of objects and materials is.

- «A warm card table» → an oval green felt surface, a narrow wood rim, ivory cards with clear corner indices, burgundy patterned backs, small brass accents.
- «A night garden» → a deep blue field, round stepping stones with a moss edge, glowing seed pods, pale moonlight from the top left.
- «A retro arcade» → a bounded black field, hard-edged blocky objects, four saturated colors, one-pixel highlights, a compact score strip.

Write a small palette with roles: background, play field, objects, text, interaction accent, success, danger.
Use it on every screen — lobby, play, choices, result — so they look like one game.
If the user has not chosen a direction, recommend one and build it; ask only when the choice would change the whole design.
When fixing one part of an existing visual, keep its established look.

## Step 2 — Declare the light and the layers once

At the top of the visual, write two decisions that every object follows.

**One light direction.** For example, light from the top left: highlights sit on the top-left edges, shadows fall down and to the right.
Keep the offsets in variables and derive every gradient angle and shadow offset from them, so the whole scene agrees.

```css
:root { --light-x: -1; --light-y: -1; /* light from the top left */
        --shadow-x: calc(var(--light-x) * -3px); --shadow-y: calc(var(--light-y) * -4px); }
```

**One layer stack, back to front.** For example: background → field → pieces → selection marks → effects → HUD.
Build the page in that order; in canvas, draw in that order every frame.
Where pieces overlap (a stack of tiles, a fanned hand), sort them by a key — row, then depth — and draw from back to front.

Lighting belongs to world objects.
Labels, counters and buttons stay flat and readable.

## Step 3 — Lay out the scene

Start from the play field: its shape and size come from the game.
Then attach the HUD and controls to its edges.

- A board game: cells large enough to show the pieces, with the supply or hand next to the board.
- A card game: a band for the player's hand, a center for play, a separate band for names and actions.
- A vertical action game: a bounded vertical arena centered in the frame, its aspect ratio kept on wide screens.

Compute repeated layouts:
cell width = (board width − gaps − board padding) ÷ columns.
For a fanned hand, keep each card's corner index visible at the largest hand size.

Budget text for the user's language: Russian labels run 20–30% longer than English.
Lay out each row for the longest label, and let labels wrap or move to a second line rather than cutting them off.

Report the real content size with `xp.resize(width, height)` after each render.
For a narrow frame, move the side panel into a row above or below the field; keep the field's proportions.

## Step 4 — Craft one object completely, then reuse it

Spend detail on the objects the player handles and watches.
Build one representative object in five passes:

1. **Silhouette** — a recognizable outline at its real size.
2. **Parts** — the card's corner and center, the stone's top and its side, the coin's rim and face.
3. **Material** — for each material decide the base color and how sharp its highlight is: polished metal and glass get a small bright hard highlight, wood and cloth a wide soft one or none.
4. **Details** — a few marks that stay visible at the real size: a seam, a suit symbol, a moss edge.
5. **States** — selected, disabled, damaged: change the object, keep it recognizable.

Ground objects with a short contact shadow under them; save soft blurred shadows for the one or two most important pieces.
Glow only what matters most right now (the active piece, the item just scored) and keep its outline sharp.

A compact example of two solid objects from plain elements:

```html
<style>
  .scene { --shadow: rgba(40, 30, 20, .3); display: flex; gap: 24px; align-items: center; }
  /* Coin: recessed face, light rim, drawn edge, contact shadow. */
  .coin { width: 64px; aspect-ratio: 1; border-radius: 50%;
    background: radial-gradient(circle at 40% 35%, #fff3b0 0 8%, #e9c75a 9% 58%, #c99a2e 60% 70%, #f2d878 72% 100%);
    box-shadow: 0 3px 0 #9c7420, 0 8px 10px -5px var(--shadow); }
  /* Tile: face gradient; stacked zero-blur shadows draw the thickness, the last one casts. */
  .tile { width: 48px; height: 64px; border-radius: 7px; display: grid; place-items: center;
    font: 600 26px/1 Georgia, serif; color: #2b4a7a;
    background: linear-gradient(#fffdf6, #efe8d6);
    box-shadow: inset 0 1px 0 #fff, 0 5px 0 #c9b98f, 0 6px 0 #a8976c, 0 10px 12px -4px var(--shadow);
    transition: transform .12s ease-out, box-shadow .12s ease-out; }
  /* Selected: lifted, longer cast shadow, outline ring — the same object. */
  .tile.is-selected { transform: translateY(-4px);
    box-shadow: inset 0 1px 0 #fff, 0 5px 0 #c9b98f, 0 6px 0 #a8976c, 0 16px 16px -6px var(--shadow), 0 0 0 3px #e2a13b; }
</style>
<div class="scene"><div class="coin"></div><div class="tile is-selected">7</div></div>
```

The same recipe — a face, a drawn edge, a contact shadow, one highlight — builds a card, a die, a brick or a button.
Change shape, palette and proportions between objects; keep the light the same.
HTML and CSS are the main toolkit; keep an existing canvas renderer when the game already uses one; use small inline SVG for exact icons.

For tilted, flipping or turning 3D objects, read `game-visualization/assets/depth-and-3d.md`.
For a wedge, token or stack that must stay solid while it rotates, read `game-visualization/assets/rotating-solids.md`.
For a shader-lit background, hundreds of particles, or a die or board drawn in real 3D, read `game-visualization/assets/webgl.md` first: the canvas can use hand-written WebGL, with a CSS fallback.

## Step 5 — Show what the player can do

Read `view.actions` on every render: it lists exactly what this player may do now.

- Give every object the player can act on a pointer cursor, a hover cue (a small lift), and a pressed state; objects that cannot be acted on stay plain.
- When the player selects a piece, highlight the targets that the legal actions allow.
- Show a disabled control with its reason beside it («Wait for your turn»).
- When `view.actions` is empty, show a waiting state with who the game is waiting for.
- For dragging, capture the pointer (`setPointerCapture`) so the drag continues outside the piece, and end it in all three cases: dropped on a target, dropped elsewhere, cancelled.
  Send only the final drop to the rules; the rules decide whether it was legal.
- Make touch targets at least about 40 px, and keep every action reachable without hover.
- Put text that came from a player or a model seat into the page with `textContent`, so it always shows as text.

Use clear type roles: a title (22–28 px), body and controls (14–16 px), secondary labels (12–13 px), and tabular numerals for scores and timers (`font-variant-numeric: tabular-nums`).
System fonts are enough.
Give the main action the strongest button; other buttons share the style more quietly.
Group information by spacing and alignment; keep borders for the play field and the objects themselves.

## Step 6 — Treat each situation as its own screen state

- **Your turn** — the actions are visible and lively.
- **Waiting** — show whose turn it is; `onPending` tells you when the host is working («thinking…»).
- **Error** — `onError` gives a message; show it near the action and keep the last good view on screen.
- **Finished** — when `view.status` is `"completed"`, show the result clearly and the next step (play again, if the rules offer it).

Draw the screen from the current view every time, so a reload shows the same picture.
Play a flourish (a flash, a sound, a «+10») only for a change you see for the first time — remember the last revision you celebrated.

## Step 7 — Add sound when the game benefits

The page can synthesize short sounds with the Web Audio API; no files are needed.

```js
var audio = null, soundOn = false; // turn on from the sound button
function tone(freq, ms, type) {
  if (!soundOn) return;
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
  o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + ms / 1000);
}
```

- Give a sound only to actions that matter, in three levels: a soft tick for an ordinary action, a clear tone for a success or setback, a short phrase for the end of a round.
- Each call makes a new oscillator, so overlapping sounds do not cut each other off.
- Put a visible sound on/off button in the HUD. Start with sound off unless the user asked for sound; browsers allow audio to start after the player's first click.

## Step 8 — Review and hand over

Read your finished visual once as a whole: the layout at a narrow and a wide frame, the longest labels, a full hand or board, the result screen, and every state from Step 6.
You can verify sizes and structure from the source; whether it looks beautiful only the user can see.
Tell the user what you built in one or two sentences and give one concrete thing to look at, for example: «Check that the whole board and the hand fit without scrolling, and that the selected tile stands out».
