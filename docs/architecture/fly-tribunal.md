# Fly Tribunal

> A local, precedent-learning swipe court for assistant message variants.

---

## What it is

Fly Tribunal is an optional browser-local feature that observes the user's confirmed message choices and surfaces learned verdicts about the shown assistant variant.
It starts silent and remains silent until it has recorded 25 confirmed precedents.
It has no innate repetition, slop, or quality detector.
A confidence score is derived only from learned KC-to-MBON weight deltas created by the user's own choices.
A fresh fly has zero learned deltas and therefore returns zero confidence by construction.
The connectome supplies a fixed simulation substrate and never supplies a product judgment.

The visual surface is the `FlyWidget` beside chat controls and the `FlyVerdictPanel` below an evaluated assistant variant.
`FlyTribunalModal` owns settings, cached-brain management, the precedent counter, and the CC-BY attribution line.
`fly-tribunal-store.ts` is a plain Zustand projection for the court state, transient animations, settings mirror, and variant verdicts.

## Where things live

| Piece | Location |
|---|---|
| Connectome builder and binary format | `scripts/build-fly-connectome.ts` |
| Shipped artifact and provenance | `services/api/assets/fly/connectome.bin.gz`, `services/api/assets/fly/fly-brain-manifest.json` |
| HTTP routes and adapter | `services/api/src/api/routes/fly-tribunal.ts`, `services/api/src/api/adapters/fly-tribunal-adapter.ts` |
| Wire schemas and limits | `packages/api-contracts/src/schemas/fly-tribunal-schema.ts` |
| Shared memory format version | `packages/domain/src/fly-tribunal.ts` |
| Cache-aware brain download | `apps/web/src/lib/fly/fly-brain-download.ts` |
| Worker factory and protocol | `apps/web/src/lib/fly/fly-worker-factory.ts`, `apps/web/src/lib/fly/fly-worker.ts` |
| Pure simulation and sparse-memory codec | `apps/web/src/lib/fly/fly-engine-core.ts` |
| Snapshot, learning, and persistence wiring | `apps/web/src/lib/fly/fly-tribunal-wiring.ts` |
| Verdict/action policy | `apps/web/src/lib/fly/fly-tribunal-policy.ts`, `apps/web/src/lib/fly/fly-tribunal-actions.ts` |
| UI state and surfaces | `apps/web/src/stores/fly-tribunal-store.ts`, `apps/web/src/components/chat/FlyWidget.tsx`, `apps/web/src/components/chat/FlyVerdictPanel.tsx`, `apps/web/src/components/modals/FlyTribunalModal.tsx` |

## Data lineage and shipped artifact

The artifact is built from the Male Adult Fly CNS (MCNS) v1.0 dataset under CC-BY 4.0.
The manifest attributes the source to Janelia Research Campus (HHMI), University of Cambridge, MRC Laboratory of Molecular Biology, and Google, accessed through Codex at Princeton Neuroscience Institute.
`build-fly-connectome.ts` reads the Codex static export pair `consolidated_cell_types` and `connections_princeton` through the compatible CSV input names.
It normalizes neuron groups, aggregates connection rows by pre/post pair across neuropils, signs neurotransmitter weights, emits a deterministic little-endian binary, gzip-compresses it, and writes the manifest beside it.

The shipped `connectome.bin.gz` is FTCB binary format version 1.
It contains 166,700 neurons and 6,242,118 aggregated edges.
Its compressed size is 27,500,977 bytes.
Its SHA-256 is `bdd7457ec7b8b1435a7ab4cbe70540b5a0ab0c11387201ce29a3e3b0fc8b860e`.
The manifest records the source, license, attribution, hash, counts, signed-synapse convention, group table, group counts, and cell-type table.

The builder assigns neurons to `OLF_OS`, `OLF_PN`, `OLF_LN`, `KC`, `MBON`, `DAN_PPL1`, `DAN_PAM`, `DAN_OTHER`, `GF`, or `OTHER`.
It preserves all connectome edges in the binary, but the runtime drops `OTHER` when it instantiates the learning subgraph.
The browser loader verifies the manifest hash before caching downloaded compressed bytes in the dedicated Cache API namespace.
It reads a cached, hash-verified artifact on later boots and never downloads a brain at message time.

## Simulation and evaluation

`fly-engine-core.ts` is pure and owns FTCB parsing, subgraph construction, the deterministic stimulus encoder, the burst simulation, learned confidence, and the sparse delta codec.
`fly-worker.ts` is a thin browser Worker shell that supplies `CompressionStream` and `DecompressionStream` and serializes the protocol.
The UI does not instantiate the engine directly.

The runtime retains olfactory input, projection neurons, local neurons, Kenyon cells, MBONs, all dopamine clusters, and giant-fiber neurons.
It uses the MCNS aggregate edge weights after graph normalization so the largest absolute edge is at most the reference synapse count before LIF scaling.
Text is lowercased and tokenized into contiguous one-, two-, and three-word Unicode n-grams.
A stable FNV-1a hash maps n-grams to 50 glomerular channels.
Repeated n-grams are square-root damped and the channel vector is max-normalized per message.

