# Experience Copilot

> The `experience` agent kind: the AI pair-authoring assistant for interactive experiences ("mini-apps").
> The generic machinery (kind registry, tool loop, SSE stream, shell, profiles, skills plumbing) lives in [Agent Shell](./agent-shell.md); this page covers only what is experience-specific.

---

## What it is

The copilot authors the `rules` and `visual` sources of an experience through reviewable tool proposals.
It is the `experience` agent kind (`services/api/src/domain/agent/kinds/experience-kind.ts`), delegating its species facts to `services/api/src/domain/interactive/copilot/experience-copilot-module.ts` (base prompt file `services/api/assets/experience-copilot/base.md`, the `experience` skill root id, the `copilotToolSetSchema` contract).
The model never touches the database directly: every `rules`/`visual` change is a tool proposal the user reviews as a diff and commits via the binding UI (`write_buffer`/`edit_buffer` are the only channel; raw code in chat is a hard no).
The engine it authors against (kernel, sandbox, durable effects, the `VibeExperience` visual bridge) is documented in `backend.md` (Interactive Experiences); the engine's turn and realtime modes and the mode-choice guidance the copilot follows live in `services/api/assets/experience-copilot/base.md` and the shared assets.
Threads stay script-owned in the copilot thread tables; each turn resolves to its kind through the thread's script row, exactly as described in [Agent Shell](./agent-shell.md).

## System prompt shape

The assembler (`services/api/src/domain/interactive/copilot/experience-copilot-prompt.ts`) builds a single system message from live-loaded assets (re-read from disk each turn, so edits beside the executable are live on the next turn): the base prompt (`services/api/assets/experience-copilot/base.md` — role, tools, key constraints), the rules DSL reference (`services/api/assets/interactive-rules.md`), the visual bridge reference (`services/api/assets/interactive-visual.md`), the human-side user-flow doc (`services/api/assets/experience-copilot/user-flow.md`), the resolved skill catalog, and the runtime context sections (context links, digest, plan, live buffers, test feedback).
Head sections are system-level on purpose: they survive history compaction (compaction only folds the history flow, never the system message).
The `# Plan` section is the script-owned agent plan re-injected into the prompt each turn (omitted byte-identically when empty) — this is what makes the plan survive context compaction, not just page reloads.
Only the active task's body is injected (progressive disclosure; the model reads the rest with `read_plan`).

## Tools

Built per turn by `buildExperienceCopilotTools` (`services/api/src/domain/interactive/copilot/experience-copilot-tools.ts`, pure builder with turn-local closure state) and gated per profile via the `toolSet` (the 9 toggleable keys of `copilotToolSetSchema` in `packages/api-contracts/src/schemas/experience-copilot-schema.ts`; `read_skill_file` is always on — the universal read-only skill channel, never gated):

- `write_buffer` / `edit_buffer` — whole-buffer replace / exact SEARCH-REPLACE edits to `rules` or `visual`.
- `run_test` — read-only create-only check of the working rules (discover, create, project, legal actions).
- `run_simulate` — bounded simulation for termination checking.
- `suggest_visual_binding` — non-binding recommendation; only the user binds.
- `plan` / `read_plan` — the script-owned agent plan (see below).
- `todo` — the session-scoped quick checklist (see below).
- `ask_user` — the clarifying-question tool (see below).
- `read_skill_file` — progressive disclosure for skills (always on).

The proposing tools validate before echoing the proposal triple; a validation failure returns as a tool-error the model can self-correct on in the same turn.
**todo vs plan** (the choice guidance lives in the tool descriptions, not the prompt): `todo` is the quick checklist of small tasks for the CURRENT session; `plan` is the durable plan with a goal for serious multi-step work.

## Ask split-turn (style B — Cline-style resume)

A question turn **ends with the question**: when a step calls `ask_user`, the marker tool-result streams to the client and the loop stops — a normal `finish`, never an error.
The user's answer arrives as a new stream request in **answer mode**: the body carries `answer: { toolCallId, text? | skipped? }` instead of `content` (`experienceCopilotStreamAnswerSchema` enforces exactly-one-of, and a skip carries no text).
Answer mode does **not** append a user row — it rewrites the awaiting tool-result row (`setToolResultOutput`) so the answer becomes the tool-result of its own question, then streams the continuation: one logical turn, resumed.
The frontend renders this as an interactive card with option chips (one may be flagged `recommended`), free text, and a skip.
Self-healing: if the user never answers (they just send a normal message), the dangling ask is rewritten **at assembly time only** to `(the user did not answer this question; they moved on)` — the stored row is never mutated, so a late answer can still land.

## Plan mechanic

The plan is the model's own durable action map, **script-owned** rather than thread-scoped: one `agent_plans` row per script (`packages/db/src/stores/agent-plan-store.ts`, domain shape `packages/domain/src/agent-plan.ts`), shared by every copilot session of that script and by the user-facing editor.
The model drives it through `plan` (whole-structure rewrite) and `read_plan`, built by `createAgentPlanTools` (`services/api/src/domain/agent-plan/agent-plan-tools.ts`); the prompt section renders through `renderAgentPlanSection` (`services/api/src/domain/agent-plan/agent-plan-prompt.ts`).
The user edits through `GET`/`PUT` routes (`services/api/src/api/routes/agent-plan.ts`) and `apps/web/src/components/shared/agent-plan/AgentPlanEditorModal.tsx`, running the same `normalizeAgentPlan` validation as the tool (two `active` tasks are rejected with a typed `422`).
Frontend state lives in `useAgentPlan` (`apps/web/src/hooks/use-agent-plan.ts`, one module-level cache per owner), rendered by `AgentPlanSection` (`apps/web/src/components/shared/agent-shell/AgentPlanSection.tsx`); the frontend locks plan editing while a turn streams, so the model's rewrite and the user's edit can never race.

