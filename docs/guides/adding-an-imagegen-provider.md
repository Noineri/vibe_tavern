# Adding a new image-generation backend

> Companion to the image-gen backend registry (`services/api/src/domain/imagegen/imagegen-registry.ts`, `imagegen-backend.ts`) and the capabilities table (`packages/domain/src/imagegen-capabilities.ts`).
> Battle-tested across the provider-expansion waves (23 → 29 backends, PE-1…PE-5): every step below is a surface those integrations actually touched.

The image-gen system mirrors the TTS / providers protocol-registry pattern: one `ImageGenBackend` implementation per `IMAGE_GEN_BACKENDS` slug, registered at module import, plus a small fan of static surfaces that must all learn the slug. Every cloud vendor is its own API shape — the work is always "write one adapter + teach five static tables". Local runtimes (ComfyUI, A1111) share the same contract but add connection discovery; this guide focuses on cloud vendors (for the local shape, read `backends/comfyui.ts` / `backends/a1111.ts` and their connection-panel web code).

## Non-negotiable rule: read THEIR current docs first

Before writing any code, re-verify the vendor's **current** API reference live and log the exact doc URLs in the plan's execution log. Cards in the research report (`vibe_tavern_plan/reports/IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH.md`) carry a doc-verified date — **stale cards get re-verified before the unit starts, never trusted**. Endpoint paths, auth headers, required fields and enum values drift (observed in the wild: Replicate's `GET /v1/models` went from public to 401; Luma's llms.txt went 404 while its sitemap `.md` twins stayed live; Novita pivoted its whole image catalog away from the SD surface). Useful sources, in order: the vendor's reference pages (Fern/Mintlify sites usually serve machine-readable `.md` twins — try appending `.md`, or their sitemap / `llms.txt`), their OpenAPI spec, then the official SDK as a cross-check (context7 usually indexes it). Where docs and SDK disagree, follow the endpoint reference page and note it.

Also probe the live no-key ladder (anonymous request → observed status + body) before writing the probe — that's the error shape your `probe()` will classify, pinned from reality, not the docs' ideal.

## Where things live (the surfaces)

```
packages/domain/src/entities.ts                        1. IMAGE_GEN_BACKENDS slug (the as-const registry of backend ids)
packages/domain/src/imagegen-capabilities.ts           2. IMAGE_GEN_BACKEND_CAPABILITIES entry (exhaustive Record — typecheck fails until both exist)
services/api/src/domain/imagegen/backends/<vendor>.ts  3. the adapter (generate / listModels / probe / dispose)
services/api/src/api/adapters/image-gen-adapter.ts     4. import the adapter module (registration side-effect)
packages/api-contracts/src/schemas/image-gen-schema.ts 5. imageGenBackendSchema z.enum (the wire union)
apps/web/src/provider-presets.ts                       6. preset row (id / label / backend / baseUrl / group)
services/api/test/imagegen-registry.test.ts            7. registry count pin (ALL_SLUGS length — bump it, it exists to force a conscious look)
services/api/test/imagegen-peN-providers.test.ts       8. the backend tests (per-wave file; start a new one per wave, not per vendor)
```

## Step 1 — Domain slug + capabilities

Add the slug to `IMAGE_GEN_BACKENDS` in `packages/domain/src/entities.ts`, then the entry to `IMAGE_GEN_BACKEND_CAPABILITIES` in `packages/domain/src/imagegen-capabilities.ts`. The Record is exhaustive — adding the slug without flags fails typecheck (lock-step prevention). The caps row is **wire truth with a comment** documenting the vendor surface (the bfl/novita rows are good examples): endpoint shapes, auth style, size dialect, the NSFW/cancel/list story, the verification date. Flags worth thinking about:

