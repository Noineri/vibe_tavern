---
name: game-motion
description: "Make movement in a mini-app feel good and behave fairly: animated moves, dealing, flips, transfers and chains in the visual, plus movement, bouncing and collisions in realtime rules (balls, pucks, falling objects, a player avatar). Use when moves look abrupt, teleport or jump, feel sluggish or flat, when an animation replays or gets stuck, or when objects pass through walls, stick, or hits feel unfair."
---

# Game motion for Experience Copilot

This skill covers two kinds of movement:
- **Presentation motion** in the visual — a card flying to the table, a tile lifting, a stack settling. It shows what happened; it never changes the result.
- **Game movement and contact** in realtime rules — a ball bouncing, a falling apple caught by a basket. It decides what happens; see the section «Movement and contact in realtime rules».

## Part A — Presentation motion

### Step 1 — Say what the motion must explain

Name what the player should understand: where the piece came from, where it went, what joined what, what was hit, what changed.
Then sort the motion into one of three kinds:
- **resting** — a selected piece glows while it stays selected;
- **continuous** — a timer bar shrinks, water ripples;
- **one-shot** — a deal, a transfer, a reveal: it has a start and an end, and plays once.

For an existing game, name the defect first: a piece teleports, turns around the wrong point, two animations fight, the move replays after reload, the sequence is too slow.

### Step 2 — Give one move four phases

Treat the moving piece as one actor that keeps its identity and its look the whole way.
A card stays a card with its face and corner while it flies.

1. **Lift** — leave the source with a small rise or offset.
2. **Travel** — move toward the target, turning to the target's angle.
3. **Seat** — meet the target exactly, at the right angle and depth.
4. **Settle** — a tiny overshoot that resolves, then rest.

A press or a hit can skip the lift and start at once.
Starting durations to tune from: press feedback 80–120 ms, a transfer 250–400 ms, dealing 150 ms per card with 60 ms between cards, a settle 100–150 ms.
Keep them as named constants at the top of the script.
Check the total: twenty moves of 400 ms in a row is eight seconds; overlap or shorten long chains.

A raised travel arc with exact endpoints:

```text
t = clamp((nowMs - startMs) / durationMs, 0, 1)
u = easeOut(t)
x = startX + (endX - startX) * u
y = startY + (endY - startY) * u - lift * sin(pi * t)
angle = startAngle + angleDelta * easeInOut(t)
```

