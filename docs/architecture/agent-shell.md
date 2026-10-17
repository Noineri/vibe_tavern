# Agent Shell

> One chat/review/skills/profiles machine for every authoring agent, with two consumers today: the mini-app assistant and the script assistant. The backend holds one registry of agent kinds; the web app holds one registry of their editor hosts. A new kind plus its host plugs in from this page alone.

---

## What it is

An agent kind is a whole agent species (its base prompt, its tools, its skills, its context package), not a per-user profile.
Two kinds exist today: `experience` (the mini-app copilot) and `script` (prompt and dice scripts).
The generic core (stream loop, tool loop, history windowing, compaction digest, `ask_user`, plan section, skills, context links, metrics) serves any kind without kind-switches.
The generic web shell (`apps/web/src/components/shared/agent-shell/AgentShell.tsx`) renders any kind's chat, review, profile and skill UI from its host descriptor.
Why one machine: the mini-app editor, the script editor and the future sidechat modes all need the same turn/review/session machinery, so it is written once and kinds only supply their species-level facts.

## Backend — the kind registry

The descriptor contract lives in `services/api/src/domain/agent/agent-kind.ts`.
A descriptor carries only species-level facts: the stable `id`, the `servesScriptKinds` list, the `basePromptServiceKey`, the `skillRootId` label, the `toolSetSchema` plus `defaultToolSet`, the `recencyAnchorText`, and the `renderContextPackage` renderer for the kind-owned per-turn context package.
The table lives in `services/api/src/domain/agent/agent-kind-registry.ts`: `registerAgentKind` returns an unsubscribe, `getAgentKind` and the typed `getAgentKindOf` look one kind up, and `resolveKindForScript` returns the first registered kind whose `servesScriptKinds` contains the script kind.
Three typed errors carry machine-readable codes: `UnknownAgentKindError` (`UNKNOWN_AGENT_KIND`), `NoAgentKindForScriptKindError` (`NO_AGENT_KIND_FOR_SCRIPT_KIND`), and `AgentKindNotWiredError` (`AGENT_KIND_NOT_WIRED`, naming the missing `stream` or `compaction` table).
The generic core beside the registry is `services/api/src/domain/agent/agent-prompt.ts`, `services/api/src/domain/agent/agent-stream.ts`, `services/api/src/domain/agent/agent-compaction.ts`, `services/api/src/domain/agent/agent-context.ts`, `services/api/src/domain/agent/agent-buffer-tools.ts`, and `services/api/src/domain/agent/agent-review-outcome-lines.ts`.
The `experience` kind is defined in `services/api/src/domain/agent/kinds/experience-kind.ts`, delegating species facts to `services/api/src/domain/interactive/copilot/experience-copilot-module.ts` and owning the `ExperienceAgentContext` shape.
The `script` kind is defined in `services/api/src/domain/agent/kinds/script-kind.ts`, delegating to `services/api/src/domain/agent/script-agent/script-agent-module.ts` and owning the `ScriptAgentContext` shape plus `SCRIPT_AGENT_RECENCY_ANCHOR_TEXT`.
The script kind's species machinery is the `services/api/src/domain/agent/script-agent/` family: `services/api/src/domain/agent/script-agent/script-agent-module.ts` (descriptor source, skill roots, profile seed), `services/api/src/domain/agent/script-agent/script-agent-prompt.ts` (system message plus the API-knowledge section), `services/api/src/domain/agent/script-agent/script-agent-stream.ts` (the turn entry the adapter calls), `services/api/src/domain/agent/script-agent/script-agent-tools.ts` (`write_buffer` / `edit_buffer` over the single `code` buffer, `run_script_test`, `plan` / `read_plan`, `ask_user`, `read_skill_file`), and `services/api/src/domain/agent/script-agent/script-agent-compaction.ts` (`ScriptAgentCompactionService`).
Kind modules self-register at module init and are reached through side-effect imports from their own prompt modules, so no route ever imports a kind map.
A thread resolves to its kind per request, never from a stored kind column: threads stay script-owned in the copilot thread tables.
The adapter resolves it in `services/api/src/api/adapters/experience-copilot-adapter.ts` via `resolveThreadKind` (thread row → script row → `resolveKindForScript`), with draft threads (`scriptId === null`) and dangling script links resolving to the draft kind `experience`.
Stream dispatch goes through the adapter's `streamKinds` table (`getKindStream` throws `AgentKindNotWiredError` with table `"stream"` when the resolved kind has no entry), and manual compaction through the `compactionKinds` table (missing entry throws `AgentKindNotWiredError` with table `"compaction"`).
The routes in `services/api/src/api/routes/experience-copilot.ts` map all three registry errors to the same HTTP 400 JSON shape (`{ error, code }`) on both the stream assert step and the compact route, so a wiring bug surfaces as a client-readable 400 with its own code rather than a 500.

## Per-kind resources