A bounded leaky-integrate-and-fire burst activates the olfactory inputs and propagates spikes through the retained subgraph.
The engine selects the highest-scoring positive Kenyon cells as a sparse code and reports registry-backed driving spans for the panel.
It also calculates MBON activity for evidence, but verdict confidence reads only positive learned KC-to-MBON deltas for the active sparse code.
There is no session repetition state, no habituation, and no continuous idle simulation.

## Learning and memory

The wiring observes read-only snapshot changes rather than changing canonical chat state.
A change of the active variant records the departed variant in a swipe chain.
When the next user message confirms that choice, every departed variant is trained as a PPL1 rejection and the kept variant is trained as a weak PAM positive in one confirmed batch.
A continuation without departed variants is an implicit PAM positive.
A saved edit of a non-terminal assistant message is a stronger PAM positive for the final saved text and settles that observation so the later continuation cannot double count it.
The pre-edit text is never a negative training example.
Latest-message streaming is not classified as an edit.
Training is disabled completely when `trainingEnabled` is false, while evaluation can continue.

| Confirmed event | DAN cluster | Strength | Effect |
|---|---:|---:|---|
| Continued kept variant | PAM | 0.25 | Weak implicit positive. |
| Departed swipe variant | PPL1 | 0.5 | Rejection evidence. |
| Saved edited assistant text | PAM | 0.75 | Strongest positive, three times the implicit keep. |

PPL1 adds strength to active KC-to-MBON deltas and PAM subtracts it.
The confidence readout treats positive deltas as learned rejection evidence, so the training signs are deliberately opposite the user-facing good/bad wording.
Each worker acknowledgement for a confirmed batch increments the precedent count once.
The common gate is `FLY_TRIBUNAL_PRECEDENT_GATE = 25`.

Only nonzero KC-to-MBON deltas persist.
The FTWD payload is little-endian `FTWD` magic followed by an entry count and repeated `(edgeIndex:u32, delta:f32)` pairs.
Import rejects the wrong magic, a malformed length, non-plastic edge indexes, and non-finite deltas.
The worker gzip-compresses the FTWD payload and base64-encodes it for `FlyMemoryPut`.
The wiring persists it with a 400 ms debounce to the selected per-chat or global memory scope.
`FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION = 2` is shared from `@vibe-tavern/domain` by the API, database, and worker.
Amnesty resets the worker weights, writes `precedentCount: 0` and `weights: null`, clears derived verdicts, and returns the court to silence.

Precedent lifetime applies approximate exponential decay to the summed delta field on memory load and persistence export.
The formula is `delta *= exp(-elapsedMs / (lifetimeDays * 86,400,000))`.
The shipped choices are 7, 14, or 30 days, while `null` represents infinity and leaves weights unchanged.
The payload has no per-event timestamps, so this is a whole-field approximation rather than independent per-precedent expiry.

## Action ladder

The court first requires 25 precedents and then applies the sensitivity bar to every learned confidence score.
The indication tier shows learned signals without requesting a regeneration.
The hint tier regenerates through the existing chat controller and passes a `steeringNote` made from the first hint template with `{detected}` replaced by up to three driving n-grams.
Manual user regenerations and swipes never receive that note.

The auto tier retains hint behavior, but it additionally requires its independent auto-swipe bar.
It refuses to act while the user has non-whitespace draft text.
It verifies that the evaluated target has not changed, that the regenerate call succeeded, and that a new variant actually landed before selecting it.
Attempts are counted per message and stop at the configured regeneration cap, after which the court enters its visible sleep state.
The modal allows only caps 1 through 3 and defaults to 2.

| Control | Values | Current policy |
|---|---|---|
| Sensitivity bar | soft 0.25, normal 0.50, strict 0.70 | Governs whether an active court flags a learned verdict. |
| Auto-swipe bar | normal 0.75, high 0.85, very-high 0.95 | Governs auto tier only. |
| Reaction tier | indication, hint, auto | Defaults to indication, and all tiers are gate-locked. |

The lowest auto bar is greater than the highest sensitivity bar by an asserted policy invariant.
This keeps indication liberal enough to explain a learned precedent while making automatic action more conservative.

## Tuning constants

The table contains the shipped named policy, engine, and wiring tuning constants.
Wire-format magic, format-version, and byte-size constants are intentionally documented in the data-lineage and memory sections rather than treated as runtime tuning.

