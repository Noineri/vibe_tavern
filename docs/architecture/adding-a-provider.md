# Adding a new AI provider

> Companion to [Backend Architecture → AI Execution Layer](./backend.md#ai-execution-layer).
> Read this before touching provider code — the registry design means most additions are 1–2 lines.

The provider system is **registry-driven**. There are two distinct kinds of "new provider", and they cost very different amounts of work. Pick your case first:

| Case | What it is | Example | Effort |
|------|-----------|---------|--------|
| **A. New vendor on an existing protocol** | Speaks an API shape we already support (almost always OpenAI-compat `/v1/chat/completions` + `/v1/models`) | A new aggregator, a new OpenAI-compat local server | **1–2 files, no new logic** |
| **B. New protocol** | A genuinely different native API shape | Vertex AI, a new native SDK | **4–6 files** |

> **Rule of thumb:** if the vendor documents an OpenAI-compatible endpoint, it is Case A. Only go to Case B if the request/response shape is fundamentally different from anything in `PROVIDER_TYPE`.

---

## Where things live (orientation)

```
packages/domain/src/
├── platform-constants.ts     PROVIDER_TYPE — the canonical protocol union
├── provider-support.ts       PRESET_TO_PROVIDER_TYPE — preset id → ProviderType
└── sampler-params.ts         SAMPLER_SETS, PRESET_SAMPLER_SET_MAP, resolveSamplerSet

services/api/src/
├── domain/providers/
│   ├── protocol-registry.ts  THE source of truth: one ProtocolAdapter per ProviderType
│   ├── vendor-registry.ts    aggregator-specific /models quirks (VendorAdapter)
│   ├── provider-orchestrator.ts  AUTH_REQUIRED_FOR_MODEL_LIST, model caching
│   ├── provider-gateway.ts   thin dispatch surface (probe/test/list)
│   └── provider-transport.ts shared HTTP helpers + types
└── infrastructure/ai/
    └── sampler-mapper.ts     buildSamplerConfig — per-protocol wire serialization

apps/web/src/
└── provider-presets.ts       UI preset metadata (label, baseUrl, group, auth flags)
```

The dependency direction is strict: `infrastructure/ai/` depends on `domain/providers/`, never the reverse.

---

## Case A — New vendor on an existing protocol

The overwhelmingly common case. The vendor speaks OpenAI-compat (or one of our other existing protocols). You are wiring a preset id to an existing `ProtocolAdapter`.

### Step 1 — Frontend preset metadata

Add an entry to `PROVIDER_PRESETS` in `apps/web/src/provider-presets.ts`:

```ts
{ id: "myvendor", label: "My Vendor", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.myvendor.com/v1", group: PROVIDER_PRESET_GROUP.cloud },
```

Field reference:
- `id` — the preset id. **Remember this exact string**; it is used verbatim in Step 2.
- `type` — an existing `PROVIDER_TYPE` value (`openaiCompat`, `anthropic`, `google`, …).
- `baseUrl` — default endpoint. For OpenAI-compat this must end at the `/v1` root.
- `group` — `cloud` | `native` | `local`. Local presets are hidden on ARM/Termux builds.
- `noApiKey` — true for local servers that ignore auth.
- `requiresAuthForModels` — true if `/models` returns 401 without a key (see Step 4).

### Step 2 — Domain preset → type map

Register the preset id in `PRESET_TO_PROVIDER_TYPE` (`packages/domain/src/provider-support.ts`):

```ts
myvendor: PROVIDER_TYPE.openaiCompat,
```

`normalizeProviderType("myvendor")` now resolves to `openaiCompat`. Probe / test-chat / model-list / generation all flow through the existing `openaiCompat` adapter. **This is the load-bearing line** — without it, the preset silently falls back to `openai_compat` anyway (the default), but being explicit keeps the map truthful and future-proof.

### Step 3 (optional) — Sampler set

If the vendor's sampler surface differs from the default `openai_compat_minimal`, map it in `PRESET_SAMPLER_SET_MAP` (`packages/domain/src/sampler-params.ts`):

```ts
myvendor: "openai_chat",   // reuse an existing set, or add a new SAMPLER_SETS entry
```

If you need a brand-new capability surface, add a `SAMPLER_SETS` entry (copy the closest existing one via the `set(...)` helper) and reference it here. Most vendors reuse `openai_chat`, `extended_cloud`, `aggregator`, or `openai_compat_minimal`.

### Step 4 (optional) — Auth-required model list

If the vendor's `/models` endpoint requires a key, add the preset to `AUTH_REQUIRED_FOR_MODEL_LIST` (`services/api/src/domain/providers/provider-orchestrator.ts`) **and** set `requiresAuthForModels: true` in the frontend entry (Step 1). This makes model-fetching fail-closed with a clear error instead of a 401.

### Step 5 (optional) — Vendor adapter

Only if the vendor's `/models` response is **not** standard `{ data: [...] }` OpenAI-compat shape. Add a `VendorAdapter` in `services/api/src/domain/providers/vendor-registry.ts` and register it in the `vendors` array:

```ts
const myVendorAdapter: VendorAdapter = {
  id: "myvendor",
  match: /api\.myvendor\.com/,
  extractRecords: (payload) => payload.myModelsField ?? [],  // non-standard envelope
  extractCapabilities: (record) => inferCapabilities(record), // reuse the vendor-agnostic helper
};
```

`resolveVendor(baseUrl)` matches first-wins, else `genericVendor`. Most vendors need **no** entry here.

### Done

Verify with `bun run typecheck` and `bun run test`, then smoke-test in the UI: Settings → Providers → add the preset, hit Test, fetch models, send a message.

---

## Case B — New protocol

Use this only when the API shape is fundamentally new (e.g. a vendor SDK with its own message format, or a native text-completion endpoint like KoboldCPP's `/api/v1/generate`). Example below assumes a new `vertex` protocol.

### Step 1 — Canonical type

Add to `PROVIDER_TYPE` in `packages/domain/src/platform-constants.ts`:

```ts
export const PROVIDER_TYPE = {
  // ...existing
  vertex: "vertex",
} as const;
```

`ProviderType` (the derived union) expands automatically. Note the key and value match (`vertex` / `"vertex"`).

### Step 2 — Preset → type map

Register preset id(s) in `PRESET_TO_PROVIDER_TYPE`:

```ts
[PROVIDER_TYPE.vertex]: PROVIDER_TYPE.vertex,
```

### Step 3 — ProtocolAdapter (the core)

Add a `ProtocolAdapter` object in `services/api/src/domain/providers/protocol-registry.ts` and register it in the `protocols` record. This is where all per-protocol knowledge lives:

```ts
const vertexProtocol: ProtocolAdapter = {
  id: PROVIDER_TYPE.vertex,
  capabilities: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    logitBias: false,
    samplers: SAMPLER_SETS.minimal_reasoning,   // Step 4
    textCompletion: false,                       // flip to true only for Novel Mode (§below)
  },
  resolveModel(profile, model) {
    // Build the Vercel AI SDK LanguageModel for this protocol.
    // Usually createXxx() from the matching @ai-sdk/* package.
    // See existing adapters (openaiCompatProtocol, googleProtocol) for patterns.
    throw new Error("TODO");
  },
  limitations: [
    "Describe any user-facing constraints, e.g. 'Tool calling not supported.'",
  ],
  probe: probeVertexConnection,       // your connectivity-probe fn
  testChat: testVertexChat,           // your minimal "Hi" generation fn
  listModels: listVertexModels,       // your /models fetch fn
};

// Register it:
const protocols: Record<ProviderType, ProtocolAdapter> = {
  // ...existing
  [PROVIDER_TYPE.vertex]: vertexProtocol,
};
```

The `probe` / `testChat` / `listModels` functions implement that protocol's HTTP shape. Copy the structure of the closest existing protocol's functions (e.g. `probeGoogleConnection` / `testGoogleChat` / `listGoogleModels`) and adapt endpoints, headers, auth, and response parsing. Shared helpers (`buildHeaders`, `tryParseUrl`, `wrapProviderNetworkError`, `extractChoiceContent`, the timeout constants) live in `provider-transport.ts` — reuse them, do not reinvent.

If the protocol has a **native (non-SDK)** text-completion shape like KoboldCPP or Ollama, create a dedicated adapter file (`domain/providers/vertex-adapter.ts`) exporting a `createVertexModel(...)` that returns a `LanguageModel`, and call it from `resolveModel`. See `ollama-adapter.ts` / `koboldcpp-adapter.ts` for the pattern.

### Step 4 — Sampler set

Pick or add a `SAMPLER_SETS` entry (`packages/domain/src/sampler-params.ts`) and reference it via `adapter.capabilities.samplers`. Then wire the type in `resolveSamplerSet`:

```ts
case PROVIDER_TYPE.vertex:
  return "minimal_reasoning";
```

### Step 5 — Sampler wire serialization

Add an arm to the `switch (providerType)` in `buildSamplerConfig` (`services/api/src/infrastructure/ai/sampler-mapper.ts`) **only if** the protocol's native parameter names differ from the AI SDK defaults. Native AI SDK params (`temperature`, `topP`, `topK`, `stopSequences`) need no arm. Vendor-specific params go under `providerOptions.<namespace>` (see the `openai_compat` / `ollama` / `koboldcpp` arms). The switch is intentionally kept here because wire *names* genuinely differ per protocol — this is not a registry candidate.

### Step 6 — Frontend preset metadata + label

Add the entry to `PROVIDER_PRESETS` (`apps/web/src/provider-presets.ts`) as in Case A Step 1, and add a label to `TYPE_LABELS`:

```ts
[PROVIDER_TYPE.vertex]: "Vertex AI",
```

### Done

Verify: `bun run typecheck` (the exhaustive `protocols` record makes TypeScript error if you added a `PROVIDER_TYPE` but forgot the adapter), `bun run test`, then UI smoke test.

---

## Capability flags reference

`ProviderCapabilityFlags` (defined in `protocol-registry.ts`) drives the UI and the executors. Set them truthfully — they gate real behaviour.

| Flag | Meaning | If true | If false |
|------|---------|---------|----------|
| `nonStreamGeneration` | Can produce a full non-streamed reply | Non-stream executor usable | Stream-only |
| `streaming` | Supports SSE | Stream executor usable | Non-stream only |
| `abortSignal` | Respects `AbortSignal` for cancel | Cancel button works mid-gen | Cancel only after gen |
| `prefill` | Supports assistant prefill (prefix content) | Prefill injected | Prefill ignored |
| `logitBias` | API-level token bias | Bias map sent | Bias UI disabled for type |
| `samplers` | `SamplerCapabilityFlags` — which sampler fields are offered | Drives the sampler UI + gating | `set()` empty |
| `textCompletion` | Can serve raw `/completions`-style flat prompt | Opt-in for Novel Mode (§below) | Chat-only |

> `isUnsupportedProvider(type)` returns true only when **both** `nonStreamGeneration` and `streaming` are false — the "no generation possible" state.

---

## Novel Mode & `textCompletion`

The `textCompletion` flag is present on every adapter (default `false` everywhere) and is the **only** switch needed to opt a protocol into Novel Mode's flat-prompt `/completions` assembler once that wiring lands (refactor plan §5.3.3). Do not flip it speculatively — it has no effect until Novel Mode's text-completion path is wired. When that lands, flipping the flag here is the entire change per protocol.

---

## Testing checklist

- [ ] `bun run typecheck` clean (catches a missing `protocols` entry — the record is exhaustive over `ProviderType`).
- [ ] `bun run test` passes.
- [ ] UI: preset appears under the right group (and is hidden on ARM if `local`).
- [ ] UI: **Test** button returns a reply (`testChat` path).
- [ ] UI: **Fetch models** returns a list (`listModels` path), or fails closed with the auth message if `requiresAuthForModels`.
- [ ] UI: send a real message; confirm streaming + sampler params behave per the capability flags.
- [ ] If you added a `VendorAdapter`: confirm non-standard `/models` shape parses (context length, capabilities if exposed).

---

## Common mistakes

- **Adding a `PROVIDER_TYPE` without a `protocols` entry** — TypeScript will error because the `protocols: Record<ProviderType, ProtocolAdapter>` is exhaustive. This is intentional; do not silence it.
- **Putting vendor HTTP logic in `provider-gateway.ts`** — the gateway is a thin delegator. Per-protocol HTTP belongs in the registry; vendor `/models` quirks belong in `vendor-registry.ts`.
- **Reinventing URL normalisation / headers / timeouts** — reuse `provider-transport.ts` helpers and the `PROBE_TIMEOUT_MS` / `MODEL_LIST_TIMEOUT_MS` / `TEST_CHAT_TIMEOUT_MS` constants.
- **Hardcoding a sampler surface in the UI** — sampler visibility is driven by `resolveSamplerCapabilities` → `SAMPLER_SETS`. Add the set, don't special-case the component.
- **Flipping `textCompletion` expecting Novel Mode to work** — it is a forward-looking flag; the text-completion request path is not wired yet (§5.3.3).