Profiles live behind `services/api/src/api/routes/copilot-profile.ts`, where `?kind=` selects the kind (default `experience`) and an unknown kind is a 400 carrying `UNKNOWN_AGENT_KIND`.
Each kind has its own builtin seed (id `"builtin"`, read-only) plus its own tool-set contract, and the resolver in `services/api/src/domain/interactive/copilot/copilot-profile-resolver.ts` projects stored rows through the requesting kind's keys.
Skill libraries live behind `services/api/src/api/routes/copilot-skill.ts`, where `?kind=` selects the kind (default `experience`) for every catalog read and mutation.
The per-kind skill adapter table is `services/api/src/api/adapters/copilot-skill-adapter.ts`, which resolves the kind through the agent-kind registry first and refuses a registry-known but unwired kind instead of falling back to another kind's roots.
The script kind's library service is the optional `scriptSkillService` in `services/api/src/api/adapters/runtime-api-adapter.ts`, so lifecycle-only harnesses keep working while production wires the script roots.
The experience roots are the built-in `services/api/assets/experience-copilot/skills` plus the data-directory experience-copilot skills root; the script roots are the built-in `services/api/assets/agent-script/skills` plus the data-directory agent-script skills root.
Compaction is per kind: `services/api/src/domain/interactive/copilot/experience-copilot-compaction.ts` (`ExperienceCopilotCompactionService`) for experience, `services/api/src/domain/agent/script-agent/script-agent-compaction.ts` (`ScriptAgentCompactionService`) for script.
The base prompt key per kind is a service-prompt key: `copilot_base` (`services/api/assets/experience-copilot/base.md`) for experience and `script_agent_base` (`services/api/assets/agent-script/base.md`) for script, each overridable through the global service-prompt profile.
The script kind's API-knowledge section reads the resolved `script` or `dice_script` service prompt matching the turn's script runtime — never both, never swapped — so a user who customized those keys loses nothing.

## The proposal union

The shared shapes live in `packages/api-contracts/src/agent-proposal.ts`.
A buffer proposal carries `hasProposal`, the last `proposedRules` / `proposedVisual` texts, and per-tool `summaries` in call order; it carries no `kind` field, since the field set alone identifies it.
A record proposal carries `kind: "record"` plus `id`, `recordType`, `op` (`create` / `update` / `delete`), an optional `targetId`, an opaque `payload: unknown`, and a `status` (`pending` / `applied` / `rejected`).
`AgentProposal` is the union of the two, and `isRecordProposal` narrows it structurally on the `"record"` literal.
Hosts review buffer proposals hunk by hunk in the editor pane and record proposals as cards; the shell ships `apps/web/src/components/shared/agent-shell/RecordProposalFallbackCard.tsx` for record types with no dedicated renderer yet.

## Frontend — the host registry and the shell

The host registry is `apps/web/src/lib/agent-host-registry.ts`, the frontend counterpart of the backend kind registry.
A host descriptor carries the stable `kind`, the i18n key table (`title`, optional `subtitle`, `placeholder`, `loading`, `emptyTitle`, optional `emptySub`, optional `mobileBackLabelKey`), the profile-modal `toolKeys`, the `bufferSpecs`, the `transport` seam, the optional `renderEditorPane` (absent means a chat-only host), `buildSendOptions`, the optional `toolbarSlot` and `mobileEditTabHeader`, and the `recordProposalRenderers` map.
`registerAgentHost` returns an unsubscribe and `getAgentHost` throws `UnknownAgentHostError` for an unregistered kind; host modules self-register at module init and their editors import them for that side effect.
`AgentKind` is a plain string, and `agentThreadKey(kind, threadId)` is the single per-thread store-key derivation: bare `threadId` for `experience` (so pre-existing localStorage drafts keep working) and `${kind}:${threadId}` for later kinds, while server-side keys stay bare.
`AgentSendOptions` (owned by the registry) carries the live buffers and step: `rules` / `visual` / `code`, `scriptKind`, `codeSaved` / `rulesSaved` / `visualSaved`, `step`, `testFeedback`, `launchContext`, and `reviewSnapshot`.
`AgentHostContext` hands the host its `ownerId`, `scriptId`, live `threadId`, `isSending` flag, opaque `hostProps`, and the mutable `bridge`; the editor pane assigns `bridge.session` (`onBeforeSend` plus `buildSendOptions`) every render and host surfaces prefill the chat input through `bridge.setInputPrefill`.
The transport seam (`sendStream`, `answerAsk`, `getActiveThread`, `listMessages`, `startSession`, `listSessions`, `activateSession`, `renameSession`, `setContextLinks`) mirrors the experience client, so the generic shell and controller never import a kind-specific client.
The shell is `apps/web/src/components/shared/agent-shell/`: `apps/web/src/components/shared/agent-shell/AgentShell.tsx` (desktop 2-pane and mobile `[Chat][Edit]` tabs, both panes mounted), `apps/web/src/components/shared/agent-shell/use-agent-controller.ts` (send/answer/cancel through the host's transport, keyed by kind), the chat pieces (`AgentChatHeader`, `AgentMessageList`, `AgentMessageBlock`, `AgentInputArea`, `AgentMobileInputArea`, `AgentAskCard`, `AgentActivityCard`, `AgentToolAccordion`, `AgentContextPills`, `AgentContextMeter`, `AgentSessionSwitcher`, `AgentPlanSection`, `AgentTodoSection`, `use-agent-mention`), `apps/web/src/components/shared/agent-shell/AgentBufferReviewEditor.tsx` (hunk review over the host's buffers), `apps/web/src/components/shared/agent-shell/AgentProfileModal.tsx` (kind-filtered list, toggles read from the host descriptor's `toolKeys`), and `apps/web/src/components/shared/agent-shell/AgentSkillModal.tsx` (one kind's library at a time).
Client state is keyed by kind: `apps/web/src/stores/agent-turn-store.ts` and `apps/web/src/stores/agent-review-store.ts` take `kind` first and key their maps through `agentThreadKey`.
The two hosts are `apps/web/src/components/build/editors/copilot/experience-agent-host.tsx` (buffers `rules` / `visual`, tool keys `COPILOT_TOOL_KEYS`, empty subtitle `agent_subtitle`, preview/code/try editor pane) and `apps/web/src/components/build/editors/script-agent-host.tsx` (single `code` buffer with hunk review, tool keys `SCRIPT_AGENT_TOOL_KEYS`, empty subtitle `agent_script_subtitle`, the script editing surface as its editor pane).