| Constant | File | Current value | Effect |
|---|---|---:|---|
| `FLY_TRIBUNAL_PRECEDENT_GATE` | `fly-tribunal-schema.ts` | 25 | Confirmed precedents required before any text verdict. |
| `FLY_TRIBUNAL_REGEN_CAP_MIN` / `MAX` | `fly-tribunal-schema.ts` | 1 / 3 | Allowed per-message auto-regeneration cap range. |
| `FLY_HINT_TEMPLATE_MAX_LENGTH` | `fly-tribunal-schema.ts` | 300 | Maximum characters in one hint template. |
| `FLY_HINT_LIST_MAX` | `fly-tribunal-schema.ts` | 8 | Maximum stored hint templates. |
| `FLY_STEERING_NOTE_MAX_LENGTH` | `fly-tribunal-schema.ts` | 500 | Maximum regenerate steering note length. |
| `FLY_WEIGHTS_MAX_BASE64_LENGTH` | `fly-tribunal-schema.ts` | 512,000 | Maximum persisted base64 weight payload length. |
| `FLY_SYNAPSE_REFERENCE_COUNT` | `fly-engine-core.ts` | 30 | Largest normalized raw edge before LIF weight scaling. |
| `FLY_GLOMERULAR_CHANNEL_COUNT` | `fly-engine-core.ts` | 50 | Hashed n-gram stimulus channels. |
| `FLY_LIF_DEFAULTS.leak` | `fly-engine-core.ts` | 0.95 | Retained membrane potential per burst tick. |
| `FLY_LIF_DEFAULTS.threshold` | `fly-engine-core.ts` | 1 | Membrane potential required to spike. |
| `FLY_LIF_DEFAULTS.refractoryTicks` | `fly-engine-core.ts` | 3 | Silent ticks after a spike. |
| `FLY_LIF_DEFAULTS.weightScale` | `fly-engine-core.ts` | 0.15 | Scale applied to normalized synaptic weight. |
| `FLY_LIF_DEFAULTS.tickRateHz` | `fly-engine-core.ts` | 10 | Declared burst tick rate. |
| `FLY_LIF_DEFAULTS.burstTicks` | `fly-engine-core.ts` | 8 | Bounded LIF ticks per evaluation. |
| `FLY_LIF_DEFAULTS.kcSparsity` | `fly-engine-core.ts` | 0.10 | Fraction of positive Kenyon-cell candidates selected. |
| `FLY_LIF_DEFAULTS.maxDrivingSpans` | `fly-engine-core.ts` | 5 | Maximum evidence spans returned to the UI. |
| `FLY_LIF_DEFAULTS.learnedDeltaForFullConfidence` | `fly-engine-core.ts` | 1 | Per-active-synapse positive delta representing confidence 1. |
| `FLY_IMPLICIT_KEEP_STRENGTH` | `fly-tribunal-wiring.ts` | 0.25 | PAM strength for an implicit kept continuation. |
| `FLY_REJECTED_STRENGTH` | `fly-tribunal-wiring.ts` | 0.5 | PPL1 strength for each departed swipe variant. |
| `FLY_EDITED_SAVE_STRENGTH` | `fly-tribunal-wiring.ts` | 0.75 | PAM strength for saved edits. |
| `FLY_MEMORY_PERSIST_DEBOUNCE_MS` | `fly-tribunal-wiring.ts` | 400 ms | Delay before exporting and persisting learned deltas. |
| `FLY_SENSITIVITY_CONFIDENCE.soft` | `fly-tribunal-policy.ts` | 0.25 | Lowest verdict flagging threshold. |
| `FLY_SENSITIVITY_CONFIDENCE.normal` | `fly-tribunal-policy.ts` | 0.50 | Default verdict flagging threshold. |
| `FLY_SENSITIVITY_CONFIDENCE.strict` | `fly-tribunal-policy.ts` | 0.70 | Highest verdict flagging threshold. |
| `FLY_AUTO_SWIPE_CONFIDENCE.normal` | `fly-tribunal-policy.ts` | 0.75 | Lowest automatic-action threshold. |
| `FLY_AUTO_SWIPE_CONFIDENCE.high` | `fly-tribunal-policy.ts` | 0.85 | Default automatic-action threshold. |
| `FLY_AUTO_SWIPE_CONFIDENCE.very-high` | `fly-tribunal-policy.ts` | 0.95 | Highest automatic-action threshold. |

## License and attribution

MCNS v1.0 is licensed CC-BY 4.0.
The shipped artifact and the product surface that offers its download must retain attribution to Janelia Research Campus (HHMI), University of Cambridge, MRC Laboratory of Molecular Biology, and Google, with the MCNS v1.0 and CC-BY 4.0 identification.
`FlyTribunalModal` renders this attribution immediately below the brain download controls.
The complete provenance sentence remains in `fly-brain-manifest.json` and is served unchanged by `GET /api/fly/brain/manifest`.

## HTTP API

The four Fly Tribunal route groups are documented in [the API reference](./api-reference.md#fly-tribunal).
The route adapter validates every database projection through the canonical API schemas on both reads and writes.
The brain endpoints are read-only asset serving, while settings and memory use the runtime API seam.
