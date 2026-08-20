# Experience Copilot

> The AI pair-authoring assistant for interactive experiences ("mini-apps"). Lives in Build → an experience editor's chat tab; helps author the `rules` and `visual` sources of an experience through reviewable tool proposals.

---

## What it is

The copilot is a coding-assistant surface specialized for authoring experience packages. It is **single-mode**: one fixed authoring mode (`experience-authoring`), defined declaratively — there is no module switcher (unlike Co-Author's user-pickable modules). The model never touches the database directly: every `rules`/`visual` change is a tool proposal the user reviews as a diff and commits via the binding UI (`write_buffer`/`edit_buffer` are the only channel; raw code in chat is a hard no).

The engine side it authors against — kernel, sandbox, durable effects (including `timer`), the `VibeExperience` visual bridge — is documented in `backend.md` (Interactive Experiences). This doc covers the assistant subsystem around it.

## Where things live

| Piece | Location |
|---|---|
| Module definition + skill catalog wiring | `services/api/src/domain/interactive/copilot/experience-copilot-module.ts` |
| Prompt assembly | `.../experience-copilot-prompt.ts` |
| Tool builder | `.../experience-copilot-tools.ts` |
| Stream runtime | `.../experience-copilot-stream.ts` |
| Compaction (CM) | `.../experience-copilot-compaction.ts` |
| Context meter metrics | `.../experience-copilot-context.ts` |
| Skill scanner service | `.../copilot-skill-service.ts` |
| Profile resolution | `.../copilot-profile-resolver.ts` |
| Limits | `.../copilot-limits.ts` |
| Prompt assets (live-editable) | `services/api/assets/experience-copilot/` (`base.md`, `user-flow.md`, `skills/`) + shared `assets/interactive-rules.md`, `assets/interactive-visual.md` |
| HTTP routes | `services/api/src/api/routes/experience-copilot.ts` |
| Wire contracts | `packages/api-contracts/src/schemas/experience-copilot-schema.ts` |
| DB stores | `packages/db/src/stores/experience-copilot-store.ts`, `copilot-profile-store.ts` |
| Frontend | `apps/web/src/components/build/editors/copilot/`, `apps/web/src/stores/experience-copilot-turn-store.ts`, `apps/web/src/hooks/use-experience-copilot-controller.ts` |

## System prompt shape

The assembler builds a single system message from live-loaded assets (re-read from disk each turn, so edits beside the executable are live on the next turn): the base prompt (`base.md` — role, tools, key constraints), the rules DSL reference (`interactive-rules.md`), the visual bridge reference (`interactive-visual.md`), the human-side user-flow doc (`user-flow.md`), the resolved skill catalog, and the runtime context sections (context links, digest, **Current step plan**, live buffer snapshots, test feedback). Head sections are system-level on purpose: they survive history compaction (compaction only folds the history flow, never the system message).

The `Current step plan` section is the todo list re-injected into the prompt each turn (omitted byte-identically when empty) — this is what makes the plan survive context compaction, not just page reloads.

## Tools

Built per turn by `buildExperienceCopilotTools` (pure builder, turn-local closure state) and gated per profile via the `toolSet` (7 toggleable keys; `read_skill_file` is always on — the universal read-only skill channel, not gated):

- `write_buffer` / `edit_buffer` — whole-buffer replace / exact SEARCH-REPLACE edits to `rules` or `visual`. First change to a buffer in a turn must be `write_buffer`. Serialized through a non-poisoning queue so an early failure never strands later writes.
- `run_test` — read-only create-only check of the working rules (discover → create → project → legal actions).
- `run_simulate` — bounded simulation for termination checking.
- `suggest_visual_binding` — non-binding recommendation; only the user binds.
- `todo` — the step-plan tool. Full-list rewrite semantics (the array IS the new state — no diffs, no appends; Cline pattern). Persists via an injected `saveTodo` writer (wired to the thread's `todo_json`); the tool returns a compact confirmation envelope. The list is capped at 30 items.
- `ask_user` — the clarifying-question tool (see below). Returns an `awaiting_answer` marker; does no I/O itself.
- `read_skill_file` — progressive disclosure for skills.

Tool proposals for `rules` are validated through the experience sandbox before surfacing — an invalid proposal comes back as a tool-error the model can self-correct on in the same turn.

## The tool loop — unbounded by design

There is **no step cap**: `stopWhen: [isStepCount(COPILOT_TOOL_LOOP_CEILING), hasToolCall("ask_user")]` where the ceiling is a 1,000,000-step formality (the AI SDK requires a finite `stopWhen`). The user decision was pi-parity: the loop runs until the model stops calling tools or the user cancels generation — a step cap is a nanny limit meaningless for a model that plans real development work through a todo list. The two real stops: the model finishes, or it asks.

## Ask split-turn (style B — Cline-style resume)

A question turn **ends with the question**: when a step calls `ask_user`, the marker tool-result streams to the client and `hasToolCall("ask_user")` stops the loop — a normal `finish`, never an error.

The user's answer arrives as a new stream request in **answer mode**: the body carries `answer: { toolCallId, text? | skipped? }` instead of `content` (the schema enforces exactly-one-of, and a skip carries no text). Answer mode does **not** append a user row — it rewrites the awaiting tool-result row (`setToolResultOutput`) so the answer becomes the tool-result of its own question, then streams the continuation: one logical turn, resumed. The frontend renders this as an interactive card with option chips (one may be flagged `recommended`), free text, and a skip.

Self-healing: if the user never answers (they just send a normal message), the dangling ask is rewritten **at assembly time only** to `(the user did not answer this question; they moved on)` — the stored row is never mutated, so a late answer can still land. This conversion is shared with the compaction service, so compaction never freezes a dangling promise.

## Todo system (session-scoped plan)

The todo is the model's own action map, owned and driven only by the model; the user-facing panel is strictly read-only. Lifetime is the **thread session**: it survives turns, page reloads (thread wire `todo`), and compaction (system-level prompt section). Storage is a `todo_json` column on the thread row (defensive parse → `[]`).

Frontend state lives in the turn store (`todoByThread`), fed from two sources kept in structural parity by shared pure parsers: live SSE ingestion (optimistic upsert from the tool-call args, confirmed by the result envelope) and persisted thread-GET hydration. The `CopilotTodoPanel` is pinned directly below the context meter (not scrolling with the feed), hidden until the first `todo` call ever happens; collapsed it shows the current goal + a pulsing live dot + the remaining count, expanded the full list with status glyphs borrowed from the RP objective tracker.

## Skills

Filesystem-scanned `SKILL.md` directories under `services/api/assets/experience-copilot/skills/` (the scanner/catalog machinery is reused wholesale from Co-Author, with an isolated root). Built-ins:

- `experience-authoring` — the craft-guidance strategy layer (rules-first loop, seat mapping, pitfalls), read on demand.
- `grill-me` — trigger-gated adversarial design review: interrogates the draft through `ask_user` (one question at a time, facts-are-your-job, every question must be able to change the build) and ends with a synthesis + an offer to lay out a `todo` plan.

Profiles pick skills via `skillIds`; a pinned skill's `SKILL.md` body is injected eagerly (CX-1) on top of the catalog's descriptions.

## Profiles

`copilot_profiles` rows plus one code-defined read-only **builtin** seed (id `"builtin"`, resolved from the module def — update/delete reject it). A profile carries the provider/model pair, the `toolSet` toggles (raw-key chips in the modal — no labels to translate), and `skillIds`. There is deliberately **no `maxSteps`**: the loop bound is the shared ceiling constant, not profile data (staged removal TAG-4 → TAG-4b → TAG-10).

## Threads, messages, and the context meter

Per experience script, the copilot keeps sessions (threads): one active, others archived; auto-numbered titles. Message rows are `user` / `assistant` / `tool` (activities keyed by toolCallId). The thread row also carries `context_metrics_json` (the context meter's budget snapshot driving the meter UI) and `context_links_json` (pinned entities rendered as read-only reference blocks, resolved by id at assembly time so a pinned entity can never go stale).

Compaction (CM): a digest message summarizes the folded prefix; the digest anchors the surviving history so prompt-cache-friendly prefixes stay stable. The digest boundary never splits tool-call/tool-result pairs.

## SSE stream

`POST /api/experience-copilot/:threadId/stream` returns `text/event-stream`. Events: `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `reasoning-done`, `finish`, `abort`, `error`. The route wraps the stream with an abort bridge (client disconnect → domain abort → partial-state persistence) and a 15s SSE-comment heartbeat so a long-thinking model never trips Bun.serve's idle timeout.

## Frontend shape

`ExperienceCopilotShell` (editor chrome + tabs after the UX redesign) hosts, top-to-bottom in the chat tab: the session switcher header, the context meter, the todo panel (pinned), the scrolling message feed. The turn store holds per-thread activity maps + panel state; the controller (`use-experience-copilot-controller`) drives sends and answers through one shared SSE-callback builder, so live routing stays field-for-field with persisted extraction by construction. `CopilotAskCard` renders in the feed wherever an `ask_user` activity sits — interactive on the trailing awaiting ask, read-only (answered/skipped/expired) in history. The live===persisted parity test is the boundary guard for the whole extraction layer.

## Testing notes

The prompt tests pin the zero-feature system message by SHA-256 (byte-identical assembly when optional sections are absent). Legitimate asset changes re-capture the hash with a dated comment trail — the pins exist to catch accidental prompt drift, not to freeze assets. The turn-store parity test drives one fixture through both ingestion paths and asserts identical store state.
