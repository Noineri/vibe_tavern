# Rotating solids in a fixed camera

Supporting file of `game-visualization`. Use this method when a wedge, token, stack, or assembly must remain dimensional while turning, rather than when a flat graphic only needs a spin.

Define the object's geometry in a local plane, turn it there, then project it through one shared camera; material faces and attached details come from that same geometry.
For a simple elevated view, an orthographic construction is sufficient:
```text
theta = localAngle + assemblyAngle
screenX = centerX + radius * cos(theta)
screenY = centerY + squash * radius * sin(theta) - elevation
```
Angles in this formula are radians; `squash` is the shared plane's vertical-to-horizontal ratio, and `elevation` is screen-space height above it.
For a circular assembly with `N` equal slots, a wedge spans exactly `2*pi/N`; its top arc, both radial edges, bottom, material bands, and slot positions use those same endpoints.
Construct a side band by joining the projected boundary at two elevations, and a cut face by joining the center and rim at those elevations.
Place a surface detail at a local radius and angle on the top surface; it shares the piece's placement and turn rather than being independently stamped onto its support.
Project the support (a plate, a board, a tray) with the same plane ratio and give its margin separate geometry; scale the complete object uniformly for supply or board use.
Choose thickness and plane ratio as object proportions, not by squashing the entire already-painted object, which would also compress its vertical walls.

Derive visible faces and their drawing order from the current geometry and camera, with lighting tied to the shared light direction.
Treat angle visibility as periodic: the same pose at `theta`, `theta + 2*pi`, and `theta - 2*pi` must expose the same walls.
For arc clipping, split a wrapped angular interval or intersect shifted copies against the visible range; normalizing both endpoints independently can accidentally turn a short wedge into a reversed or nearly full-circle interval.
Keep an unwrapped angle for continuous motion and use periodic geometry for rendering.
Check one isolated piece, adjacent pieces, a missing sector, and the complete assembly at front, back, quarter-turn, and wrap-crossing poses before reproducing it across the scene.
These are geometry/source checks, not a claim that the construction has been visually inspected.
