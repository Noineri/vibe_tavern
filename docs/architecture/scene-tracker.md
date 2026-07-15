# Scene Tracker

The Scene Tracker is a **target-scoped background-LLM feature** (the Case B variant of [adding-a-feature.md](../guides/adding-a-feature.md)): it persists a structured per-turn state record on the **immutable assistant message variant** (`message_variants.scene_tracker_json`), keyed by `{ chatId, branchId, messageId, variantId }`, and injects that state as a prompt layer for future generations. This document covers the **frontend contract + authoring surface**: the schema DSL the user writes, the config that drives generation, the JSON/XML injection formats, AI-assisted schema authoring, the shared state renderer, and the header-zone visibility rules. The backend lifecycle (job coordination, stale revalidation, backfill run rows, the `tracker-service`) lives in [backend.md](backend.md) and the Case B write-up in [adding-a-feature.md](../guides/adding-a-feature.md).

---

## The Scene schema DSL

The schema is a **canonical JSON DSL** authored by the user in Build → Insights → Tracker (the `TrackerConfig` editor). It describes the *shape* of a Scene record; the LLM fills in matching `data`, and the renderer walks the schema to display it. The schema is a discriminated union on `$type`:

- **`string`** — `{ "$type": "string", "label"?: string }`
- **`boolean`** — `{ "$type": "boolean", "label"?: string }`
- **`number`** — `{ "$type": "number", "min"?: number, "max"?: number, "label"?: string }`. `min`/`max` are both-or-neither and `min <= max`; when both are present the renderer draws a bounded meter.
- **`object`** — `{ "$type": "object", "properties": { "<key>": <node>, ... }, "label"?: string }`. Per-object key cap enforced.
- **`array`** — `{ "$type": "array", "items": <node>, "label"?: string }`. `items` is a single node (the element type); recursion renders each element.

