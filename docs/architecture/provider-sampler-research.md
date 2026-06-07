# Provider Sampler Capabilities Research

> Researched 2026-06-07 via Gemini web search + Context7.
> All 18 providers verified against official API docs.

---

## Matrix (grouped by capability profile)

Legend: ✅ documented and supported, ❌ not documented/not supported

### Group A — Cloud Aggregators (near-full sampler surface)
temp, topP, topK, topA, minP, freqPen, presPen, repPen, seed, stop, logitBias + reasoningEffort + advanced (mirostat, tfs, typicalP)

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **OpenRouter** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | reasoning_effort: none/minimal/low/medium/high/xhigh |
| **NanoGPT** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Also: mirostat, typicalP, tfs. reasoning_effort passthrough. Sub endpoint identical. |

### Group B — Local / vLLM-based (full sampler surface)
temp, topP, topK, minP, freqPen, presPen, repPen, seed, stop, logitBias + DRY/XTC/mirostat

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **Chutes** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | vLLM-based, full vLLM surface |
| **vLLM** (local) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | reasoning_effort for models with reasoning parsers |
| **Ollama** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | No effort param. Uses <think> tags in output |
| **llama.cpp** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | Full local sampler surface including DRY/XTC |

### Group C — Google / ZAI (minimal samplers, but support reasoning control)

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **Google AI Studio** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | Native: `thinking_level`. OpenAI-compat accepts `reasoning_effort` |
| **ZAI (Zhipu)** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | `reasoning_effort` for GLM-5/4.7. Also `thinking` and `disable_reasoning` |
| **AI21** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | Only temp, topP, stop native. reasoning_effort via OpenRouter/Bedrock |

### Group D — OpenAI-standard cloud (temp, topP, freqPen, presPen, seed, stop)

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **OpenAI** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | Source of truth. reasoning_effort: none/minimal/low/medium/high/xhigh |
| **xAI (Grok)** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | reasoning_effort: none/low/medium/high. Default low |
| **Mistral** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | reasoning_effort: none/high. Seed = `random_seed` |

### Group E — OpenAI-standard cloud, NO seed

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **DeepSeek** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | Uses `thinking.type: enabled` + reasoning_effort for V4-pro/V4-flash |
| **MiMO (Xiaomi)** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | `thinking.type` toggle. Thinking mode forces temp=1.0/topP=0.95 |

### Group F — Extended cloud (topK + repPen + logitBias)

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **Fireworks** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | reasoning_effort for reasoning models (R1, o1-mini, etc.) |
| **Together AI** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | reasoning_effort + `reasoning.enabled` toggle |
| **SiliconFlow** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Also `enable_thinking` (bool) + `thinking_budget` |
| **Moonshot** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | `thinking.type` native; reasoning_effort via OpenAI-compat route |

### Group G


| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **Perplexity** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | reasoning_effort for sonar-deep-research/reasoning-pro |
| **ElectronHub** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | topK + reasoningEffort. No seed/stop/repPen/logitBias |

### Outliers (unique combos)

| Provider | temp | topP | topK | topA | minP | freqPen | presPen | repPen | seed | stop | logitBias | reasoningEffort | Notes |
|----------|:----:|:----:|:----:|:----:|:----:|:-------:|:-------:|:------:|:----:|:----:|:---------:|:---------------:|-------|
| **Anthropic** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | Native: `output_config.effort` + `thinking.budget_tokens` |
| **KoboldCPP** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | Full local surface incl. topA, DRY/XTC |
| **Pollinations** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | reasoning_effort passthrough. Also has `safe` param |
| **Groq** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | No penalties. Has seed + reasoningEffort |

## Fallback

Unknown/custom OpenAI-compatible providers get **openai_compat_minimal**:
temperature, topP, frequencyPenalty, presencePenalty, stopSequences, seed, logitBias

This matches the most common OpenAI-compatible subset shared by the majority of providers.

## Research Confidence