Rotate around a meaningful point: the card's center, a coin's center, a lever's hinge (`transform-origin`).
Keep all coordinates in one space (the field's), converting from screen pixels once.
For reduced motion, set the end pose directly.

Easing by purpose: speed up to leave (ease-in), slow down to land (ease-out), a small overshoot for a lively landing; constant speed for a conveyor.

### Step 3 — Pick the simplest tool that fits

- A CSS `transition` for a property change between two known values (lift on hover, slide to a slot).
- CSS `@keyframes` for a fixed pattern (a pulse, a shake).
- One `requestAnimationFrame` loop for computed paths and several actors at once; it uses elapsed time in milliseconds, so the speed is the same on every screen.
- In an existing canvas game, add the actor poses to the existing draw loop.

Give each transform role its own wrapper: position on one element, rotation or flip on a child, hover on another, so one rule never erases another.

### Step 4 — Animate changes once, show state always

The view is the truth; the animation is a short story about how the view changed.
- On every new view, compare it with the previous one and find what changed: which piece moved from where to where.
- Animate that change once; remember the revision (or the move id) you already animated.
- On first load or after a reload, show the current state without animation.
- When the animation ends, the screen must match the latest view exactly; if a newer view arrived meanwhile, finish quickly or jump to it.

If the view shows only the final board and the player needs to see the steps of a chain, add an ordered list of moves to `project` (move order, piece, source, target) and animate from it.

For several pieces moving between groups in a chain, or a piece that duplicates or vanishes at a handoff, read `game-motion/assets/chains-and-handoffs.md`.

### Step 5 — Decide what happens when a move is interrupted

For each kind of motion choose one: finish it, queue the next, restart from where the piece is now, or cancel and jump to the latest view.
On reset or a new round, stop every timer and animation loop, remove temporary elements, and release listeners, so the new round starts clean.
The rules never wait for an animation: scoring, turns and legal actions come from the view, not from an animation's end.

Match emphasis to importance: a normal move settles quietly, a big chain gets one stronger accent, the end of a round has its own moment.
The state must be readable with all effects switched off.

## Part B — Movement and contact in realtime rules

In realtime mode the platform calls `update(context, dt)` every `tickMs`, and `dt` is always `tickMs` in milliseconds.
Store speeds in units per second and move by `speed * dt / 1000`.
Simple rules that feel good beat realistic ones.

### Use one unit for both axes

If the field is 500 × 700 pixels and both x and y run 0..1, a circle of radius 0.02 is 10 px wide but 14 px tall.
Use field units where the width is 1 and the height is the aspect ratio (here 1.4), and draw with one scale factor for both axes.

### Keep fast objects from passing through things

Check the distance an object travels in one tick: `speed * tickMs / 1000`.
It must stay below the radius of the moving object and below the thickness of the thinnest wall.
1. First, choose speeds and sizes so this holds.
2. If the design needs faster objects, split each tick into sub-steps and test contact after each one.

### Test the shape, not the center

A ball touches a block when the circle overlaps the rectangle — not when the ball's center enters the block's cell.

```js
// Ball b = {x, y, r, vx, vy}; block k = {x0, y0, x1, y1}. One tick with sub-steps.
function moveBall(b, blocks, sec, bounce) {
  var dist = Math.hypot(b.vx, b.vy) * sec;
  var steps = Math.max(1, Math.ceil(dist / (b.r * 0.5)));
  for (var s = 0; s < steps; s++) {
    b.x += b.vx * sec / steps; b.y += b.vy * sec / steps;
    for (var i = 0; i < blocks.length; i++) {
      var k = blocks[i];
      var px = Math.max(k.x0, Math.min(b.x, k.x1)), py = Math.max(k.y0, Math.min(b.y, k.y1));
      var dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy);
      if (d >= b.r) continue;
      var nx = 0, ny = 0;
      if (d > 0) { nx = dx / d; ny = dy / d; }
      else { // center inside the block: leave by the nearest side
        var l = b.x - k.x0, r = k.x1 - b.x, t = b.y - k.y0, bo = k.y1 - b.y, m = Math.min(l, r, t, bo);
        if (m === l) nx = -1; else if (m === r) nx = 1; else if (m === t) ny = -1; else ny = 1;
        d = -m;
      }
      b.x += nx * (b.r - d); b.y += ny * (b.r - d);          // push out along the normal
      var vn = b.vx * nx + b.vy * ny;
      if (vn < 0) { b.vx -= (1 + bounce) * vn * nx; b.vy -= (1 + bounce) * vn * ny; } // reflect
      return k; // the block hit this tick; the rest of the tick is skipped, too small to see
    }
  }
  return null;
}
```

The response has three parts: push the object out along the contact normal, reverse the part of the velocity that points into the surface (times `bounce`, 1 = perfect bounce), and keep the part along the surface (multiply it by a friction factor below 1 for sliding that slows down).

### Be generous to the player

- Make the player's hurt area smaller than its drawing, and pickups and the player's own attacks a little larger.
- Accept an action a moment after it stopped being strictly possible (a jump just after leaving a ledge, a catch just after the apple passed the rim), about 80–120 ms.
- Remember an input pressed a moment too early and apply it when it becomes possible.
- For a shot, decide what the player predicts: an instant shot hits along the aim line at once (the player aims), a travelling projectile moves each tick (the player leads the target); both are fair if the drawing matches.

### Example

Catch the falling apples: apples fall at 0.4 units/s and the tick is 33 ms, so an apple moves 0.013 per tick — less than its radius 0.03, no sub-steps needed.
The basket's catch area is 10% wider than its drawing, and an apple that touches the rim within 100 ms after passing it still counts.