## Todo mechanic (session-scoped)

Deleting todo as a class was unintended (owner ruling 2026-10-11): todo lives BESIDE the plan as a session-scoped quick checklist.
The principle: **todo = the thread's session (thread-scoped `todo_json`, exactly as before); plan = the script's durable document, surviving sessions**.
The todo is the model's own quick checklist for the thread's small tasks, maintained through its own `todo` tool (`createCopilotTodoTool` in `services/api/src/domain/interactive/copilot/copilot-todo-tool.ts`, full-list-rewrite semantics onto the thread's `todo_json`); the user-facing panel is strictly read-only.
Lifetime is the **thread session**: it survives turns and page reloads (thread wire `todo`, `[]` = empty), and a new session starts an empty checklist; the list is capped at 30 items (`copilotTodoListSchema`).
Frontend state lives in `todoByThread` (the agent turn store, fed by live SSE ingestion and persisted thread-GET hydration) and renders through `AgentTodoPanel` (`apps/web/src/components/shared/agent-shell/AgentTodoPanel.tsx`), pinned below the context meter.

## Skills

Filesystem-scanned `SKILL.md` directories under the built-in root `services/api/assets/experience-copilot/skills/` (resolved through the `experience-copilot/skills` locator in `services/api/src/domain/interactive/copilot/experience-copilot-module.ts`) plus the data-directory `experience-copilot/skills` root; the scanner/catalog machinery (`services/api/src/domain/interactive/copilot/copilot-skill-service.ts`) is reused from Co-Author with an isolated root.
Built-ins:

- `experience-authoring` — the craft-guidance strategy layer (rules-first loop, seat mapping, pitfalls), read on demand.
- `grill-me` — trigger-gated adversarial design review: interrogates the draft through `ask_user` (one question at a time, facts-are-your-job, every question must be able to change the build) and ends with a synthesis plus an offer to lay out a plan.

The catalog is UNGATED (owner ruling 2026-10-12) exactly like Co-Author's: it lists every skill the scan finds — built-in root plus user imports — and exposes every scanned root to `read_skill_file`.
Profiles carry no skill list; a pinned skill's `SKILL.md` body is still injected eagerly on top of the catalog's descriptions.

## Threads, context meter, compaction

Per experience script, the copilot keeps sessions (threads): one active, others archived, auto-numbered titles; message rows are `user` / `assistant` / `tool` (`packages/db/src/stores/experience-copilot-store.ts`).
The thread row also carries `context_metrics_json` (the context meter's budget snapshot), `todo_json`, and `context_links_json` (pinned entities resolved by id at assembly time so a pinned entity can never go stale).
The meter state and the compact flow live in `useCopilotContext` (`apps/web/src/hooks/use-copilot-context.ts`): metrics plus the auto-compact flag fetch from `GET .../context` on mount and thread switch, the `finish` event's metrics feed the meter live, and `compact` POSTs the manual compaction.
Compaction (`ExperienceCopilotCompactionService` in `services/api/src/domain/interactive/copilot/experience-copilot-compaction.ts`) folds the history prefix behind a digest message; the digest boundary never splits tool-call/tool-result pairs.

## Review outcome feedback

Both AI-editing surfaces tell the model, every turn, what the user did with its earlier proposals.
The wire record is `AgentReviewSnapshot` (`packages/api-contracts/src/schemas/agent-review-snapshot.ts`): one record per target with a content-derived `roundId`, an outcome (`awaiting` / `applied` / `applied-partial` / `rejected` / `cancelled` / `superseded`) and separate counts.
The copilot sends it as `reviewSnapshot` plus the per-buffer `rulesSaved` / `visualSaved` flags beside the live `rules` / `visual` buffers; application is recorded after the local buffer accept, independently of Save.
One renderer, `renderReviewOutcomeSection` (`services/api/src/domain/agent/agent-review-outcome-lines.ts`), writes the `## Proposal review outcomes` section for both surfaces, including the reading guidance that the records override the model's memory of its proposals.
The client ledger (`apps/web/src/stores/agent-review-outcome-store.ts`) keeps completed outcomes through round resets, reverts, remounts and session switches, in memory only (a page reload drops it; the live buffers still flow).

## Generic machinery (one line each — details in [Agent Shell](./agent-shell.md))

- Tool loop: the turn runs until the model stops calling tools or the user cancels — no step cap (`COPILOT_TOOL_LOOP_CEILING` in `services/api/src/domain/interactive/copilot/copilot-limits.ts` is the AI SDK's required finite `stopWhen` formality).
- SSE stream: `POST /api/experience-copilot/:threadId/stream` returns `text/event-stream` (`text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `reasoning-done`, `finish`, `abort`, `error`) with a 15s heartbeat and an abort bridge.
- Frontend shape: `ExperienceCopilotShell` (`apps/web/src/components/build/editors/copilot/ExperienceCopilotShell.tsx`) is a thin wrapper mapping editor props onto the generic `AgentShell` (kind `experience`); the host (`apps/web/src/components/build/editors/copilot/experience-agent-host.tsx`) owns the `rules` / `visual` buffers, the `COPILOT_TOOL_KEYS` toggles, the transport, and the preview/code/try editor pane.
- Profiles: per-kind lists under `/api/copilot/profiles` with `?kind=`, validated against the kind's registered tool-set schema.