- `supportsSeed` / `supportsNegativePrompt` / `supportsSamplers` — off unless the wire actually accepts them. A seed-less vendor (Luma, Novita) must have `supportsSeed: false`; the UI hides the control and the adapter never builds the field.
- `sizeSupport` — `{kind: "free"}` (arbitrary W×H) vs the enum/object forms; if the vendor takes an aspect-ratio grid, the adapter maps internally (`mapLumaAspectRatio`, `mapReplicateAspectRatio` — exact match else nearest, exported and unit-pinned).
- `supportsLiveProgress` — only when the vendor exposes a real progress percentage; a queue position is NOT percent (the pill's cloud branch shows live text instead, PE-7b).
- `noApiKey` (true only for Horde-style anonymous access), `localExecution` (local runtimes exempt from the cloud timeout).

## Step 2 — The adapter

One file, `services/api/src/domain/imagegen/backends/<vendor>.ts`, exporting a factory `(config: ImageGenAdapterConfig) => ImageGenBackend` and calling `registerImageGenBackend(IMAGE_GEN_BACKENDS.<Vendor>, factory)` at module scope. Copy the closest template: async submit→poll→download arms (`bfl.ts`, `fal.ts`, `replicate.ts`, `luma.ts`, `novita.ts`), sync JSON arms (`google.ts`, `ideogram.ts`, `leonardo.ts`), raw-binary (`raw-binary.ts` family). Structure:

- **Module docstring = the API fact sheet** — every endpoint, header, body shape, enum and dialect (the `size` separator!), with the verification date and doc-URL trail. This is the artifact a future "why does it send X" lands on.
- **Config errors are synchronous** — parse endpoint/apiKey/model in the factory, throw a typed `<Vendor>ImageConfigError` on missing pieces. Saved profiles fail fast at `createImageGenBackend`, not mid-request.
- **Auth headers helper** — vendors differ (Bearer vs `Authorization: Key` vs `x-key`); build exactly what their reference shows, no guessing.
- **`generate()`** — assemble the request. **Params-unset discipline: a parameter the user left unspecified is NOT sent.** Documented defaults stand unsent (Luma's default-model wire body is exactly `{prompt}`); this keeps the vendor's defaults authoritative and requests minimal.
- **Async arms**: submit → `{task_id}`/`{request_id}` → poll loop → terminal state. Export the poll loop as a named seam (`pollNovitaTask`, `pollLumaGeneration`) taking an injectable `wait` — tests drive back-off and budget without real sleeps (hygiene forbids them). Cadence: 1 s initial, doubling, 5 s cap; total budget 150 s inside the 3-minute cloud timeout (`IMAGE_GENERATION_CLOUD_TIMEOUT_MS`).
- **Fail closed on unknown states** — an unrecognized status/enum value is a terminal error carrying the raw status text, never an infinite poll.
- **Downloads are server-side and immediate** — the response URL (CDN/presigned) is fetched by the backend and the bytes returned; `image_url_ttl: "0"` observed on Novita means TTL semantics are undocumented → download-always covers it. Presigned URLs need no auth header (keyless download); vendor-gated URLs carry the key (Replicate).
- **NSFW/canvas traps surface as typed errors** — fal's `has_nsfw_concepts`, Novita's dual channel (`extra.has_nsfw_contents` + per-image `nsfw_detection_result`) → a `<Vendor>ImageError` with the flag name; never silently show a checker-replaced file.
- **Cancel on failure** — best-effort DELETE/`cancel_url` cleanup on error paths where the vendor offers one (fal, Replicate, Horde); dashscope/luma/novita have none (verified, not assumed).
- **`listModels()`** — **owner rule: a static model catalog is FORBIDDEN whenever the provider has a list endpoint — wire it live.** Check llms.txt / sitemap / API index BEFORE concluding none exists (Horde `/v2/status/models`, fal `/v1/models` cursor-paginated, Replicate collections riding the profile key). Only a verified absence justifies a static list (Luma duo, Novita single) — say so in the caps-row comment with the verification trail.
- **`probe()`** — the cheapest discriminating call. The house pattern is invalid-post: send a request that can never succeed on validation (empty body), classify 401/403 → credentials rejected, any other 4xx → auth accepted (validation reached), 404 → endpoint wrong, 5xx → upstream down. Never throws for HTTP failures; only transport failures land in the catch. Pin the vendor's REAL no-key ladder in the tests.

No `as any` anywhere: type-guard the parsed JSON at every unknown boundary, throw typed errors with the upstream status.

## Step 3–4 — Registration + wire contract

Import the adapter in `services/api/src/api/adapters/image-gen-adapter.ts` (side-effect registration for every request path). Extend `imageGenBackendSchema`'s `z.enum` in `packages/api-contracts/src/schemas/image-gen-schema.ts` — the union rides profile CRUD and the settings wire.

## Step 5 — Web preset row

`apps/web/src/provider-presets.ts`: add the row `{ id, label, backend: IMAGE_GEN_BACKENDS.<Vendor>, baseUrl, group: PROVIDER_PRESET_GROUP.cloud }`. The label is the user-facing name (vendor + headline model). No new i18n keys for the row itself (labels are plain strings); if the vendor needs a UI hint beyond that, that's a conversation with the owner first.

## Step 6 — Tests

`services/api/test/imagegen-peN-providers.test.ts` (per-wave file; the wave's earlier vendors live there — extend it, don't spawn per-vendor files). House helpers at the top: `makeTransport` (scripted fetch), `sentJson` (decoded request body), `jsonResponse`, `PNG_BYTES`. Pin per vendor:

- the full happy-path wire sequence (submit URL/method/auth headers, exact body, poll URL, download) — for async arms the first poll already returns terminal so no real waits;
- params-unset: assert the ABSENT keys, not just the present ones (the Luma `{prompt}`-only pin);
- size/aspect mapping pins (exact + nearest + unset) via the exported mapper;
- the exported poll seam with injected `wait`: back-off cadence, total budget, fail-closed on unknown status;
- NSFW/canvas traps → typed errors (each channel);
- config errors synchronous (no endpoint / no key);
- probe classification from the live no-key ladder (rejected vs accepted vs wrong-path);
- the capabilities row (`supportsSeed` etc. — the wave's seed-less pins);
- registry wiring (`createImageGenBackend` returns the vendor; `imagegen-registry.test.ts`'s `ALL_SLUGS` length pin gets the bump).

## Gates + follow-through

`bun run typecheck` + the touched test files green before the commit; the full `services/api` suite + hygiene at wave close; on Windows remember the root `bun run test` SKIPS the web suite — run `bun run --cwd apps/web test` separately when web files changed. One commit per vendor with explicit paths. Execution-log entry in the plan with the verified doc URLs, drift notes, and the commit hash the same session. Deviations from the research card (endpoint gone, capability missing, auth changed) — stop and surface to the owner instead of improvising (the deviation rule); novelai was skipped on exactly that rule (dead endpoint since 04-2024).