| Provider | Researched? | Method | Notes |
|----------|:-----------:|--------|-------|
| **OpenAI** | ✅ | Context7 | Full API spec retrieved |
| **OpenRouter** | ✅ | Context7 + Gemini | Confirmed full aggregator surface |
| **DeepSeek** | ✅ | Gemini | Only temp, topP, freqPen, presPen, stop; no seed, no logitBias |
| **Groq** | ✅ | Gemini | freqPen/presPen/logitBias "not yet supported", seed beta, reasoningEffort |
| **xAI** | ✅ | Gemini | OpenAI subset, no logitBias |
| **Mistral** | ✅ | Gemini | temp, topP, freqPen, presPen, random_seed, stop; no topK/logitBias |
| **Fireworks** | ✅ | Gemini | Full surface: topK, repPen, logitBias |
| **Together AI** | ✅ | Gemini | Full surface: topK, repPen, logitBias |
| **Perplexity** | ✅ | Gemini | temp, topP, topK, freqPen, presPen; no seed/stop/logitBias |
| **SiliconFlow** | ✅ | Gemini | Full surface: topK, repPen, logitBias |
| **ZAI (Zhipu)** | ✅ | Gemini | Only temp, topP, stop; no penalties, no seed |
| **Moonshot** | ✅ | Gemini | topK + repPen for K2.5/K2.6, freqPen/presPen fixed to 0.0 on new models, seed documented |
| **AI21** | ✅ | Gemini | Only temp, topP, stop on native Studio API. freqPen/presPen only via Bedrock |
| **NanoGPT** | ✅ | Gemini | Near-full surface including mirostat, typicalP, tfs, topA, minP. Passes through to upstream |
| **Chutes** | ✅ | Gemini | Built on vLLM; full vLLM sampler surface incl. topK, minP, repPen, logitBias |
| **ElectronHub** | ✅ | Gemini | topK confirmed, reasoningEffort. No repPen/seed/stop/logitBias in docs |
| **MiMO (Xiaomi)** | ✅ | Gemini | Only temp, topP, freqPen, presPen, stop. Thinking mode restricts temp/topP |
| **Pollinations** | ✅ | Gemini | OpenAI-compatible: temp, topP, freqPen, presPen, seed, stop, logitBias, repPen |

## Sources

- **OpenAI**: Context7 `/websites/developers_openai_api_reference` — full chat completions API spec
- **OpenRouter**: Context7 `/llmstxt/openrouter_ai_llms-full_txt` — confirmed all sampler params
- **DeepSeek**: Gemini web search — official DeepSeek API docs
- **Groq**: Gemini web search — official docs say freqPen/presPen/logitBias "not yet supported"
- **xAI**: Gemini web search — OpenAI-compatible subset, no logitBias
- **Mistral**: Gemini web search — temp, topP, freqPen, presPen, random_seed, stop
- **Fireworks**: Gemini web search — full sampler surface
- **Together AI**: Gemini web search — full sampler surface
- **Perplexity**: Gemini web search — no seed, no stop, no logitBias; has topK
- **SiliconFlow**: Gemini web search — full sampler surface
- **ZAI (Zhipu)**: Gemini web search — only temp, topP, stop
- **Moonshot**: Gemini web search — topK + repPen for K2.5/K2.6, seed documented, freqPen/presPen fixed to 0.0 on newest models
- **AI21**: Gemini web search — only temp, topP, stop on native Studio API (freqPen/presPen only via Bedrock)
- **NanoGPT**: Gemini web search — near-full sampler surface (mirostat, typicalP, tfs, topA, minP, logitBias, seed, stop, all penalties)
- **Chutes**: Gemini web search — vLLM-based, full vLLM sampler surface
- **ElectronHub**: Gemini web search — topK confirmed, reasoningEffort, limited other params
- **MiMO (Xiaomi)**: Gemini web search — only temp, topP, freqPen, presPen, stop
- **Pollinations**: Gemini web search — OpenAI-compatible subset plus repPen

## TODO

- [ ] Research Vertex AI sampler surface (not yet a provider preset)
- [ ] Verify DeepSeek — some reports suggest seed may now work
- [ ] Verify ElectronHub — may support more params via vLLM passthrough (undocumented)
