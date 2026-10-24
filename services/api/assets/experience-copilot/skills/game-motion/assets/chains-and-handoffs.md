# Exact actor handoffs and shared timing

Supporting file of `game-motion`. Read it when pieces move between assemblies in a chain, when several transfers overlap, or when a sequence duplicates, drops, or snaps a piece at a handoff.

## One visible owner per piece

Give each moving piece exactly one visible owner: source assembly before detachment, transit actor during movement, destination assembly after seating.
Detachment removes only that piece from the presentation assembly; keep its support and remaining pieces visible.
Capture the actual source pose at detachment, including any assembly turn that has already happened.
At seating, compute the receiving slot's current world pose, including current assembly rotation, scale, and cosmetic offsets, and make the actor meet that pose before changing owners.
Transfer ownership in one update so the seated piece neither duplicates nor disappears for a frame.
Compare position, angle modulo one turn, scale, and elevation immediately before and after each handoff, not only the final board after all actors have been cleared.

## Overlap by shared resources

Coordinate overlapping actions by their shared resources: unrelated assemblies can prepare in parallel, but two turns of the same assembly need one composed owner or an ordered handoff.
A fixed stagger is not proof of independence; the next action may detach a piece that has not yet arrived or overwrite a turn still in progress.
Resolve future start poses at the phase boundary, or derive them from a coherent planned timeline, rather than capturing every start from the board before the chain begins.
Capture a particle/ring/actor record directly in its update callback; indexing the last element of a mutable array can update another effect when effects overlap.

## Sparse frames

Make the scheduler correct when one display frame crosses several phase boundaries.
Apply ordered boundary changes chronologically, and establish a phase's endpoint before a dependent phase starts; iterating a tween list in reverse insertion order is not a causal schedule.
Choose catch-up or reconciliation after a long pause so removal, arrival, completion, and cleanup cannot execute in a contradictory order.
Include a sparse-frame trace that jumps from preparation to after seating, not only samples that happen to visit every phase.
