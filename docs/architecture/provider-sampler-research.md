# Provider Sampler Support — Reference

How Vibe Tavern maps sampler settings onto local-LLM backends. Written from the implemented state (B1–B4 of the local samplers addition, 2026-09); the decision trail and live-probe evidence live in the planning repo (`vibe_tavern_plan/reports/LOCAL_SAMPLERS_ADDITION_REPORT.md`).

## Sampler sets

`packages/domain/src/sampler-params.ts` is the single source of truth. Every sampler field id belongs to one or more **sets**; a provider preset resolves to exactly one set, and only fields whose set matches can be rendered, stored, or emitted for that provider. Adding a field means touching the set membership here, the `satisfies Record<SamplerFieldId, …>` schema contracts in api-contracts (which force the rest of the pipeline to follow), and the per-protocol emission in `sampler-mapper.ts`.

| Set | Providers (presets) | Fields beyond the common core |
|---|---|---|
| `llamacpp_native` | llama.cpp server (`llamacpp`), Unsloth | `adaptiveTarget`, `adaptiveDecay` (adaptive-p), `dynatempRange`, `dynatempExponent`, `topNSigma`, `smoothingFactor`, `dryPenaltyLastN` |
| `openai_local` | LM Studio (`lmstudio`), vLLM, and the other local OpenAI-compatible presets | — |
| `koboldcpp_native` | KoboldCPP | `bannedStrings` (antislop), `drySequenceBreakers` |
| (cloud sets) | OpenAI/Anthropic/Google/etc. | cloud-native knobs only |

KoboldCPP native uses `/api/v1/generate` (text completion), so its samplers travel as native request fields, not provider options.

## Emission rules (sampler-mapper)

The mapper translates profile columns into provider options per protocol branch. The load-bearing conventions:

- **Omit-when-disabled.** A sampler at its off/default value is *omitted from the request*, never sent as an explicit zero/−1. Concretely: `top_n_sigma`/`smoothing_factor`/`dynatemp_range` are emitted only when > 0; `dynatemp_exponent` rides only an enabled range; adaptive-p fields only when `adaptiveTarget` ≥ 0.
- **`dry_penalty_last_n` tri-state.** DB default **−1 = disabled** (never emitted); stored **0 = a zero window**, which the mapper treats as not-a-real-window and also omits; **> 0 = a real window**, emitted. This mirrors llama.cpp's own −1 default while keeping the three states distinct at the storage level. The UI hint recommends a real window (e.g. 512) — the server 400s on −1 and a 0 makes DRY inert (live-probed).
- **The `samplers` chain (llama-server only).** On llama.cpp's `/v1/chat` endpoint, exotic samplers are accepted but *only applied* when listed in the `samplers` JSON array — and a provided array **replaces** the server's default chain, so VT always sends the full default order. Names are llama.cpp canonical sampler names (`adaptive_p`, not `adaptive`). The chain is emitted when adaptive-p is on **or** a chain-gated tail sampler is active (`top_n_sigma` > 0 or `dry_penalty_last_n` > 0); `adaptive_p` itself is listed last and only when adaptive-p is enabled. Dynatemp/smoothing are parameter modifiers of listed samplers and never force the chain on their own.
- **`banned_strings` (KoboldCPP native).** Exact-match phrases where **leading spaces are significant** (`" purr"` ≠ `"purr"`), emitted verbatim when non-empty, only in the koboldcpp branch. The upstream `banned_tokens` gibberish reports (issue #2333) concern a different mechanism and did not reproduce for `banned_strings`; the panel hint keeps the caution.

## UI notes

- Sampler fields render in `ProviderSamplerPanel` gated by the provider's set; hints state the off-semantics (e.g. the DRY window note above).
- List-valued samplers (stop sequences, DRY sequence breakers, banned strings) use the shared `ChipInput`, which renders leading/trailing spaces visibly and parses escape sequences. ChipInput also intercepts pastes that are JSON string arrays (SillyTavern lists like `[" finger", " moan"]`) and commits them as many chips — verbatim values, deduped.
- LM Studio is an OpenAI-compatible pass-through: its sampler extras ride the openai-compatible request body; no dedicated adapter exists. LM Studio ignores fields it does not know harmlessly.

## Live-probe provenance

The conventions above were probed live (llama-server b10786, KoboldCPP 1.120, LM Studio 0.4.23, shared Qwen2.5-0.5B Q4_K_M — 2026-09-03/09; rig at `N:/janitor_characters/tmp/llm-probe/`). Probe details and failure transcripts: see the samplers report in the planning repo. Not yet live-probed: the tail-only chain (chain emitted for `top_n_sigma`/DRY window without adaptive-p) and chainless dynatemp/smoothing application.
