# Adding a new TTS provider

> Companion to the TTS backend registry (`services/api/src/domain/tts/tts-registry.ts`, `tts-backend.ts`) and the profile-editor variant specs (`apps/web/src/components/settings/provider/tts/tts-backend-ui.ts`).
> Pilot-proven on Cartesia (TPE-4): every step below is the exact surface that integration touched.

The TTS system mirrors the providers protocol-registry pattern: one `TtsBackend` implementation per `TTS_BACKEND` slug, registered at module import, plus a small fan of static surfaces that must all learn the slug. Unlike LLM providers there is no "Case A / Case B" split — every native TTS vendor is its own API shape, so the work is always "write one adapter + teach five static tables".

## Non-negotiable rule: read THEIR current docs first

Before writing any code, read the vendor's **current** API reference and log the exact doc URLs in the plan's execution log. Never trust priors, SDK blogs, or another integration's memory of the API — endpoint paths, auth headers, required fields and enum values drift. Where two sources disagree (docs page vs SDK default), follow the value documented on the endpoint reference page and note the disagreement in the log. Useful sources, in order: the vendor's docs (often with machine-readable `.md` mirrors — try appending `.md` to reference URLs), their OpenAPI spec, then the official SDK as a cross-check (context7 usually indexes it). Cartesia example: reference pages documented `Cartesia-Version: 2026-03-01` as the only enum value while the JS SDK defaulted a newer date — raw-fetch code follows the documented value.

## Where things live (the six surfaces)

```
packages/domain/src/entities.ts                          1. TTS_BACKEND slug + TTS_BACKEND_CAPABILITIES entry (exhaustive Record — typecheck fails until both exist)
services/api/src/domain/tts/backends/<vendor>-tts.ts     2. the adapter (generate / listVoices / listModels? / probe / cloneVoice? / capabilities)
services/api/src/api/adapters/tts-adapter.ts             3. import the adapter module (registration side-effect)
packages/api-contracts/src/schemas/tts-schema.ts         4. ttsBackendSchema z.enum (the wire union)
apps/web/src/lib/tts/tts-presets.ts                      5. preset entry + TtsBackend union type
apps/web/src/components/settings/provider/tts/tts-backend-ui.ts
                                                         6. UI variant: SPECS entry + ttsUiVariantOf + backendForVariant + ttsProviderSegmentOf
```