## Adding a kind + host — the checklist

1. Add the backend descriptor in `services/api/src/domain/agent/kinds/` (one per-kind file beside the two kinds there): `id`, the `servesScriptKinds` it owns, `basePromptServiceKey`, `skillRootId`, the tool-set schema plus default set, `recencyAnchorText`, and the kind-owned `renderContextPackage` input shape.
2. Self-register the kind at module init and reach it through a side-effect import from its prompt module, mirroring the kind side-effect import in `services/api/src/domain/agent/script-agent/script-agent-prompt.ts`.
3. Add the adapter entries in `services/api/src/api/adapters/experience-copilot-adapter.ts`: one `streamKinds` entry and one `compactionKinds` entry; a registered kind missing either throws `AgentKindNotWiredError` (HTTP 400 with code `AGENT_KIND_NOT_WIRED`) instead of streaming.
4. Add the skill roots (built-in asset directory plus data-directory root, mirroring `services/api/assets/agent-script/skills`) and wire the library service beside `scriptSkillService` in `services/api/src/api/adapters/runtime-api-adapter.ts` plus the per-kind table in `services/api/src/api/adapters/copilot-skill-adapter.ts`.
5. Add the profile seed (builtin `script`-style seed) and extend the per-kind projection in `services/api/src/domain/interactive/copilot/copilot-profile-resolver.ts`, so `?kind=` lists and validates only the new kind's tool keys.
6. Add the service-prompt base key in `services/api/src/domain/service-prompts/service-prompt-registry.ts` with its asset base file beside the other kind bases, and point the kind's `basePromptServiceKey` at it; if the kind needs API knowledge, read the matching existing service-prompt keys rather than copying their text.
7. Add the host descriptor in a new per-kind host module beside the two hosts: `kind`, the i18n keys, `toolKeys` (the wire-contract key list), `bufferSpecs`, the `transport` delegation, and `recordProposalRenderers` (empty until the first record renderer arrives).
8. Add the editor pane behind `renderEditorPane` (or omit it for a chat-only host), assigning `bridge.session` with `onBeforeSend` and `buildSendOptions`; the script host's pane pattern is the reference for a single-buffer editor.
9. Add the i18n keys in `apps/web/src/i18n/locales/en.json` and `apps/web/src/i18n/locales/ru.json`, then run `bun run i18n:types`; the shell resolves descriptor keys only, so a typo is a compile error.

## Testing notes

`services/api/test/agent-kind-registry.test.ts` pins registration, lookup, `resolveKindForScript`, and the typed errors.
`services/api/test/experience-copilot-kind-resolution.test.ts` pins thread-to-kind resolution, the per-kind stream and compaction dispatch, and the unwired-kind 400s on both routes.
`services/api/test/copilot-skill-routes.test.ts` pins the per-kind skill libraries and their isolation.
`services/api/test/script-agent-prompt.test.ts`, `services/api/test/script-agent-tools.test.ts`, `services/api/test/script-agent-stream.test.ts`, and `services/api/test/script-agent-compaction.test.ts` pin the script kind's assembly, tools (including the fail-closed trust refusal), streaming, and compaction.
`apps/web/src/lib/agent-host-registry.test.ts` pins host registration and `agentThreadKey`.
`apps/web/src/components/build/editors/script-agent-host.test.tsx` pins the script host's hunk review, dice `scriptKind`, mobile tabs, and trust-refusal card.

History: built under AGENT_SHELL_PLAN (row AS-10i); the mini-app experience page is `docs/architecture/experience-copilot.md`.
