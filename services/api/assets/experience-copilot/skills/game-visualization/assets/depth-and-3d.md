# Depth and 3D in CSS

Supporting file of `game-visualization`. Read it when an object must tilt, flip, or show thickness from more than one side.

## Choose 2.5D first

Most cards, counters, board rims, plates and buttons look solid with 2.5D: a face, a drawn edge (stacked zero-blur shadows or a second element), a contact shadow, and one highlight, all following the declared light.
Use real 3D only when the object actually turns and the player should see its sides change.

## Real 3D with CSS transforms

1. Put `perspective` (for example `perspective: 900px`) on one scene wrapper shared by related objects, so they tilt from the same viewpoint.
2. Put `transform-style: preserve-3d` on every container between the wrapper and the faces.
3. Position each face with `rotateX` / `rotateY` and `translateZ`; a card has a front and a back, a die has six faces, a thick tile has a top and four sides.
4. Add `backface-visibility: hidden` to faces whose reverse should not show through.

```css
.scene { perspective: 900px; }
.card { position: relative; width: 70px; height: 100px; transform-style: preserve-3d; transition: transform .4s ease-in-out; }
.card.is-flipped { transform: rotateY(180deg); }
.card .face { position: absolute; inset: 0; border-radius: 8px; backface-visibility: hidden; }
.card .back { transform: rotateY(180deg); }
```

Effects that flatten 3D: `overflow: hidden`, `opacity` below 1, `filter`, `clip-path` and `mask` on a `preserve-3d` container turn its children flat.
Put those on an outer wrapper or on a single face instead.

Keep each transform role on its own wrapper: one element for the position in the fan or on the board, one inside it for the flip, one for hover.
Then a hover rule cannot erase the card's rotation in the fan.

Keep text-bearing controls in a flat, readable plane, and keep the clickable area where the player sees the object.

## Check the whole object's bounds

- A clip on the top face clips only that face; the sides, the toppings and the shadow sit outside it on their own elements.
- Give a reusable object an explicit size or `aspect-ratio` in every place it appears; `height: 100%` needs a parent with a definite height.
- Add up the full footprint — top, lower edge, raised details, selection ring — and check it fits the cell or slot.
- Hiding a wrapper hides everything inside it; to remove only the wrapper's decoration, change the decoration, not the wrapper's visibility.
- In canvas, wrap each object's drawing in `ctx.save()` / `ctx.restore()` so its alpha, clip and transform do not leak into the next object.