Plus, when the editor needs new labels: `apps/web/src/i18n/locales/{en,ru}.json` (then `bunx i18next-cli types` from `apps/web/` to regenerate `resources.d.ts` — the UI spec's `TtsI18nKey` compiles against it).

## Step 1 — Domain slug + capabilities

Add the slug to `TTS_BACKEND` and an entry to `TTS_BACKEND_CAPABILITIES` in `packages/domain/src/entities.ts`. The Record is exhaustive, so adding the slug without flags fails typecheck — the same lock-step prevention as the providers registry. Flags worth thinking about:

- `supportsCloning` — gates the profile-editor clone section (TPE-3 infra). Static for native vendors: either their clone endpoint exists or it doesn't.
- `supportsVoiceList` / `listModels` — most vendors have a voices endpoint; a models *endpoint* is rarer (Cartesia has none — serve a static documented catalog from `listModels()` instead, the F8 "documented" philosophy).
- `requiresApiKey`, `transport`, `supportsStreaming` (describe **our** transport — if `generate()` buffers the response, it's `false`), `supportsSpeed`.

The adapter's own `capabilities()` (runtime object) is separate: it carries the clone hints (`formats`, `maxSizeMb`) that drive client-side sample validation, and for openai-compat servers is *learned* rather than static. Native vendors return a static object.

## Step 2 — The adapter

One file, `services/api/src/domain/tts/backends/<vendor>-tts.ts`. Structure (copy `cartesia-tts.ts` or `elevenlabs-tts.ts` as the closest template):

- **Module docstring = the API fact sheet.** Every endpoint, header, body shape and enum the adapter relies on, with the verification date and the doc URL trail in the plan log. This is the artifact a future "why does it send X" question lands on.
- **Config accessors.** `TtsProfileConfig` is `Record<string, unknown>`; parse it once in the constructor with `readString`/`readNumber` helpers, clamping anything range-bound so a hand-edited profile can never send out-of-contract values (Cartesia speed → [0.6, 1.5]).
- **Auth headers helper + `expectOk`** with an error-body excerpt (first ~200 chars) — upstream error text is the single most useful thing in a failing preview.
- **`generate()`** — the synthesis call. Return `{ audio: Buffer, mime }`; take `voiceId` from the request, own the tuning knobs from the profile config (same contract choice as ElevenLabs: `req.speed` is a transient playback hint, the config value wins).
- **`listVoices()`** — follow pagination if the vendor paginates, with a hard page cap so a pathological cursor loop can't hang the editor. Map to `TtsVoiceInfo { id, label, lang }`; label convention is `name · <discriminator>` pieces joined with `·`, with a marker for org-owned voices so clones stand out (`· mine`).
- **`probe()`** — the cheapest authenticated call (a `limit=1` list, a key-info endpoint), returning `{ ok, detail }` without throwing for HTTP failures (only transport failures land in the catch).
- **`cloneVoice?()`** — only when the vendor supports it; callers gate on `capabilities().supportsCloning` before calling. Build the multipart exactly as documented (Cartesia: `clip` file + `name` + REQUIRED `language` + `access[type]`); derive a supported filename from the mime type when the vendor's format list is extension-keyed.
- **Registry wiring at module scope** — `registerTtsBackend(TTS_BACKEND.<Vendor>, factory)`. Importing the module is the registration.

Guards for the unknown-JSON boundary: type-guard functions + thrown `<Vendor>TtsError` with the upstream status. No `as any` — narrow with `typeof` checks and filter malformed entries.

## Step 3–4 — Registration + wire contract

Import the adapter in `services/api/src/api/adapters/tts-adapter.ts` (side-effect registration for every request path — saved profiles, draft voices/models, preview, clone). Extend `ttsBackendSchema`'s `z.enum` in `packages/api-contracts/src/schemas/tts-schema.ts` — the wire union rides every draft route body and the profile CRUD.

## Step 5 — Web preset

`apps/web/src/lib/tts/tts-presets.ts`: extend the local `TtsBackend` union and add the preset entry (`id`, `label`, `group: "cloud"`, `backend`, `modelFilter`). Native vendors use `modelFilter: "none"` — model discovery goes through the backend's `listModels()`, not the openai-compat filter machinery. If the preset list test pins the entry count, bump the pin (it exists to force a conscious look).

## Step 6 — UI variant

`apps/web/src/components/settings/provider/tts/tts-backend-ui.ts`: add the variant to `TtsUiVariant`, a `SPECS` entry (connection fields — apiKey placeholder, model mode; tuning fields), and the three mappers (`ttsUiVariantOf`, `backendForVariant`, `ttsProviderSegmentOf` — native backends are always `"cloud"`). The editor renders the whole form from the spec; the clone section appears automatically from capabilities. Then `TtsProfileEditor.tsx`'s `handleApplyPreset` needs a branch mapping the preset's backend string to the domain slug. The model picker's `fetch` mode resolves through the draft models route → your `listModels()`; `input` mode is a plain text field for vendors with free-form model ids (ElevenLabs).

## Tests

- **Backend**: `services/api/test/tts-backend-<vendor>.test.ts` — mock `globalThis.fetch` (snapshot the original BEFORE installing the mock — house pattern, see the elevenlabs test), then pin: request URL/method/headers, the exact body shape, per-knob gating (e.g. Cartesia's `generation_config` is sonic-3-family only — assert the key is absent on older models even when configured), clamping, pagination walks (including the page cap), parse guards, the clone multipart field-for-field (filename derivation, required defaults), error excerpts, capabilities, and the registry wiring.
- **UI**: extend `tts-backend-ui.test.ts` (variant mapping, spec fields, the D20 no-placeholder loop gains the variant) and `tts-presets.test.ts` (count pin).

## Gates + follow-through

`bun run typecheck` + `bun run test` from the repo root, `bunx i18next-cli types` + the i18n check if you added strings, one commit, execution-log entry in the plan with the doc URLs you verified against. Deviations from the plan's research assumptions (endpoint gone, capability missing) — stop and surface to the owner instead of improvising (the deviation rule).