Keys are validated as non-empty strings that are not reserved/unsafe path segments (including `__proto__`, which Zod's record reconstruction would otherwise silently drop via the prototype setter). The canonical type is `SceneTrackerDsl` / `SceneTrackerSchemaNode` in `packages/domain`; the Zod contract is `sceneTrackerDslSchema` / `sceneTrackerNodeSchema` in `packages/api-contracts`.

`label` is **presentation-only**: it overrides the key as the human label in the renderer and editor, but is stripped from the identity hash, stripped from the model prompt, and never appears in serialized `data`. Adding or changing a `label` does not invalidate existing records. The schema's identity is its `schemaHash` (a stable hash of the label-stripped structure) plus a config `revision`; a record is *fresh* when its stored `schemaHash`/`revision` match the live config, and *stale* (drift) otherwise.

### Canonical example

```json
{
  "$type": "object",
  "properties": {
    "location": { "$type": "string" },
    "tension": { "$type": "number", "min": 0, "max": 10, "label": "Tension" },
    "characters": {
      "$type": "array",
      "items": {
        "$type": "object",
        "properties": {
          "name": { "$type": "string" },
          "present": { "$type": "boolean" }
        }
      }
    }
  }
}
```

---

## Config: auto mode + prompt format

Tracker config (`chat.insightsConfig.tracker` + the `trackerEnabled` toggle, isolated from the Objective feature's config keys) drives generation:

- **`autoMode`** — `assistant` (default; generate a Scene after each assistant turn) or `manual` (the user drives generation from the header zone / backfill).
- **`promptFormat`** — `json` (default) or `xml`. Determines how Scene history is injected into the prompt and constrains the key naming the AI schema-generator emits (see below). Stored on the config and threaded through the assembly pipeline.

Build → Insights emits feature-scoped patches; the draft's `schemaHash` is recomputed on every schema edit (in `TrackerConfig.onSchemaChange`) so a draft is always self-consistent — this is what lets the instant Preview trial unsaved drafts without hitting the server's hash-mismatch guard.

---

## Prompt injection: JSON vs XML

Scene history is injected as a prompt layer by `packages/prompt-pipeline` (`scene-injection.ts`), formatted according to `promptFormat`:

- **`json`** — the records are emitted as structured JSON. Any non-empty, non-reserved string is a valid key.
- **`xml`** — the records are emitted as a `<scene_history>` block of `<scene>` elements, one per turn. `sceneToXml` recurses: primitives become `<key>value</key>`, objects become `<key><child>…</child></key>`, arrays become `<key><item>…</item></key>` (one `<item>` per element, recursed). All text is `escapeXml`-escaped.

Because XML element names must be ASCII-safe tag names, **XML key validity is enforced at three layers** (the format only constrains *keys*, never the JSON DSL shape itself): the Zod contract (`superRefine` on the schema when `promptFormat === "xml"`), the backend adapter (a merged-config gate before generation), and the client editor (a live gate that blocks Save while invalid XML keys are present). The JSON format imposes no key restriction beyond the shared reserved-segment rule. `formatSceneHistory` is the single entry point; it dispatches on the format and is what the assembly layer calls.

---

## AI-assisted schema generation

The schema editor has a "Generate with AI" affordance (`AiAssistantModal` in `scene_schema` mode). It is **format-aware (Option A)**: the schema is *always* canonical JSON DSL regardless of `promptFormat`; the format only constrains the *key naming* the model emits. Two prompt assets back this:

- `scene-schema-json.md` — the model may use any readable key names.
- `scene-schema-xml.md` — the model is told to emit ASCII-safe tag-name keys (matching the XML validation layers above).

The active preset override (if any) is format-agnostic and wins for both. The modal is opened with `existingContent` set to the current draft schema (so the model can iterate rather than start blind) and `scopeContext` drawn from the active character/persona via VT's existing context links. The `promptFormat` is threaded end-to-end (`AiAssistantStreamRequest` → `resolveSystemPrompt` → `buildUserMessage`) so the backend picks the right asset.

**Apply safety:** the model's output has its ` ```json ` fences stripped and is delegated to the existing `onSchemaChange` path — the same parse→validate→setDraft path manual typing uses. Valid output replaces the draft and marks it dirty; invalid output lands verbatim in the editor with a parse error and leaves Save blocked. The model can never corrupt a valid draft.

---

## Frontend rendering — `SceneStateView`

`SceneStateView` (`apps/web/src/components/shared/SceneStateView.tsx`) is the schema-aware state renderer shared by the chat header (Scene zone) and the config Preview. It takes the user-authored `schema` and the matching `data`, walks the schema, and renders each value at the right type — it never parses or mutates `data`. Two variants share one recursive core:

- **`"rich"`** (default) — bounded numbers render as an a11y `<meter>` (a neutral bar; the numeric value + explicit range live in the ARIA attributes), unbounded numbers/strings/booleans render inline, and objects/arrays render as an indented `border-l` tree.
- **`"compact"`** — a dense key/value text layout (no bar; the explicit range is shown inline since there is no bar to convey it).

Recursion is schema-guided at every level, so an array-of-objects renders the object's properties for each element. The `stale` prop dims the whole view (`opacity-50`) — used by the header to mark a drifted record.

The variant is a **persisted UI preference** in `scene-render-store.ts` (single source of truth): selecting Graphical/Compact in the Preview re-renders the header too, and the choice survives reloads (manual `localStorage` pattern, the repo convention for persisted UI state). An **instant Preview** (`synthesizeSceneSample`, free, no LLM call) lets the user trial the current draft schema + render variant immediately; a separate **Test generation** button triggers a real Scene generation call to validate the schema against actual model output.

---

## Header zones and the mixed-state matrix

Two message-slot zones render insight state in the assistant header, registered via the message-slot registry. They have **different scoping contracts**, which is the crux of the mixed-state matrix:

- **Scene zone** (`message-slots/scene-zone.tsx`, `assistant_header_zone` order 2) — **focused latest-header control**. Only the *latest* assistant message mounts the active controls; older assistant messages mount at most a read-only view of their current valid record.
- **Objective zone** (`message-slots/objective-zone.tsx`) — **chat-global live view**. Every mounted assistant header reads the same current Objective route from `activeChat.insightsObjectiveState`, so a route edit or completion check updates all Objective headers at once. It is not latest-focused.

### Scene zone visibility matrix

| Tracker | Message | Record state | Scene zone renders |
|---|---|---|---|
| off | any | — | nothing (zero DOM) |
| on | latest | no record | **Generate Scene** |
| on | latest | stale (drift) | **Update Scene** + permanent Edit / Delete |
| on | latest | fresh | read view + permanent Update / Edit / Delete |
| on | older | fresh valid record | read-only view of that record |
| on | older | no record / stale | nothing (filled via backfill) |

The visibility decision is a single primitive snapshot string — `${trackerEnabled}:${isLatest}:${variantId}:${fresh}` — so the host re-resolves only when one of those facts changes, not on every snapshot tick. After valid data exists the header permanently retains the accessible Update / Edit / Delete controls (Delete is kept for consistency with the Objective header design; turning the tracker off does not erase history until a record is deliberately removed). `Edit Scene` opens a shared desktop `Modal` / mobile `BottomSheet` structured-value editor that validates schema paths, reserved segments, ranges, array bounds, and ownership/config revision before atomic persistence — it does not expand a recursive editor inside the compact header.

### Edit lock + generation coordination

While the selected variant is known to be generating a Scene, `MessageBlock` / `MessageShell` disable that variant's edit action with an accessible "Scene is being updated" explanation; edit activation performs a target-status preflight so another tab cannot bypass the lock. Explicit Cancel re-enables editing; switching variants is unaffected; deleting the generating variant coordinates/cancels its Scene job first. This coordination is best-effort UX — the server-side source-hash / config-revision / ownership revalidation after the LLM await is the correctness backstop and is present unconditionally.

### Scene History Backfill

Build → Insights → Tracker → History (`SceneHistoryBackfill.tsx`, mounted in `TrackerConfig`) drives the server-authoritative backfill run across existing messages. The idle form shows a bounded call count (assistant messages in the active branch) plus a conditional monetary estimate (only when the resolved model carries `pricing.output`). While running it polls typed status (progress/total + current target + Cancel); on a terminal transition it refreshes the snapshot so generated records land in the header zones. The active `runId` persists to `localStorage` keyed by chat (same-client reload reattaches); a server restart is resume-safe via the status poll. The run never blocks ordinary chat — it is fire-and-forget server-side; the client only drives start/status/cancel/retry.

---

## Pointers

- Backend lifecycle, job coordination, stale revalidation — [backend.md](backend.md) + Case B in [adding-a-feature.md](../guides/adding-a-feature.md).
- Prompt assembly + the Scene injection layer — [prompt-pipeline.md](prompt-pipeline.md).
- API routes + contracts — [api-reference.md](api-reference.md).
- Domain types — `packages/domain/src/scene-tracker-constants.ts` (`SCENE_AUTO_MODE`, `SCENE_PROMPT_FORMAT`, `SceneTrackerDsl`, `computeSceneSchemaHash`).
- Zod contract — `packages/api-contracts/src/schemas/tracker-schema.ts`.
